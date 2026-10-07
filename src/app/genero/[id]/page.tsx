import { notFound, permanentRedirect } from "next/navigation";
import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { absoluteUrl, mediaMetadata } from "@/lib/seo";
import { LandscapeCard } from "@/components/ui/LandscapeCard";
import { JsonLd } from "@/components/seo/JsonLd";
import { Breadcrumbs } from "@/components/seo/Breadcrumbs";
import { filmeDisponivel, serieDisponivel } from "@/lib/catalog-availability";
import { fatiarPagina, takeComSonda } from "@/lib/paginacao";
import { genrePath } from "@/lib/catalog-url";
import { buscarGeneroPorParam } from "./genero-data";

/**
 * Página de gênero, agora server-rendered: a primeira resposta já traz conteúdo
 * útil e indexável (antes dependia de JS + fetch nas APIs após a hidratação).
 *
 * - URL canônica `/genero/<slug>--<id>`; o id puro legado (`/genero/80`), um id
 *   duplicado (`/genero/terror--27`) e qualquer slug divergente redirecionam 308
 *   para o canônico do grupo (`/genero/terror--5`, o menor id — ver genero-data).
 * - Paginação rastreável: cada página é indexável e self-canonical
 *   (`?page=N` canoniza para si mesma, não para a base), para o catálogo inteiro
 *   do gênero ser alcançável por `page=1,2,3...`. `page=1` usa a URL limpa.
 * - 2 consultas por render (filmes + séries do grupo, `generoId in ids`, com
 *   teto). Sem count: o "próxima página" é inferido pelo tamanho da página cheia.
 */
export const dynamic = "force-dynamic";

const POR_PAGINA = 30;
const SEL = { id: true, titulo: true, poster: true, background: true, logo: true, ano: true, nota: true } as const;
// Popularidade desc (nulls por último) + id asc como desempate determinístico:
// sem o desempate, títulos com popularidade empatada podem trocar de página
// entre requisições (sumir/repetir). O `id` fixa a ordem.
const porPopularidade = { popularidade: { sort: "desc", nulls: "last" } } as const;
const ordenacao = [porPopularidade, { id: "asc" as const }];

function lerPagina(searchParams?: { page?: string }) {
  const n = Number(searchParams?.page ?? 1);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1;
}

export async function generateMetadata({
  params,
  searchParams,
}: {
  params: { id: string };
  searchParams?: { page?: string };
}) {
  const genero = await buscarGeneroPorParam(params.id);
  if (!genero) return { title: "Gênero não encontrado", robots: { index: false, follow: false } };

  // Paginação rastreável: cada página é indexável e aponta o canonical para si
  // mesma (`?page=N`), nunca para a base — assim `page=2,3...` não são tratadas
  // como duplicatas e o catálogo inteiro do gênero fica alcançável e indexável.
  // A regra index/noindex continua vindo de catalogRobots() (flag global), igual
  // à base: quando CONTENT_INDEXING_ENABLED=true, page=2 também é index/follow.
  const page = lerPagina(searchParams);
  const base = genrePath(genero.id, genero.nome);
  const path = page > 1 ? `${base}?page=${page}` : base;
  const title =
    page > 1
      ? `Filmes e séries de ${genero.nome} — página ${page}`
      : `Filmes e séries de ${genero.nome}`;

  return mediaMetadata({
    title,
    description: `Explore filmes e séries de ${genero.nome} disponíveis no catálogo Obaflix. Para assistir, baixe o aplicativo para Android, Android TV e Windows.`,
    path,
  });
}

