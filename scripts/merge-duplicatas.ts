/**
 * Merge canonico de duplicatas do catalogo.
 *
 * Substitui o antigo cleanup-dupes.ts, que agrupava por titulo em minusculas e
 * APAGAVA o perdedor — levando junto episodios, historico e watchlist, porque o
 * DELETE do admin cascateia. Aqui nada e apagado antes de ser migrado, e o
 * criterio de identidade e tmdbId + tipo de midia, nao o nome.
 *
 * Uso:
 *   npx tsx scripts/merge-duplicatas.ts                 # dry-run (padrao)
 *   npx tsx scripts/merge-duplicatas.ts --tipo series   # so um lado
 *   npx tsx scripts/merge-duplicatas.ts --limite 20     # so os N primeiros grupos
 *   npx tsx scripts/merge-duplicatas.ts --apply         # escreve no banco
 *
 * O dry-run e o PADRAO, e nao ha atalho: sem `--apply` explicito nenhuma
 * escrita acontece. O relatorio do dry-run mostra, grupo a grupo, quem vence,
 * quem morre e exatamente quantas linhas de cada tabela seriam migradas.
 */

import { prisma } from "../src/lib/prisma";
import {
  agruparDuplicatas,
  type GrupoCanonico,
  type RegistroCatalogo,
} from "../src/lib/canonical";

const APPLY = process.argv.includes("--apply");
const TIPO_ARG = valorDe("--tipo");
const LIMITE = Number(valorDe("--limite") ?? 0) || 0;

function valorDe(flag: string): string | null {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : null;
}

/** Somatorio do que uma execucao migrou (ou migraria). */
interface Contagem {
  grupos: number;
  perdedores: number;
  episodiosMovidos: number;
  episodiosFundidos: number;
  generos: number;
  historico: number;
  historicoDescartado: number;
  watchlist: number;
  watchlistDescartada: number;
  likes: number;
  likesDescartados: number;
}

const zerado = (): Contagem => ({
  grupos: 0, perdedores: 0, episodiosMovidos: 0, episodiosFundidos: 0,
  generos: 0, historico: 0, historicoDescartado: 0, watchlist: 0,
  watchlistDescartada: 0, likes: 0, likesDescartados: 0,
});

function somar(alvo: Contagem, parcela: Contagem) {
  for (const chave of Object.keys(alvo) as (keyof Contagem)[]) alvo[chave] += parcela[chave];
}

// ── Leitura ───────────────────────────────────────────────────────────────────

type LinhaFilme = RegistroCatalogo & { id: string };
type LinhaSerie = RegistroCatalogo & { id: string };

/**
 * Carrega so o que tem tmdbId repetido.
 *
 * O GROUP BY resolve no banco quais tmdbIds tem mais de uma linha; so depois as
 * linhas inteiras sao buscadas. Varrer as duas tabelas completas para o cliente
 * seria desnecessario — a esmagadora maioria dos titulos nao tem duplicata.
 */
async function tmdbIdsDuplicados(tabela: "Filme" | "Serie"): Promise<string[]> {
  const linhas = await prisma.$queryRawUnsafe<{ tmdbId: string }[]>(
    `SELECT "tmdbId" FROM "${tabela}"
      WHERE "tmdbId" IS NOT NULL AND "tmdbId" <> ''
      GROUP BY "tmdbId"
      HAVING COUNT(*) > 1
      ORDER BY COUNT(*) DESC, "tmdbId" ASC`,
  );
  return linhas.map((l) => l.tmdbId);
}

async function carregarFilmes(tmdbIds: string[]): Promise<LinhaFilme[]> {
  const linhas = await prisma.filme.findMany({
    where: { tmdbId: { in: tmdbIds } },
    select: {
      id: true, tmdbId: true, titulo: true, tituloOriginal: true, poster: true,
      background: true, logo: true, sinopse: true, ano: true, nota: true,
      urlDub: true, urlLeg: true, createdAt: true,
    },
  });
  return linhas.map((l) => ({ ...l, tipo: "filme" as const }));
}

