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

export function contarCatalogo(tipo: CatalogoTipo) {
  return tipo === "filmes"
    ? prisma.filme.count({ where: COM_CONTEUDO })
    : prisma.serie.count({ where: COM_CONTEUDO });
}

/**
 * Ordena pela PK de proposito: `id` ja tem indice e `updatedAt` nao tem — e
 * ainda muda a cada escrita do sync, entao nao serve nem para ordenar nem como
 * lastmod (ver comentario de `artCheckedAt` no schema).
 */
export async function idsDoShard(tipo: CatalogoTipo, shard: number): Promise<string[]> {
  const skip = (shard - 1) * SHARD_SIZE;

  if (tipo === "filmes") {
    const linhas = await prisma.filme.findMany({
      where: COM_CONTEUDO,
      select: { id: true },
      orderBy: { id: "asc" },
      skip,
      take: SHARD_SIZE,
    });
    return linhas.map((linha) => linha.id);
  }

  const linhas = await prisma.serie.findMany({
    where: COM_CONTEUDO,
    select: { id: true },
    orderBy: { id: "asc" },
    skip,
    take: SHARD_SIZE,
  });
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
