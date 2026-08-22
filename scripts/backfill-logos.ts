/**
 * Preenche `logo` e `background` do catálogo a partir do TMDB.
 *
 * Por que existe: os cards da home suportam logo desde sempre, mas o campo
 * estava vazio em 100% dos filmes e em 98,6% das séries — o caminho do logo
 * nunca disparava e os banners apareciam sem nome. A rota
 * /api/admin/backfill-logos faz o mesmo trabalho, porém sempre sobre os N mais
 * recentes: rodar de novo reprocessa os mesmos itens e nunca avança no
 * catálogo. Aqui o filtro é "ainda não tem", então cada execução progride.
 *
 * Roda local, com o banco direto: são ~36 mil títulos, muito acima do limite
 * de execução de uma função serverless, e assim não depende do token de admin.
 *
 * Uso:
 *   npx tsx scripts/backfill-logos.ts              — tudo que falta
 *   npx tsx scripts/backfill-logos.ts --limite 500 — só os 500 mais populares
 *   npx tsx scripts/backfill-logos.ts --tipo filmes
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
// TMDB tolera ~50 req/s. 12 em paralelo mantém margem folgada e ainda assim
// processa o catálogo inteiro em minutos, não horas.
const LOTE = 12;
const PAGINA = 300;

let atualizados = 0;
let semArte = 0;
let erros = 0;

async function processar<T extends { id: string; tmdbId: string | null }>(
  rotulo: string,
  buscarPagina: () => Promise<T[]>,
  buscarImagens: (tmdbId: string) => Promise<any>,
  gravar: (id: string, data: { logo?: string; background?: string }) => Promise<unknown>,
) {
  let restante = LIMITE;

  while (restante > 0) {
    const pagina = await buscarPagina();
    if (!pagina.length) break;

    for (let i = 0; i < pagina.length && restante > 0; i += LOTE) {
      const lote = pagina.slice(i, i + LOTE);
      await Promise.all(
        lote.map(async (row) => {
          try {
            const imgs = await buscarImagens(row.tmdbId!);
            const data: { logo?: string; background?: string } = {};
            const logo = pickLogo(imgs);
            const bg = pickBackdrop(imgs);
            if (logo) data.logo = logo;
            if (bg) data.background = bg;

            if (Object.keys(data).length) {
              await gravar(row.id, data);
              atualizados++;
            } else {
              // Sem arte no TMDB. Marcar seria ideal para não reconsultar, mas
              // exigiria coluna nova; por ora só contabiliza.
              semArte++;
            }
          } catch {
            erros++;
          }
        }),
      );
      restante -= lote.length;
      process.stdout.write(
        `\r${rotulo}: ${atualizados} atualizados · ${semArte} sem arte · ${erros} erros`,
      );
    }

    if (pagina.length < PAGINA) break;
  }
  process.stdout.write("\n");
}

async function main() {
  if (TIPO === "all" || TIPO === "filmes") {
    await processar(
      "filmes",
      () =>
        prisma.filme.findMany({
          where: { tmdbId: { not: null }, logo: null },
          orderBy: { popularidade: { sort: "desc", nulls: "last" } },
          take: Math.min(PAGINA, LIMITE),
          select: { id: true, tmdbId: true },
        }),
      (tmdbId) => getMovieImages(tmdbId),
      (id, data) => prisma.filme.update({ where: { id }, data }),
    );
  }

  if (TIPO === "all" || TIPO === "series") {
    atualizados = 0;
    semArte = 0;
    erros = 0;
    await processar(
      "séries",
      () =>
        prisma.serie.findMany({
          where: { tmdbId: { not: null }, logo: null },
          orderBy: { popularidade: { sort: "desc", nulls: "last" } },
          take: Math.min(PAGINA, LIMITE),
          select: { id: true, tmdbId: true },
        }),
      (tmdbId) => getTVImages(tmdbId),
      (id, data) => prisma.serie.update({ where: { id }, data }),
    );
  }

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error("\nfalhou:", e);
  await prisma.$disconnect();
  process.exit(1);
});
