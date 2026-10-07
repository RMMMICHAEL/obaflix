import { prisma } from "@/lib/prisma";
import { absoluteUrl, catalogIndexingEnabled } from "@/lib/seo";
import { catalogPath, genrePath } from "@/lib/catalog-url";
import { filmeDisponivel, serieDisponivel } from "@/lib/catalog-availability";
import { groupGenres } from "@/lib/genres";
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
    // UMA URL por genero semantico (Fase 4): generos duplicados (ex. terror 5 e
    // 27) compartilham slug e viram um grupo so, anunciado apenas pelo canonico
    // (menor id do grupo). Sem isto o sitemap listava terror--5 E terror--27.
    //
    // Uma consulta so, sem N+1: cada genero ja traz uma amostra (take: 1) de
    // filme/serie reproduzivel, entao a disponibilidade sai do mesmo SELECT.
    // Nao ha where no nivel do genero: precisamos de TODOS os registros para o
    // canonico ser o menor id do grupo mesmo quando so o outro id tem conteudo
    // (ex. 5 vazio, 27 com conteudo -> ainda assim terror--5).
    const generos = await prisma.genero.findMany({
      select: {
        id: true,
        nome: true,
        filmes: { where: { filme: filmeDisponivel() }, take: 1, select: { generoId: true } },
        series: { where: { serie: serieDisponivel() }, take: 1, select: { generoId: true } },
      },
    });

    const comConteudo = new Set(
      generos.filter((g) => g.filmes.length > 0 || g.series.length > 0).map((g) => g.id),
    );

    for (const grupo of groupGenres(generos.map((g) => ({ id: g.id, nome: g.nome })))) {
      // Grupo entra quando QUALQUER membro tem conteudo disponivel.
      if (grupo.ids.some((id) => comConteudo.has(id))) {
        urls.push(absoluteUrl(genrePath(grupo.id, grupo.nome)));
      }
    }
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
