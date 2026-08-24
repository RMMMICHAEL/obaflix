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
 *  - compara com o valor atual e só grava se realmente mudou;
 *  - marca como verificado mesmo quando nenhuma troca é necessária.
 *
 * Custo: roda local, contra o banco. Zero na Vercel. No Supabase, apenas as
 * escritas dos registros que mudaram, mais uma escrita de marcação por item.
 * A concorrência é baixa de propósito — o pool do Supabase é de 15 conexões em
 * session mode, e um build ou dev server concorrente já o esgota.
 *
 * Uso:
 *   npx tsx scripts/backfill-arte.ts --limite 100     — lote pequeno
 *   npx tsx scripts/backfill-arte.ts                  — tudo que falta
 *   npx tsx scripts/backfill-arte.ts --tipo filmes
 */
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

interface Metricas {
  consultados: number;
  backgroundMudou: number;
  jaCorreto: number;
  semBackdrop: number;
  escritas: number;
  erros: number;
  picoConcorrencia: number;
}

const zerar = (): Metricas => ({
  consultados: 0, backgroundMudou: 0, jaCorreto: 0,
  semBackdrop: 0, escritas: 0, erros: 0, picoConcorrencia: 0,
});

let emVoo = 0;

async function processar(
  rotulo: string,
  m: Metricas,
  buscar: (n: number) => Promise<{ id: string; tmdbId: string | null; background: string | null; logo: string | null }[]>,
  imagens: (tmdbId: string) => Promise<any>,
  gravar: (id: string, data: Record<string, unknown>) => Promise<unknown>,
) {
  let restante = LIMITE;

  while (restante > 0) {
    const pagina = await buscar(Math.min(LOTE_LEITURA, restante));
    if (!pagina.length) break;

    for (let i = 0; i < pagina.length; i += CONCORRENCIA) {
      const lote = pagina.slice(i, i + CONCORRENCIA);
      await Promise.all(
        lote.map(async (row) => {
          emVoo++;
          if (emVoo > m.picoConcorrencia) m.picoConcorrencia = emVoo;
          try {
            const imgs = await imagens(row.tmdbId!);
            m.consultados++;

            const bg = pickBackdrop(imgs);
            const logo = pickLogo(imgs);

            const data: Record<string, unknown> = { artCheckedAt: new Date() };
            if (!bg) {
              m.semBackdrop++;
            } else if (bg !== row.background) {
              data.background = bg;
              m.backgroundMudou++;
            } else {
              m.jaCorreto++;
            }
            // O logo não vai mais para o card, mas alimenta o hero da página de
            // detalhe. Como a consulta ao TMDB já foi feita, gravar sai de graça.
            if (logo && logo !== row.logo) data.logo = logo;

            // Sempre grava: mesmo sem troca de arte, a marcação é o que impede
            // este título de ser reconsultado na próxima execução.
            await gravar(row.id, data);
            m.escritas++;
          } catch {
            m.erros++;
          } finally {
            emVoo--;
          }
        }),
      );
      process.stdout.write(
        `\r${rotulo}: ${m.consultados} consultados · ${m.backgroundMudou} trocados · ` +
        `${m.jaCorreto} já corretos · ${m.semBackdrop} sem backdrop · ${m.erros} erros`,
      );
    }

    restante -= pagina.length;
    if (pagina.length < LOTE_LEITURA) break;
  }
  process.stdout.write("\n");
}

async function main() {
  const t0 = Date.now();
  const mf = zerar();
  const ms = zerar();

  if (TIPO === "all" || TIPO === "filmes") {
    await processar(
      "filmes", mf,
      (n) => prisma.filme.findMany({
        where: { tmdbId: { not: null }, artCheckedAt: null },
        orderBy: { popularidade: { sort: "desc", nulls: "last" } },
        take: n,
        select: { id: true, tmdbId: true, background: true, logo: true },
      }),
      (tmdbId) => getMovieImages(tmdbId),
      (id, data) => prisma.filme.update({ where: { id }, data }),
    );
  }

  if (TIPO === "all" || TIPO === "series") {
    await processar(
      "séries", ms,
      (n) => prisma.serie.findMany({
        where: { tmdbId: { not: null }, artCheckedAt: null },
        orderBy: { popularidade: { sort: "desc", nulls: "last" } },
        take: n,
        select: { id: true, tmdbId: true, background: true, logo: true },
      }),
      (tmdbId) => getTVImages(tmdbId),
      (id, data) => prisma.serie.update({ where: { id }, data }),
    );
  }

  const seg = (Date.now() - t0) / 1000;
  const soma = (k: keyof Metricas) => (mf[k] as number) + (ms[k] as number);

  console.log("\n─── resultado ───────────────────────────────");
  console.log(`consultados ao TMDB : ${soma("consultados")}`);
  console.log(`backgrounds trocados: ${soma("backgroundMudou")}`);
  console.log(`já estavam corretos : ${soma("jaCorreto")}`);
  console.log(`sem backdrop no TMDB: ${soma("semBackdrop")}`);
  console.log(`escritas no Supabase: ${soma("escritas")}`);
  console.log(`erros               : ${soma("erros")}`);
  console.log(`tempo total         : ${seg.toFixed(1)}s`);
  console.log(`pico de concorrência: ${Math.max(mf.picoConcorrencia, ms.picoConcorrencia)}`);

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error("\nfalhou:", e);
  await prisma.$disconnect();
  process.exit(1);
});
