import { HeroSlider } from "@/components/ui/HeroSlider";
import { LandscapeRow } from "@/components/ui/LandscapeRow";
import { ContinuarAssistindo } from "@/components/ui/ContinuarAssistindo";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

const NEW_MS = 3 * 24 * 60 * 60 * 1000;

const sel = {
  id: true, titulo: true, poster: true, background: true, logo: true,
  sinopse: true, ano: true, nota: true, createdAt: true,
} as const;

const selHero = { id: true, titulo: true, sinopse: true, background: true } as const;

function toCard(s: any) {
  return {
    id: s.id, tipo: "desenho" as const, titulo: s.titulo,
    poster: s.poster ?? null, background: s.background ?? null,
    logo: s.logo ?? null,
    ano: s.ano ?? null, nota: s.nota ?? null,
    isNew: s.createdAt ? Date.now() - new Date(s.createdAt).getTime() < NEW_MS : false,
  };
}

export default async function DesenhoPage() {
  const [heroRaw, avaliados, recentes, acao, aventura, comedia, familia, animacao] =
    await Promise.all([
      prisma.serie.findMany({ where: { tipo: "desenho", background: { not: null } }, orderBy: { nota: "desc" }, take: 8, select: selHero }),
      prisma.serie.findMany({ where: { tipo: "desenho" }, orderBy: { nota: "desc" }, take: 24, select: sel }),
      prisma.serie.findMany({ where: { tipo: "desenho" }, orderBy: { createdAt: "desc" }, take: 24, select: sel }),
      prisma.serie.findMany({ where: { tipo: "desenho", generos: { some: { generoId: 28 } } }, orderBy: { nota: "desc" }, take: 24, select: sel }),
      prisma.serie.findMany({ where: { tipo: "desenho", generos: { some: { generoId: 12 } } }, orderBy: { nota: "desc" }, take: 24, select: sel }),
      prisma.serie.findMany({ where: { tipo: "desenho", generos: { some: { generoId: 35 } } }, orderBy: { nota: "desc" }, take: 24, select: sel }),
      prisma.serie.findMany({ where: { tipo: "desenho", generos: { some: { generoId: 10751 } } }, orderBy: { nota: "desc" }, take: 24, select: sel }),
      prisma.serie.findMany({ where: { tipo: "desenho", generos: { some: { generoId: 16 } } }, orderBy: { nota: "desc" }, take: 24, select: sel }),
    ]);

  const heroItems = heroRaw.map((s) => ({
    id: s.id, tipo: "desenho" as const,
    titulo: s.titulo, sinopse: s.sinopse ?? null,
    background: s.background!, trailerKey: null,
  }));

  return (
    <div className="min-h-screen pb-12">
      {heroItems.length > 0 && <HeroSlider items={heroItems} />}

      <div className={`mt-3 ${!heroItems.length ? "pt-20" : ""}`}>
        <ContinuarAssistindo />
        {avaliados.length > 0 && <LandscapeRow titulo="Mais Bem Avaliados"       items={avaliados.map(toCard)} />}
        {recentes.length > 0  && <LandscapeRow titulo="Adicionados Recentemente"  items={recentes.map(toCard)} />}
        {acao.length > 0      && <LandscapeRow titulo="Ação"                      items={acao.map(toCard)}     verTodosHref="/genero/28" />}
        {aventura.length > 0  && <LandscapeRow titulo="Aventura"                  items={aventura.map(toCard)} verTodosHref="/genero/12" />}
        {comedia.length > 0   && <LandscapeRow titulo="Comédia"                   items={comedia.map(toCard)}  verTodosHref="/genero/35" />}
        {familia.length > 0   && <LandscapeRow titulo="Família"                   items={familia.map(toCard)}  verTodosHref="/genero/10751" />}
        {animacao.length > 0  && <LandscapeRow titulo="Animação"                  items={animacao.map(toCard)} verTodosHref="/genero/16" />}
      </div>
    </div>
  );
}