async function carregarSeries(tmdbIds: string[]): Promise<LinhaSerie[]> {
  const linhas = await prisma.serie.findMany({
    where: { tmdbId: { in: tmdbIds } },
    select: {
      id: true, tmdbId: true, titulo: true, tituloOriginal: true, poster: true,
      background: true, logo: true, sinopse: true, ano: true, nota: true,
      tipo: true, createdAt: true,
      _count: { select: { episodios: true } },
    },
  });

  // `tipo` na Serie e a secao do catalogo, nao a midia — canonicalKey ja trata
  // isso. Aqui ele so viaja junto para aparecer no relatorio.
  return linhas.map(({ _count, tipo, ...resto }) => ({
    ...resto,
    tipo: tipo ?? "serie",
    episodios: _count.episodios,
  }));
}

// ── Migracao de vinculos ──────────────────────────────────────────────────────

/**
 * Episodios do perdedor para o vencedor.
 *
 * Dois caminhos, porque `@@unique([serieId, temporada, numeroEp])` impede
 * simplesmente reapontar tudo:
 *
 *  - o vencedor NAO tem aquele T/E  -> o episodio muda de dono (o id sobrevive,
 *    entao WatchHistory que apontava para ele continua valido);
 *  - o vencedor JA tem aquele T/E   -> as URLs que faltam no dele sao
 *    completadas com as do perdedor, o historico e reapontado para o episodio
 *    do vencedor e so entao a linha duplicada morre.
 *
 * O segundo caminho e o que recupera o caso real da auditoria: a duplicata com
 * 3 episodios e a com 2 acabam somadas no mesmo registro.
 */
async function migrarEpisodios(vencedorId: string, perdedorId: string, contagem: Contagem) {
  const [doPerdedor, doVencedor] = await Promise.all([
    prisma.episodio.findMany({ where: { serieId: perdedorId } }),
    prisma.episodio.findMany({
      where: { serieId: vencedorId },
      select: { id: true, temporada: true, numeroEp: true, urlDub: true, urlLeg: true },
    }),
  ]);

  const chave = (t: number, e: number) => `${t}x${e}`;
  const noVencedor = new Map(doVencedor.map((e) => [chave(e.temporada, e.numeroEp), e]));

  for (const episodio of doPerdedor) {
    const equivalente = noVencedor.get(chave(episodio.temporada, episodio.numeroEp));

    if (!equivalente) {
      contagem.episodiosMovidos++;
      if (APPLY) {
        await prisma.episodio.update({
          where: { id: episodio.id },
          data: { serieId: vencedorId },
        });
      }
      // Passa a existir no vencedor: um proximo episodio com o mesmo T/E (nao
      // deveria haver, mas o banco nao garantia) encontra o equivalente.
      noVencedor.set(chave(episodio.temporada, episodio.numeroEp), {
        id: episodio.id,
        temporada: episodio.temporada,
        numeroEp: episodio.numeroEp,
        urlDub: episodio.urlDub,
        urlLeg: episodio.urlLeg,
      });
      continue;
    }

    contagem.episodiosFundidos++;

    const completar: { urlDub?: string; urlLeg?: string } = {};
    if (!equivalente.urlDub && episodio.urlDub) completar.urlDub = episodio.urlDub;
    if (!equivalente.urlLeg && episodio.urlLeg) completar.urlLeg = episodio.urlLeg;
    if (APPLY && Object.keys(completar).length > 0) {
      await prisma.episodio.update({ where: { id: equivalente.id }, data: completar });
    }

    // O historico precisa sair do episodio que vai morrer ANTES do delete. Roda
    // tambem no dry-run, so que sem escrever: e o que faz o relatorio dizer a
    // verdade sobre quanto historico de usuario o merge encosta.
    await reapontarHistoricoDeEpisodio(episodio.id, equivalente.id, contagem);
    if (APPLY) await prisma.episodio.delete({ where: { id: episodio.id } });
  }
}

