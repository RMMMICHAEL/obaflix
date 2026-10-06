import { prisma } from "@/lib/prisma";
import { absoluteUrl, catalogIndexingEnabled } from "@/lib/seo";
import { catalogPath, genrePath } from "@/lib/catalog-url";
import { filmeDisponivel, serieDisponivel } from "@/lib/catalog-availability";
import {
  CatalogoTipo,
  linhasDoShard,
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

  // So as paginas publicas reais. /animes, /desenhos e /melhores ainda nao tem
  // versao publica para navegador comum (caem na landing), entao nao entram no
  // sitemap enquanto continuarem fechadas — anunciar rota que redireciona e
  // desperdicio de crawl e contradicao para o Search Console.
  urls.push(absoluteUrl("/filmes"), absoluteUrl("/series"));

  try {
    // Somente generos com conteudo disponivel (um filme OU uma serie/anime/
    // desenho reproduzivel). Uma consulta so, sem N+1: a disponibilidade e um
    // filtro de relacao resolvido no banco.
    const generos = await prisma.genero.findMany({
      where: {
        OR: [
          { filmes: { some: { filme: filmeDisponivel() } } },
          { series: { some: { serie: serieDisponivel() } } },
        ],
      },
      select: { id: true, nome: true },
    });
    urls.push(...generos.map((genero) => absoluteUrl(genrePath(genero.id, genero.nome))));
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
    const linhas = await linhasDoShard(tipo, shard);
    // Shard vazio responde 404 de proposito: sem isso qualquer numero vira uma
    // URL valida e o crawler ganha um espaco infinito de arquivos vazios.
    if (linhas.length === 0) return shardNaoEncontrado();

    const tipoFicha = tipo === "filmes" ? "filme" : "serie";
    return respostaXml(
      urlset(linhas.map((l) => absoluteUrl(catalogPath(tipoFicha, l.id, l.titulo)))),
    );
  } catch (error) {
    console.error(`[sitemap] Falha ao montar o shard ${params.shard}.`, error);
    return shardNaoEncontrado();
  }
}
