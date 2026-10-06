import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { LandscapeRow } from "@/components/ui/LandscapeRow";
import { SecaoDownloads } from "@/components/landing/SecaoDownloads";
import { INSTALADORES } from "@/config/downloads";
import { filmeDisponivel, serieDisponivel } from "@/lib/catalog-availability";
import { groupGenres } from "@/lib/genres";
import { genrePath } from "@/lib/catalog-url";

/**
 * Versão pública de `/filmes` e `/series` para o navegador comum.
 *
 * NÃO é a tela dos aplicativos: sem Continuar Assistindo, sem anúncios, sem
 * filtros — só catálogo + aquisição. A experiência de streaming (hero, filtros,
 * continuar, banners) continua intacta para Android e Electron, servida pela
 * própria rota quando o ambiente não é navegador. Googlebot é navegador e recebe
 * exatamente esta mesma página pública — sem cloaking.
 *
 * Custo: 3 consultas (em alta, bem avaliados, gêneros), todas com teto. Os cards
 * levam às fichas canônicas (`catalogPath`, via LandscapeCard).
 */

const SEL = {
  id: true,
  titulo: true,
  poster: true,
  background: true,
  logo: true,
  ano: true,
  nota: true,
} as const;

const porPopularidade = { popularidade: { sort: "desc", nulls: "last" } } as const;
const porDestaque = { scoreDestaque: { sort: "desc", nulls: "last" } } as const;

export async function CatalogoPublico({ tipo }: { tipo: "filme" | "serie" }) {
  const ehFilme = tipo === "filme";

  const [emAlta, avaliados, generosRaw] = ehFilme
    ? await Promise.all([
        prisma.filme.findMany({ where: filmeDisponivel(), orderBy: porPopularidade, take: 18, select: SEL }),
        prisma.filme.findMany({ where: filmeDisponivel(), orderBy: porDestaque, take: 18, select: SEL }),
        prisma.genero.findMany({
          where: { filmes: { some: { filme: filmeDisponivel() } } },
          select: { id: true, nome: true },
          orderBy: { nome: "asc" },
        }),
      ])
    : await Promise.all([
        prisma.serie.findMany({ where: serieDisponivel({ tipo: "serie" }), orderBy: porPopularidade, take: 18, select: { ...SEL, tipo: true } }),
        prisma.serie.findMany({ where: serieDisponivel({ tipo: "serie" }), orderBy: porDestaque, take: 18, select: { ...SEL, tipo: true } }),
        prisma.genero.findMany({
          where: { series: { some: { serie: serieDisponivel({ tipo: "serie" }) } } },
          select: { id: true, nome: true },
          orderBy: { nome: "asc" },
        }),
      ]);

  const toRow = (x: any) => ({
    id: x.id,
    tipo: (ehFilme ? "filme" : (x.tipo ?? "serie")) as "filme" | "serie" | "anime" | "desenho",
    titulo: x.titulo,
    poster: x.poster ?? null,
    background: x.background ?? null,
    logo: x.logo ?? null,
    ano: x.ano ?? null,
    nota: x.nota ?? null,
  });

  const generos = groupGenres(generosRaw);
  const h1 = ehFilme ? "Filmes no Obaflix" : "Séries no Obaflix";
  const intro = ehFilme
    ? "Explore filmes, sinopses, gêneros e informações do catálogo Obaflix. Para assistir, baixe o aplicativo."
    : "Explore séries, temporadas, episódios, gêneros e informações do catálogo Obaflix. Para assistir, baixe o aplicativo.";

  return (
    <div className="min-h-screen pb-12 pt-20">
      <header className="px-4 md:px-14">
        <h1 className="text-2xl font-black tracking-tight text-white sm:text-3xl">{h1}</h1>
        <p className="mt-2 max-w-2xl text-sm leading-relaxed text-zinc-400 md:text-[15px]">{intro}</p>
      </header>

      <div className="mt-4">
        {emAlta.length > 0 && (
          <LandscapeRow titulo={ehFilme ? "Filmes em alta" : "Séries em alta"} items={emAlta.map(toRow)} />
        )}
        {avaliados.length > 0 && (
          <LandscapeRow
            titulo={ehFilme ? "Mais bem avaliados" : "Mais bem avaliadas"}
            items={avaliados.map(toRow)}
          />
        )}
      </div>

      {generos.length > 0 && (
        <section aria-labelledby="generos-heading" className="px-4 pt-6 md:px-14">
          <h2 id="generos-heading" className="text-lg font-bold text-white md:text-xl">
            Gêneros
          </h2>
          <div className="mt-3 flex flex-wrap gap-2">
            {generos.map((g) => (
              <Link
                key={g.id}
                href={genrePath(g.id, g.nome)}
                className="rounded-full border border-white/10 bg-white/[0.07] px-3 py-1.5 text-sm text-zinc-300 transition-colors hover:border-white/30 hover:bg-white/15 hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red-500"
              >
                {g.nome}
              </Link>
            ))}
          </div>
        </section>
      )}

      <SecaoDownloads
        android={INSTALADORES.android}
        androidTv={INSTALADORES.androidTv}
        windows={INSTALADORES.windows}
      />
    </div>
  );
}