/**
 * Historico preso a um episodio que sera apagado.
 *
 * `@@unique([userId, conteudoId, episodioId])` pode ja ter uma linha do mesmo
 * usuario no episodio de destino. Nesse caso sobrevive a de maior progresso —
 * concluido vence qualquer coisa —, nunca a mais recente por acaso.
 */
async function reapontarHistoricoDeEpisodio(deId: string, paraId: string, contagem: Contagem) {
  const linhas = await prisma.watchHistory.findMany({ where: { episodioId: deId } });

  for (const linha of linhas) {
    const existente = await prisma.watchHistory.findFirst({
      where: { userId: linha.userId, conteudoId: linha.conteudoId, episodioId: paraId },
    });

    if (!existente) {
      contagem.historico++;
      if (APPLY) {
        await prisma.watchHistory.update({ where: { id: linha.id }, data: { episodioId: paraId } });
      }
      continue;
    }

    contagem.historicoDescartado++;
    if (!APPLY) continue;

    if (existente.concluido || existente.progressoSeg >= linha.progressoSeg) {
      await prisma.watchHistory.delete({ where: { id: linha.id } });
    } else {
      await prisma.watchHistory.delete({ where: { id: existente.id } });
      await prisma.watchHistory.update({ where: { id: linha.id }, data: { episodioId: paraId } });
    }
  }
}

/** Vinculos de genero: o vencedor recebe o que nao tinha, o perdedor e limpo. */
async function migrarGeneros(
  midia: "filme" | "serie",
  vencedorId: string,
  perdedorId: string,
  contagem: Contagem,
) {
  if (midia === "filme") {
    const doPerdedor = await prisma.filmeGenero.findMany({ where: { filmeId: perdedorId } });
    contagem.generos += doPerdedor.length;
    if (!APPLY) return;
    if (doPerdedor.length > 0) {
      await prisma.filmeGenero.createMany({
        data: doPerdedor.map((g) => ({ filmeId: vencedorId, generoId: g.generoId })),
        skipDuplicates: true,
      });
    }
    await prisma.filmeGenero.deleteMany({ where: { filmeId: perdedorId } });
    return;
  }

  const doPerdedor = await prisma.serieGenero.findMany({ where: { serieId: perdedorId } });
  contagem.generos += doPerdedor.length;
  if (!APPLY) return;
  if (doPerdedor.length > 0) {
    await prisma.serieGenero.createMany({
      data: doPerdedor.map((g) => ({ serieId: vencedorId, generoId: g.generoId })),
      skipDuplicates: true,
    });
  }
  await prisma.serieGenero.deleteMany({ where: { serieId: perdedorId } });
}

/**
 * Historico de filme/serie inteiro (o que aponta para `conteudoId`, nao para um
 * episodio). Mesma regra de colisao: sobrevive quem assistiu mais.
 */
async function migrarHistorico(
  midia: "filme" | "serie",
  vencedorId: string,
  perdedorId: string,
  contagem: Contagem,
) {
  const linhas = await prisma.watchHistory.findMany({ where: { conteudoId: perdedorId } });

  for (const linha of linhas) {
    const existente = await prisma.watchHistory.findFirst({
      where: { userId: linha.userId, conteudoId: vencedorId, episodioId: linha.episodioId },
    });

    if (!existente) {
      contagem.historico++;
      if (!APPLY) continue;
      await prisma.watchHistory.update({
        where: { id: linha.id },
        data: {
          conteudoId: vencedorId,
          ...(midia === "filme" ? { filmeId: vencedorId } : { serieId: vencedorId }),
        },
      });
      continue;
    }

    contagem.historicoDescartado++;
    if (!APPLY) continue;

    if (existente.concluido || existente.progressoSeg >= linha.progressoSeg) {
      await prisma.watchHistory.delete({ where: { id: linha.id } });
    } else {
      await prisma.watchHistory.delete({ where: { id: existente.id } });
      await prisma.watchHistory.update({
        where: { id: linha.id },
        data: {
          conteudoId: vencedorId,
          ...(midia === "filme" ? { filmeId: vencedorId } : { serieId: vencedorId }),
        },
      });
    }
  }
}

