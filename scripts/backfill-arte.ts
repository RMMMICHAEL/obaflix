/**
 * Backfill progressivo da arte do catálogo (backdrop e logo) a partir do TMDB.
 *
 * Substitui scripts/backfill-logos.ts, que filtrava por `logo: null`. Aquele
 * filtro fazia o backfill parar de revisitar títulos que já tinham logo, mesmo
 * quando o `background` estava errado — e "errado" era a regra, porque a
 * prioridade antiga do pickBackdrop preferia arte com o título já desenhado.
 *
 * Aqui a marcação é explícita: `artCheckedAt` registra quando aquele título foi
 * analisado, independentemente de ter havido troca. Assim cada execução avança
 * e nada é reconsultado à toa.
 *
 * Regras:
 *  - busca só itens com artCheckedAt = null, na ordem de popularidade;
 *  - consulta o TMDB uma vez por título (o endpoint images traz tudo);
 *  - pickBackdrop prioriza iso_639_1 = null (arte sem texto), usando pt/en
 *    apenas como fallback;
 *  - compara com o valor atual e só grava o campo que realmente mudou;
 *  - marca como verificado mesmo quando nenhuma troca é necessária.
 *
 * Custo: roda local, contra o banco. Zero na Vercel. No Supabase, as escritas
 * são agrupadas: um UPDATE por lote cobre dezenas de títulos, tenham eles
 * mudado ou não (ver `gravarLote`). A concorrência é baixa de propósito — o
 * pool do Supabase é de 15 conexões em session mode, e um build ou dev server
 * concorrente já o esgota.
 *
 * Interromper no meio é seguro: quem não recebeu `artCheckedAt` simplesmente
 * volta na próxima execução. É por isso que a trava de segurança abaixo pode
 * parar sem cerimônia em vez de insistir contra um banco saturado.
 *
 * Uso:
 *   npx tsx scripts/backfill-arte.ts --limite 100     — lote pequeno
 *   npx tsx scripts/backfill-arte.ts                  — tudo que falta
 *   npx tsx scripts/backfill-arte.ts --tipo filmes
 */
import { Prisma } from "@prisma/client";
import { prisma } from "../src/lib/prisma";
import { getMovieImages, getTVImages, pickLogo, pickBackdrop } from "../src/lib/tmdb";

const args = process.argv.slice(2);
const opcao = (nome: string) => {
  const i = args.indexOf(`--${nome}`);
  return i >= 0 ? args[i + 1] : null;
};

const LIMITE = Number(opcao("limite") ?? 0) || Infinity;
const TIPO = opcao("tipo") ?? "all";

/**
 * Concorrência e tamanho de lote deliberadamente baixos.
 * O gargalo aqui não é o TMDB (que aceita ~50 req/s) e sim o pool do Supabase:
 * cada escrita ocupa uma conexão, e são 15 no total, compartilhadas com
 * qualquer build ou dev server aberto.
 */
const CONCORRENCIA = 4;
const LOTE_LEITURA = 50;

/**
 * Trava de segurança: acima desta fração de erros num lote, para em vez de
 * insistir. Um pico de erro aqui costuma ser rede ou TMDB rejeitando, e
 * continuar martelando só transformaria um problema passageiro em milhares de
 * títulos marcados como verificados sem terem sido.
 */
const LIMIAR_ERRO = 0.25;

/** Uma linha pendente de gravação. `null` num campo significa "não mexer". */
interface Pendente {
  id: string;
  background: string | null;
  logo: string | null;
}

interface Metricas {
  consultados: number;
  backgroundMudou: number;
  jaCorreto: number;
  semBackdrop: number;
  itensGravados: number;
  queriesEscrita: number;
  erros: number;
  picoConcorrencia: number;
}

const zerar = (): Metricas => ({
  consultados: 0, backgroundMudou: 0, jaCorreto: 0, semBackdrop: 0,
  itensGravados: 0, queriesEscrita: 0, erros: 0, picoConcorrencia: 0,
});

let emVoo = 0;

/** Estado global de progresso, para o log de lote e a estimativa restante. */
const inicio = Date.now();
let totalPrevisto = 0;
let processadosGlobal = 0;
let abortado: string | null = null;

