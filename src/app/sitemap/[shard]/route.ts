import { prisma } from "@/lib/prisma";
import { absoluteUrl, catalogIndexingEnabled } from "@/lib/seo";
import {
  CatalogoTipo,
  idsDoShard,
  respostaXml,
  shardNaoEncontrado,
  urlset,
} from "@/lib/sitemap";

export const dynamic = "force-dynamic";

// Aceita apenas `filmes-1.xml` ate `filmes-9999.xml` (idem series). Qualquer
// outra forma cai em 404 em vez de virar uma URL valida.
const SHARD_CATALOGO = /^(filmes|series)-([1-9][0-9]{0,3})\.xml$/;

async function paginasFixas() {
  const urls = [absoluteUrl("/")];

  // Listagens e generos so entram quando o catalogo pode ser indexado: enquanto
  // a flag estiver off essas paginas respondem noindex, e anunciar URL noindex
  // no sitemap e contradicao que o Search Console reporta como erro.
  if (!catalogIndexingEnabled) return urls;

  urls.push(
    absoluteUrl("/filmes"),
    absoluteUrl("/series"),
    absoluteUrl("/animes"),
    absoluteUrl("/desenhos"),
    absoluteUrl("/melhores"),
  );

  try {
    const generos = await prisma.genero.findMany({ select: { id: true } });
    urls.push(...generos.map((genero) => absoluteUrl(`/genero/${genero.id}`)));
  } catch (error) {
    console.error("[sitemap] Generos indisponiveis; paginas fixas seguem sem eles.", error);
  }

  return urls;
}

export async function GET(_req: Request, { params }: { params: { shard: string } }) {
  if (params.shard === "paginas.xml") {
    return respostaXml(urlset(await paginasFixas()));
  }

  const match = SHARD_CATALOGO.exec(params.shard);
  if (!match || !catalogIndexingEnabled) return shardNaoEncontrado();

  const tipo = match[1] as CatalogoTipo;
  const shard = Number(match[2]);

  try {
    const ids = await idsDoShard(tipo, shard);
    // Shard vazio responde 404 de proposito: sem isso qualquer numero vira uma
    // URL valida e o crawler ganha um espaco infinito de arquivos vazios.
    if (ids.length === 0) return shardNaoEncontrado();

    const caminho = tipo === "filmes" ? "filme" : "serie";
    return respostaXml(
      urlset(ids.map((id) => absoluteUrl(`/${caminho}/${encodeURIComponent(id)}`))),
    );
  } catch (error) {
    console.error(`[sitemap] Falha ao montar o shard ${params.shard}.`, error);
    return shardNaoEncontrado();
  }
}