/** Watchlist: chave composta, entao a colisao vira "fica o que entrou antes". */
async function migrarWatchlist(
  midia: "filme" | "serie",
  vencedorId: string,
  perdedorId: string,
  contagem: Contagem,
) {
  const linhas = await prisma.watchlist.findMany({ where: { conteudoId: perdedorId } });

  for (const linha of linhas) {
    const existente = await prisma.watchlist.findUnique({
      where: {
        userId_conteudoId_conteudoTipo: {
          userId: linha.userId,
          conteudoId: vencedorId,
          conteudoTipo: linha.conteudoTipo,
        },
      },
    });

    if (existente) {
      contagem.watchlistDescartada++;
      if (APPLY) {
        await prisma.watchlist.delete({
          where: {
            userId_conteudoId_conteudoTipo: {
              userId: linha.userId,
              conteudoId: perdedorId,
              conteudoTipo: linha.conteudoTipo,
            },
          },
        });
      }
      continue;
    }

    contagem.watchlist++;
    if (!APPLY) continue;

    // Chave primaria composta nao aceita update do proprio campo: recria e apaga.
    await prisma.watchlist.create({
      data: {
        userId: linha.userId,
        conteudoId: vencedorId,
        conteudoTipo: linha.conteudoTipo,
        addedAt: linha.addedAt,
        ...(midia === "filme" ? { filmeId: vencedorId } : { serieId: vencedorId }),
      },
    });
    await prisma.watchlist.delete({
      where: {
        userId_conteudoId_conteudoTipo: {
          userId: linha.userId,
          conteudoId: perdedorId,
          conteudoTipo: linha.conteudoTipo,
        },
      },
    });
  }
}

/** Likes: se o usuario ja curtiu o vencedor, a duplicata some sem alterar o voto. */
async function migrarLikes(vencedorId: string, perdedorId: string, contagem: Contagem) {
  const linhas = await prisma.like.findMany({ where: { conteudoId: perdedorId } });

  for (const linha of linhas) {
    const existente = await prisma.like.findFirst({
      where: { userId: linha.userId, conteudoId: vencedorId, conteudoTipo: linha.conteudoTipo },
    });

    if (existente) {
      contagem.likesDescartados++;
      if (APPLY) await prisma.like.delete({ where: { id: linha.id } });
      continue;
    }

    contagem.likes++;
    if (APPLY) {
      await prisma.like.update({ where: { id: linha.id }, data: { conteudoId: vencedorId } });
    }
  }
}

// ── Orquestracao ──────────────────────────────────────────────────────────────

function rotulo(r: RegistroCatalogo & { episodios?: number | null }): string {
  const eps = r.episodios === undefined || r.episodios === null ? "" : ` ${r.episodios} eps`;
  const ano = r.ano ? ` ${r.ano}` : "";
  return `${r.id.padEnd(16)} ${String(r.titulo ?? "?").slice(0, 38).padEnd(38)}${ano}${eps}`;
}