export default async function GeneroPage({
  params,
  searchParams,
}: {
  params: { id: string };
  searchParams?: { page?: string };
}) {
  const genero = await buscarGeneroPorParam(params.id);
  if (!genero) notFound();

  const page = lerPagina(searchParams);

  // Uma URL canônica por gênero: slug divergente ou id puro legado → 308. A
  // paginação é preservada no destino — page>1 mantém ?page=N (page=1 fica limpo),
  // para `terror--27?page=2` não cair na página 1 ao canonizar para `terror--5`.
  const canonico = genrePath(genero.id, genero.nome);
  if (`/genero/${params.id}` !== canonico) {
    permanentRedirect(page > 1 ? `${canonico}?page=${page}` : canonico);
  }

  const skip = (page - 1) * POR_PAGINA;

  // `generoId in ids`: consulta o grupo semântico inteiro (ex. [5, 27]). O `some`
  // garante que um filme/série ligado a mais de um id do grupo apareça UMA vez — a
  // própria findMany do modelo não multiplica a linha.
  //
  // `takeComSonda`: busca POR_PAGINA + 1. A linha extra é a sonda de "próxima
  // página" sem COUNT — se voltar, há mais conteúdo; é descartada antes de exibir.
  // O `skip` continua múltiplo de POR_PAGINA (nunca 31) — a sonda não desloca o
  // início da página seguinte.
  const [filmesCru, seriesCru] = await Promise.all([
    prisma.filme.findMany({
      where: filmeDisponivel({ generos: { some: { generoId: { in: genero.ids } } } }),
      orderBy: ordenacao,
      skip,
      take: takeComSonda(POR_PAGINA),
      select: SEL,
    }),
    prisma.serie.findMany({
      where: serieDisponivel({ generos: { some: { generoId: { in: genero.ids } } } }),
      orderBy: ordenacao,
      skip,
      take: takeComSonda(POR_PAGINA),
      select: { ...SEL, tipo: true },
    }),
  ]);

  const { filmes: filmesPagina, series: seriesPagina, temProxima } = fatiarPagina(
    filmesCru,
    seriesCru,
    POR_PAGINA,
  );

  // Intercala filmes e séries para variedade, como na versão anterior.
  const itens: any[] = [];
  let fi = 0;
  let si = 0;
  while (fi < filmesPagina.length || si < seriesPagina.length) {
    if (fi < filmesPagina.length) {
      itens.push({ ...filmesPagina[fi], tipo: "filme" as const });
      fi++;
    }
    if (si < seriesPagina.length) {
      const s = seriesPagina[si] as any;
      itens.push({ ...s, tipo: s.tipo ?? "serie" });
      si++;
    }
  }

  // Gênero existe no banco mas sem conteúdo disponível nesta página → 404 em vez
  // de um 200 vazio. Vale para a base (gênero sem nada reproduzível) e para
  // páginas além do fim (`?page=N` grande): nada a mostrar, nada a indexar.
  if (itens.length === 0) notFound();

  const breadcrumbSchema = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: "Início", item: absoluteUrl("/") },
      { "@type": "ListItem", position: 2, name: `Filmes e séries de ${genero.nome}`, item: absoluteUrl(canonico) },
    ],
  };

  return (
    <div className="min-h-screen px-4 pb-16 pt-20 md:px-8">
      <JsonLd data={breadcrumbSchema} />
      <Breadcrumbs items={[{ label: "Início", href: "/" }, { label: genero.nome }]} />

      <h1 className="text-2xl font-black tracking-tight text-white sm:text-3xl">
        Filmes e séries de {genero.nome}
      </h1>
      <p className="mt-2 max-w-2xl text-sm leading-relaxed text-zinc-400 md:text-[15px]">
        Explore filmes e séries de {genero.nome} disponíveis no catálogo Obaflix.
      </p>

      <div className="mt-6 grid grid-cols-2 gap-x-3 gap-y-5 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
        {itens.map((item) => (
          <LandscapeCard
            key={`${item.tipo}-${item.id}`}
            layout="grid"
            id={item.id}
            tipo={item.tipo}
            titulo={item.titulo}
            poster={item.poster}
            background={item.background}
            logo={item.logo}
            ano={item.ano}
            nota={item.nota}
          />
        ))}
      </div>

      {(page > 1 || temProxima) && (
        <nav aria-label="Paginação" className="mt-10 flex items-center justify-center gap-3">
          {page > 1 ? (
            <Link
              href={page === 2 ? canonico : `${canonico}?page=${page - 1}`}
              rel="prev"
              className="rounded-lg bg-zinc-800 px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-zinc-700"
            >
              ← Anterior
            </Link>
          ) : null}
          {temProxima ? (
            <Link
              href={`${canonico}?page=${page + 1}`}
              rel="next"
              className="rounded-lg bg-zinc-800 px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-zinc-700"
            >
              Próxima →
            </Link>
          ) : null}
        </nav>
      )}
    </div>
  );
}
