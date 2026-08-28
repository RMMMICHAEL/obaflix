import { absoluteUrl, catalogIndexingEnabled } from "@/lib/seo";
import { contarCatalogo, respostaXml, SHARD_SIZE, sitemapIndex } from "@/lib/sitemap";

// Dinamica de proposito: nada de consultar o banco no build. O cache de 24h
// vem do `s-maxage` em respostaXml, entao o custo real e uma execucao por dia.
export const dynamic = "force-dynamic";

export async function GET() {
  const arquivos = [absoluteUrl("/sitemap/paginas.xml")];

  // Enquanto CONTENT_INDEXING_ENABLED estiver desligado o indice anuncia so as
  // paginas fixas: o catalogo nao aparece nem como URL ate a decisao de direitos.
  if (catalogIndexingEnabled) {
    try {
      const [filmes, series] = await Promise.all([
        contarCatalogo("filmes"),
        contarCatalogo("series"),
      ]);

      for (let n = 1; n <= Math.ceil(filmes / SHARD_SIZE); n += 1) {
        arquivos.push(absoluteUrl(`/sitemap/filmes-${n}.xml`));
      }
      for (let n = 1; n <= Math.ceil(series / SHARD_SIZE); n += 1) {
        arquivos.push(absoluteUrl(`/sitemap/series-${n}.xml`));
      }
    } catch (error) {
      console.error("[sitemap] Contagem falhou; indice fica so com as paginas fixas.", error);
    }
  }

  return respostaXml(sitemapIndex(arquivos));
}