async function processar<T extends RegistroCatalogo>(
  midia: "filme" | "serie",
  grupos: GrupoCanonico<T>[],
): Promise<Contagem> {
  const total = zerado();

  for (const grupo of grupos) {
    const contagem = zerado();
    contagem.grupos = 1;
    contagem.perdedores = grupo.perdedores.length;

    console.log(`\n${grupo.chave}`);
    console.log(`  vence  ${rotulo(grupo.vencedor)}`);
    for (const perdedor of grupo.perdedores) console.log(`  migra  ${rotulo(perdedor)}`);

    for (const perdedor of grupo.perdedores) {
      if (midia === "serie") await migrarEpisodios(grupo.vencedor.id, perdedor.id, contagem);
      await migrarGeneros(midia, grupo.vencedor.id, perdedor.id, contagem);
      await migrarHistorico(midia, grupo.vencedor.id, perdedor.id, contagem);
      await migrarWatchlist(midia, grupo.vencedor.id, perdedor.id, contagem);
      await migrarLikes(grupo.vencedor.id, perdedor.id, contagem);

      // O DELETE e a ULTIMA coisa, e so depois de tudo ter saido da linha.
      if (APPLY) {
        if (midia === "filme") await prisma.filme.delete({ where: { id: perdedor.id } });
        else await prisma.serie.delete({ where: { id: perdedor.id } });
      }
    }

    const partes = [
      contagem.episodiosMovidos && `${contagem.episodiosMovidos} eps movidos`,
      contagem.episodiosFundidos && `${contagem.episodiosFundidos} eps fundidos`,
      contagem.generos && `${contagem.generos} generos`,
      contagem.historico && `${contagem.historico} historico`,
      contagem.historicoDescartado && `${contagem.historicoDescartado} historico redundante`,
      contagem.watchlist && `${contagem.watchlist} watchlist`,
      contagem.watchlistDescartada && `${contagem.watchlistDescartada} watchlist redundante`,
      contagem.likes && `${contagem.likes} likes`,
      contagem.likesDescartados && `${contagem.likesDescartados} likes redundantes`,
    ].filter(Boolean);
    console.log(`  ${partes.length ? partes.join(" · ") : "nada a migrar"}`);

    somar(total, contagem);
  }

  return total;
}

async function main() {
  console.log(
    `\n${APPLY ? "APLICANDO — o banco vai ser alterado" : "DRY-RUN — nada sera escrito"}\n` +
    `${"=".repeat(64)}`,
  );

  const total = zerado();

  if (TIPO_ARG !== "series") {
    const ids = await tmdbIdsDuplicados("Filme");
    const alvo = LIMITE ? ids.slice(0, LIMITE) : ids;
    console.log(`\nFILMES — ${ids.length} tmdbId duplicados${LIMITE ? ` (processando ${alvo.length})` : ""}`);
    if (alvo.length > 0) {
      somar(total, await processar("filme", agruparDuplicatas(await carregarFilmes(alvo))));
    }
  }

  if (TIPO_ARG !== "filmes") {
    const ids = await tmdbIdsDuplicados("Serie");
    const alvo = LIMITE ? ids.slice(0, LIMITE) : ids;
    console.log(`\nSERIES — ${ids.length} tmdbId duplicados${LIMITE ? ` (processando ${alvo.length})` : ""}`);
    if (alvo.length > 0) {
      somar(total, await processar("serie", agruparDuplicatas(await carregarSeries(alvo))));
    }
  }

  console.log(`\n${"=".repeat(64)}`);
  console.log(`grupos                ${total.grupos}`);
  console.log(`registros removidos   ${total.perdedores}`);
  console.log(`episodios movidos     ${total.episodiosMovidos}`);
  console.log(`episodios fundidos    ${total.episodiosFundidos}`);
  console.log(`vinculos de genero    ${total.generos}`);
  console.log(`historico migrado     ${total.historico} (${total.historicoDescartado} redundantes)`);
  console.log(`watchlist migrada     ${total.watchlist} (${total.watchlistDescartada} redundantes)`);
  console.log(`likes migrados        ${total.likes} (${total.likesDescartados} redundantes)`);

  if (!APPLY) {
    console.log(`\nNada foi escrito. Revise o relatorio acima e rode com --apply para aplicar.`);
  } else {
    console.log(`\nAplicado. Agora a migration do indice unico em tmdbId pode ser executada.`);
  }
}

main()
  .catch((erro) => {
    console.error("\nFalhou:", erro);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
