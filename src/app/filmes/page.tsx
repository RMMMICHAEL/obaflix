import { HeroSlider } from "@/components/ui/HeroSlider";
import { LandscapeRow } from "@/components/ui/LandscapeRow";
import { ContinuarAssistindo } from "@/components/ui/ContinuarAssistindo";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

const NEW_MS = 3 * 24 * 60 * 60 * 1000;

const sel = {
  id: true, titulo: true, poster: true, background: true, logo: true,
  sinopse: true, ano: true, nota: true, urlDub: true, urlLeg: true, createdAt: true,
} as const;

const selHero = { id: true, titulo: true, sinopse: true, background: true } as const;

function toCard(f: any) {
  return {
    id: f.id, tipo: "filme" as const, titulo: f.titulo,
    poster: f.poster ?? null, background: f.background ?? null,
    logo: f.logo ?? null,
    ano: f.ano ?? null, nota: f.nota ?? null,
    urlDub: f.urlDub ?? null, urlLeg: f.urlLeg ?? null,
    isNew: f.createdAt ? Date.now() - new Date(f.createdAt).getTime() < NEW_MS : false,
  };
}

export default async function FilmesPage() {
  const [heroRaw, recentes, avaliados, acao, comedia, terror, ficcao, drama, crime, thriller, aventura] =
    await Promise.all([
      prisma.filme.findMany({ where: { background: { not: null } }, orderBy: { nota: "desc" }, take: 8, select: selHero }),
      prisma.filme.findMany({ orderBy: { createdAt: "desc" }, take: 24, select: sel }),
      prisma.filme.findMany({ orderBy: { nota: "desc" }, take: 24, select: sel }),
      prisma.filme.findMany({ where: { generos: { some: { generoId: 28 } } }, orderBy: { nota: "desc" }, take: 24, select: sel }),
      prisma.filme.findMany({ where: { generos: { some: { generoId: 35 } } }, orderBy: { nota: "desc" }, take: 24, select: sel }),
      prisma.filme.findMany({ where: { generos: { some: { generoId: 27 } } }, orderBy: { nota: "desc" }, take: 24, select: sel }),
      prisma.filme.findMany({ where: { generos: { some: { generoId: 878 } } }, orderBy: { nota: "desc" }, take: 24, select: sel }),
      prisma.filme.findMany({ where: { generos: { some: { generoId: 18 } } }, orderBy: { nota: "desc" }, take: 24, select: sel }),
      prisma.filme.findMany({ where: { generos: { some: { generoId: 80 } } }, orderBy: { nota: "desc" }, take: 24, select: sel }),
      prisma.filme.findMany({ where: { generos: { some: { generoId: 53 } } }, orderBy: { nota: "desc" }, take: 24, select: sel }),
      prisma.filme.findMany({ where: { generos: { some: { generoId: 12 } } }, orderBy: { nota: "desc" }, take: 24, select: sel }),
    ]);

  const heroItems = heroRaw.map((f) => ({
    id: f.id, tipo: "filme" as const,
    titulo: f.titulo, sinopse: f.sinopse ?? null,
    background: f.background!, trailerKey: null,
  }));

  return (
    <div className="min-h-screen pb-12">
      {heroItems.length > 0 && <HeroSlider items={heroItems} />}

      <div className={`mt-3 ${!heroItems.length ? "pt-20" : ""}`}>
        <ContinuarAssistindo />
        {recentes.length > 0  && <LandscapeRow titulo="Adicionados Recentemente" items={recentes.map(toCard)} />}
        {avaliados.length > 0 && <LandscapeRow titulo="Mais Bem Avaliados"       items={avaliados.map(toCard)} />}
        {acao.length > 0      && <LandscapeRow titulo="Ação"                     items={acao.map(toCard)}      verTodosHref="/genero/28" />}
        {comedia.length > 0   && <LandscapeRow titulo="Comédia"                  items={comedia.map(toCard)}   verTodosHref="/genero/35" />}
        {terror.length > 0    && <LandscapeRow titulo="Terror"                   items={terror.map(toCard)}    verTodosHref="/genero/27" />}
        {ficcao.length > 0    && <LandscapeRow titulo="Ficção Científica"        items={ficcao.map(toCard)}    verTodosHref="/genero/878" />}
        {drama.length > 0     && <LandscapeRow titulo="Drama"                    items={drama.map(toCard)}     verTodosHref="/genero/18" />}
        {crime.length > 0     && <LandscapeRow titulo="Crime"                    items={crime.map(toCard)}     verTodosHref="/genero/80" />}
        {thriller.length > 0  && <LandscapeRow titulo="Thriller"                 items={thriller.map(toCard)}  verTodosHref="/genero/53" />}
        {aventura.length > 0  && <LandscapeRow titulo="Aventura"                 items={aventura.map(toCard)}  verTodosHref="/genero/12" />}
      </div>
    </div>
  );
}
