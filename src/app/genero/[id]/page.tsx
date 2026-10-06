import { notFound, permanentRedirect } from "next/navigation";
import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { absoluteUrl, mediaMetadata } from "@/lib/seo";
import { LandscapeCard } from "@/components/ui/LandscapeCard";
import { JsonLd } from "@/components/seo/JsonLd";
import { Breadcrumbs } from "@/components/seo/Breadcrumbs";
import { filmeDisponivel, serieDisponivel } from "@/lib/catalog-availability";
import { genrePath } from "@/lib/catalog-url";
import { buscarGeneroPorParam } from "./genero-data";

/**
 * Página de gênero, agora server-rendered: a primeira resposta já traz conteúdo
 * útil e indexável (antes dependia de JS + fetch nas APIs após a hidratação).
 *
 * - URL canônica `/genero/<slug>--<id>`; o id puro legado (`/genero/80`) e
 *   qualquer slug divergente redirecionam 308 para a canônica.
 * - Paginação controlada: `?page=N` (N>1) responde `noindex, follow` e aponta o
 *   canonical para a base, para parâmetros não gerarem milhares de páginas SEO.
 * - 2 consultas por render (filmes + séries do gênero, com teto). Sem count: o
 *   "próxima página" é inferido pelo tamanho da página cheia.
 */
export const dynamic = "force-dynamic";

const POR_PAGINA = 30;
const SEL = { id: true, titulo: true, poster: true, background: true, logo: true, ano: true, nota: true } as const;
const porPopularidade = { popularidade: { sort: "desc", nulls: "last" } } as const;

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

  const md = mediaMetadata({
    title: `Filmes e séries de ${genero.nome}`,
    description: `Explore filmes e séries de ${genero.nome} disponíveis no catálogo Obaflix. Para assistir, baixe o aplicativo para Android, Android TV e Windows.`,
    path: genrePath(genero.id, genero.nome),
  });
  // Página paginada não disputa indexação com a base; canonical segue na base.
  if (lerPagina(searchParams) > 1) md.robots = { index: false, follow: true };
  return md;
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

  // Uma URL canônica por gênero: slug divergente ou id puro legado → 308.
  const canonico = genrePath(genero.id, genero.nome);
  if (`/genero/${params.id}` !== canonico) permanentRedirect(canonico);

  const page = lerPagina(searchParams);
  const skip = (page - 1) * POR_PAGINA;

  const [filmes, series] = await Promise.all([
    prisma.filme.findMany({
      where: filmeDisponivel({ generos: { some: { generoId: genero.id } } }),
      orderBy: porPopularidade,
      skip,
      take: POR_PAGINA,
      select: SEL,
    }),
    prisma.serie.findMany({
      where: serieDisponivel({ generos: { some: { generoId: genero.id } } }),
      orderBy: porPopularidade,
      skip,
      take: POR_PAGINA,
      select: { ...SEL, tipo: true },
    }),
  ]);

  // Intercala filmes e séries para variedade, como na versão anterior.
  const itens: any[] = [];
  let fi = 0;
  let si = 0;
  while (fi < filmes.length || si < series.length) {
    if (fi < filmes.length) {
      itens.push({ ...filmes[fi], tipo: "filme" as const });
      fi++;
    }
    if (si < series.length) {
      const s = series[si] as any;
      itens.push({ ...s, tipo: s.tipo ?? "serie" });
      si++;
    }
  }

  // Gênero existe no banco mas sem conteúdo disponível nesta página → 404 em vez
  // de um 200 vazio. Vale para a base (gênero sem nada reproduzível) e para
  // páginas além do fim (`?page=N` grande): nada a mostrar, nada a indexar.
  if (itens.length === 0) notFound();

  const temProxima = filmes.length === POR_PAGINA || series.length === POR_PAGINA;

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
