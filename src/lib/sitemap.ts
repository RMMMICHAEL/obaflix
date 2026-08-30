import { prisma } from "@/lib/prisma";

/**
 * URLs por arquivo. O limite do protocolo e 50.000 URLs / 50 MB; 5.000 mantem
 * cada shard barato de gerar (uma leitura por PK) e pequeno de baixar.
 */
export const SHARD_SIZE = 5000;

export type CatalogoTipo = "filmes" | "series";

/**
 * So entra no sitemap quem tem sinopse. Pagina sem texto proprio e conteudo
 * raso, e o filtro corta justamente o que o sync acabou de importar ainda sem
 * dados do TMDB. Nao gera conteudo nenhum: apenas deixa de anunciar o que
 * ainda nao tem o que mostrar.
 */
const COM_CONTEUDO = { sinopse: { not: null } };

/**
 * Teto de URLs de catalogo por tipo. Medida de custo, temporaria e reversivel.
 *
 * Anunciar o catalogo inteiro transformava o crawler em gerador de paginas
 * frias: cada URL nova visitada por bot custava um render e, enquanto as fichas
 * eram ISR, tambem uma escrita de cache por titulo. Com o teto o bot rastreia o
 * que tem chance real de trazer visita — a cauda continua acessivel e indexavel
 * por link, so nao e mais empurrada de uma vez.
 *
 * SITEMAP_MAX_POR_TIPO=0 remove o teto e volta ao catalogo completo.
 */
const LIMITE_PADRAO = 1000;

export function limiteCatalogo(): number {
  const bruto = process.env.SITEMAP_MAX_POR_TIPO;
  if (bruto === undefined) return LIMITE_PADRAO;
  const n = Number(bruto);
  if (!Number.isFinite(n) || n < 0) return LIMITE_PADRAO;
  return n === 0 ? Number.MAX_SAFE_INTEGER : Math.floor(n);
}

export async function contarCatalogo(tipo: CatalogoTipo) {
  const total = tipo === "filmes"
    ? await prisma.filme.count({ where: COM_CONTEUDO })
    : await prisma.serie.count({ where: COM_CONTEUDO });
  return Math.min(total, limiteCatalogo());
}

/**
 * Ordena por popularidade, e nao mais pela PK: sob teto, a ordem decide QUEM
 * entra. `id` asc anunciaria os mil titulos mais antigos do provedor, que e o
 * oposto do que traz visita. O desempate por `id` mantem a saida estavel entre
 * geracoes — sitemap que muda de ordem sozinho confunde o Search Console.
 *
 * `popularidade` nao tem indice proprio, mas isto roda no maximo uma vez por dia
 * por arquivo (o `s-maxage` de respostaXml cuida do resto).
 *
 * Segue sem `lastmod`: `updatedAt` muda a cada escrita do sync e nao serve.
 */
export async function idsDoShard(tipo: CatalogoTipo, shard: number): Promise<string[]> {
  const skip = (shard - 1) * SHARD_SIZE;
  const restante = limiteCatalogo() - skip;
  if (restante <= 0) return [];
  const take = Math.min(SHARD_SIZE, restante);

  const consulta = {
    where: COM_CONTEUDO,
    select: { id: true },
    orderBy: [{ popularidade: "desc" as const }, { id: "asc" as const }],
    skip,
    take,
  };

  const linhas = tipo === "filmes"
    ? await prisma.filme.findMany(consulta)
    : await prisma.serie.findMany(consulta);

  return linhas.map((linha) => linha.id);
}

function escaparXml(valor: string) {
  return valor
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Sem `lastmod`: ver a nota de `updatedAt` acima. */
export function urlset(urls: string[]) {
  const corpo = urls.map((url) => `  <url><loc>${escaparXml(url)}</loc></url>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${corpo}\n</urlset>\n`;
}

export function sitemapIndex(urls: string[]) {
  const corpo = urls.map((url) => `  <sitemap><loc>${escaparXml(url)}</loc></sitemap>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${corpo}\n</sitemapindex>\n`;
}

/**
 * O cache fica no CDN, nao no framework: a rota e dinamica (nao consulta o
 * banco no build) e o `s-maxage` garante no maximo uma execucao por dia por
 * arquivo. O `stale-while-revalidate` evita que a expiracao coincida com o
 * crawl e obrigue o crawler a esperar uma geracao sincrona.
 */
export function respostaXml(xml: string) {
  return new Response(xml, {
    headers: {
      "Content-Type": "application/xml; charset=utf-8",
      "Cache-Control": "public, s-maxage=86400, stale-while-revalidate=604800",
    },
  });
}

export function shardNaoEncontrado() {
  return new Response("Not Found", {
    status: 404,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "public, s-maxage=3600",
    },
  });
}