const hms = (seg: number) => {
  const s = Math.max(0, Math.round(seg));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}h${String(m).padStart(2, "0")}m` : `${m}m${String(s % 60).padStart(2, "0")}s`;
};

/**
 * Grava um lote inteiro numa única query.
 *
 * A versão anterior fazia um `update` por título — inclusive para os que não
 * precisavam de troca nenhuma e só recebiam o carimbo de `artCheckedAt`. No
 * catálogo completo isso seriam ~37 mil escritas.
 *
 * `updateMany` sozinho não resolve o caso todo: ele aplica o mesmo valor a
 * todas as linhas, e `background`/`logo` são diferentes em cada uma. Então as
 * linhas viajam como um VALUES e o UPDATE casa por id — mesma ideia do
 * updateMany para a marcação, estendida aos campos que variam por linha.
 *
 * COALESCE é o que torna isso seguro: `null` no lote significa "mantém o que
 * está lá", nunca "apaga". Um título sem logo no TMDB não perde o logo atual.
 *
 * `updatedAt` é gerenciado pelo Prisma (@updatedAt) e não é aplicado em SQL
 * cru, então é atualizado à mão — e só quando algum campo mudou de fato, para
 * a marcação não parecer uma alteração de conteúdo.
 */
async function gravarLote(tabela: Prisma.Sql, linhas: Pendente[], m: Metricas) {
  if (!linhas.length) return;

  const valores = linhas.map(
    (l) => Prisma.sql`(${l.id}::text, ${l.background}::text, ${l.logo}::text)`,
  );

  await prisma.$executeRaw`
    UPDATE ${tabela} AS t
       SET background      = COALESCE(v.background, t.background),
           logo            = COALESCE(v.logo, t.logo),
           "artCheckedAt"  = ${new Date()}::timestamptz,
           "updatedAt"     = CASE
                               WHEN v.background IS NOT NULL OR v.logo IS NOT NULL
                               THEN now() ELSE t."updatedAt"
                             END
      FROM (VALUES ${Prisma.join(valores)}) AS v(id, background, logo)
     WHERE t.id = v.id
  `;

  m.queriesEscrita++;
  m.itensGravados += linhas.length;
}

async function processar(
  rotulo: string,
  m: Metricas,
  tabela: Prisma.Sql,
  buscar: (n: number) => Promise<{ id: string; tmdbId: string | null; background: string | null; logo: string | null }[]>,
  imagens: (tmdbId: string) => Promise<any>,
) {
  let restante = LIMITE;
  let lote = 0;

  while (restante > 0 && !abortado) {
    const pagina = await buscar(Math.min(LOTE_LEITURA, restante));
    if (!pagina.length) break;

    const pendentes: Pendente[] = [];
    const errosAntes = m.erros;
    lote++;

    for (let i = 0; i < pagina.length; i += CONCORRENCIA) {
      const fatia = pagina.slice(i, i + CONCORRENCIA);
      await Promise.all(
        fatia.map(async (row) => {
          emVoo++;
          if (emVoo > m.picoConcorrencia) m.picoConcorrencia = emVoo;
          try {
            const imgs = await imagens(row.tmdbId!);
            m.consultados++;

            const bg = pickBackdrop(imgs);
            const logo = pickLogo(imgs);

            const pend: Pendente = { id: row.id, background: null, logo: null };
            if (!bg) {
              m.semBackdrop++;
            } else if (bg !== row.background) {
              pend.background = bg;
              m.backgroundMudou++;
            } else {
              m.jaCorreto++;
            }
            // O logo não vai mais para o card, mas alimenta o hero da página de
            // detalhe. Como a consulta ao TMDB já foi feita e a escrita viaja
            // junto com o lote, gravar sai de graça.
            if (logo && logo !== row.logo) pend.logo = logo;

            // Entra na fila mesmo sem troca: a marcação é o que impede este
            // título de ser reconsultado na próxima execução.
            pendentes.push(pend);
          } catch {
            m.erros++;
          } finally {
            emVoo--;
          }
        }),
      );
    }

    // Descarrega antes da próxima leitura: enquanto o artCheckedAt não estiver
    // no banco, o findMany seguinte devolveria estes mesmos títulos.
    try {
      await gravarLote(tabela, pendentes, m);
    } catch (e) {
      // Falha de escrita é o sintoma direto de pool esgotado. Para aqui: o que
      // não foi marcado volta na próxima execução, nada se perde.
      abortado = `falha ao gravar o lote ${lote} de ${rotulo}: ${(e as Error).message.split("\n")[0]}`;
      break;
    }

    processadosGlobal += pagina.length;
    const decorrido = (Date.now() - inicio) / 1000;
    const ritmo = processadosGlobal / decorrido;
    const faltam = Math.max(0, totalPrevisto - processadosGlobal);

    console.log(
      `[${rotulo} lote ${String(lote).padStart(3)}] ` +
      `processados ${processadosGlobal}/${totalPrevisto} · ` +
      `alterados ${m.backgroundMudou} · corretos ${m.jaCorreto} · ` +
      `sem backdrop ${m.semBackdrop} · erros ${m.erros} · ` +
      `escritas ${m.queriesEscrita} · ` +
      `decorrido ${hms(decorrido)} · restam ~${hms(faltam / (ritmo || 1))}`,
    );

    const errosNoLote = m.erros - errosAntes;
    if (errosNoLote / pagina.length > LIMIAR_ERRO) {
      abortado = `${errosNoLote} erros em ${pagina.length} itens no lote ${lote} de ${rotulo} (acima de ${LIMIAR_ERRO * 100}%)`;
      break;
    }

    restante -= pagina.length;
    if (pagina.length < LOTE_LEITURA) break;
  }
}

async function main() {
  const mf = zerar();
  const ms = zerar();

  const selecao = { id: true, tmdbId: true, background: true, logo: true } as const;
  const filtro = { tmdbId: { not: null }, artCheckedAt: null } as const;
  const ordem = { popularidade: { sort: "desc", nulls: "last" } } as const;

  const faltamFilmes = TIPO === "series" ? 0 : await prisma.filme.count({ where: filtro });
  const faltamSeries = TIPO === "filmes" ? 0 : await prisma.serie.count({ where: filtro });
  totalPrevisto = Math.min(
    faltamFilmes + faltamSeries,
    LIMITE === Infinity ? Infinity : LIMITE * (TIPO === "all" ? 2 : 1),
  );
  console.log(`a verificar: ${faltamFilmes} filmes · ${faltamSeries} séries · alvo desta execução: ${totalPrevisto}\n`);

  if (TIPO === "all" || TIPO === "filmes") {
    await processar(
      "filmes", mf,
      // Identificador fixo no código, não entrada de usuário.
      Prisma.raw('"Filme"'),
      (n) => prisma.filme.findMany({ where: filtro, orderBy: ordem, take: n, select: selecao }),
      (tmdbId) => getMovieImages(tmdbId),
    );
  }

  if ((TIPO === "all" || TIPO === "series") && !abortado) {
    await processar(
      "séries", ms,
      Prisma.raw('"Serie"'),
      (n) => prisma.serie.findMany({ where: filtro, orderBy: ordem, take: n, select: selecao }),
      (tmdbId) => getTVImages(tmdbId),
    );
  }

  const seg = (Date.now() - inicio) / 1000;
  const soma = (k: keyof Metricas) => (mf[k] as number) + (ms[k] as number);

  console.log("\n─── resultado ───────────────────────────────");
  console.log(`filmes processados  : ${mf.consultados}`);
  console.log(`séries processadas  : ${ms.consultados}`);
  console.log(`backgrounds trocados: ${soma("backgroundMudou")}`);
  console.log(`já estavam corretos : ${soma("jaCorreto")}`);
  console.log(`sem backdrop no TMDB: ${soma("semBackdrop")}`);
  console.log(`itens gravados      : ${soma("itensGravados")}`);
  console.log(`queries de escrita  : ${soma("queriesEscrita")}`);
  console.log(`erros               : ${soma("erros")}`);
  console.log(`tempo total         : ${hms(seg)}`);
  console.log(`pico de concorrência: ${Math.max(mf.picoConcorrencia, ms.picoConcorrencia)}`);
  if (abortado) console.log(`\nPAUSADO: ${abortado}\nRodar de novo retoma de onde parou.`);

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error("\nfalhou:", e);
  await prisma.$disconnect();
  process.exit(1);
});
