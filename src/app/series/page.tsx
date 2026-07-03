import { HeroSlider } from "@/components/ui/HeroSlider";
import { LandscapeRow } from "@/components/ui/LandscapeRow";
import { ContinuarAssistindo } from "@/components/ui/ContinuarAssistindo";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

const NEW_MS = 3 * 24 * 60 * 60 * 1000;

const sel = {
  id: true, titulo: true, poster: true, background: true, logo: true,
  sinopse: true, ano: true, nota: true, tipo: true, createdAt: true,
} as const;

const selHero = { id: true, titulo: true, sinopse: true, background: true } as const;

function toCard(s: any) {
  return {
    id: s.id,
    tipo: (s.tipo ?? "serie") as "serie" | "anime" | "desenho",
    titulo: s.titulo,
    poster: s.poster ?? null,
    background: s.background ?? null,
    logo: s.logo ?? null,
    ano: s.ano ?? null,
    nota: s.nota ?? null,
    isNew: s.createdAt ? Date.now() - new Date(s.createdAt).getTime() < NEW_MS : false,
  };
}

export default async function SeriesPage() {
  // "Mais Populares": séries mais assistidas no histórico dos usuários.
  // Fallback para nota DESC quando há poucos registros (plataforma nova).
  const popularHistRaw = await prisma.watchHistory.groupBy({
    by: ["conteudoId"],
    where: { conteudoTipo: "serie" },
    _count: { id: true },
    orderBy: { _count: { id: "desc" } },
    take: 48,
  });
  const popularIds = popularHistRaw.map((p) => p.conteudoId);
  let populares: any[];
  if (popularIds.length >= 6) {
    const byId = await prisma.serie.findMany({
      where: { id: { in: popularIds }, tipo: "serie" },
      select: sel,
    });
    const idxMap = Object.fromEntries(popularIds.map((id, i) => [id, i]));
    populares = byId.sort((a: any, b: any) => (idxMap[a.id] ?? 999) - (idxMap[b.id] ?? 999));
  } else {
    populares = await prisma.serie.findMany({
      where: { tipo: "serie" },
      orderBy: [{ nota: "desc" }, { createdAt: "desc" }],
      take: 24,
      select: sel,
    });
  }

  const [heroRaw, recentes, avaliadas, drama, crime, comedia, misterio, ficcao, terror, romance, acao] =
    await Promise.all([
      prisma.serie.findMany({ where: { tipo: "serie", background: { not: null } }, orderBy: { nota: "desc" }, take: 8, select: selHero }),
      prisma.serie.findMany({ where: { tipo: "serie" }, orderBy: { createdAt: "desc" }, take: 24, select: sel }),
      prisma.serie.findMany({ where: { tipo: "serie" }, orderBy: { nota: "desc" }, take: 24, select: sel }),
      prisma.serie.findMany({ where: { tipo: "serie", generos: { some: { generoId: 18 } } }, orderBy: { nota: "desc" }, take: 24, select: sel }),
      prisma.serie.findMany({ where: { tipo: "serie", generos: { some: { generoId: 80 } } }, orderBy: { nota: "desc" }, take: 24, select: sel }),
      prisma.serie.findMany({ where: { tipo: "serie", generos: { some: { generoId: 35 } } }, orderBy: { nota: "desc" }, take: 24, select: sel }),
      prisma.serie.findMany({ where: { tipo: "serie", generos: { some: { generoId: 9648 } } }, orderBy: { nota: "desc" }, take: 24, select: sel }),
      prisma.serie.findMany({ where: { tipo: "serie", generos: { some: { generoId: 10765 } } }, orderBy: { nota: "desc" }, take: 24, select: sel }),
      prisma.serie.findMany({ where: { tipo: "serie", generos: { some: { generoId: 27 } } }, orderBy: { nota: "desc" }, take: 24, select: sel }),
      prisma.serie.findMany({ where: { tipo: "serie", generos: { some: { generoId: 10749 } } }, orderBy: { nota: "desc" }, take: 24, select: sel }),
      prisma.serie.findMany({ where: { tipo: "serie", generos: { some: { generoId: 10759 } } }, orderBy: { nota: "desc" }, take: 24, select: sel }),
    ]);

  const heroItems = heroRaw.map((s) => ({
    id: s.id, tipo: "serie" as const,
    titulo: s.titulo, sinopse: s.sinopse ?? null,
    background: s.background!, trailerKey: null,
  }));

  return (
    <div className="min-h-screen pb-12">
      {heroItems.length > 0 && <HeroSlider items={heroItems} />}

      <div className={`mt-3 ${!heroItems.length ? "pt-20" : ""}`}>
        <ContinuarAssistindo />
        {recentes.length > 0   && <LandscapeRow titulo="Adicionadas Recentemente" items={recentes.map(toCard)}   />}
        {populares.length > 0  && <LandscapeRow titulo="Mais Populares"           items={populares.map(toCard)}  />}
        {avaliadas.length > 0  && <LandscapeRow titulo="Mais Bem Avaliadas"       items={avaliadas.map(toCard)}  />}
        {drama.length > 0     && <LandscapeRow titulo="Drama"                    items={drama.map(toCard)}    verTodosHref="/genero/18" />}
        {crime.length > 0     && <LandscapeRow titulo="Crime"                    items={crime.map(toCard)}    verTodosHref="/genero/80" />}
        {comedia.length > 0   && <LandscapeRow titulo="Comédia"                  items={comedia.map(toCard)}  verTodosHref="/genero/35" />}
        {misterio.length > 0  && <LandscapeRow titulo="Mistério"                 items={misterio.map(toCard)} verTodosHref="/genero/9648" />}
        {ficcao.length > 0    && <LandscapeRow titulo="Ficção Científica"        items={ficcao.map(toCard)}   verTodosHref="/genero/10765" />}
        {terror.length > 0    && <LandscapeRow titulo="Terror"                   items={terror.map(toCard)}   verTodosHref="/genero/27" />}
        {romance.length > 0   && <LandscapeRow titulo="Romance"                  items={romance.map(toCard)}  verTodosHref="/genero/10749" />}
        {acao.length > 0      && <LandscapeRow titulo="Ação & Aventura"          items={acao.map(toCard)}     verTodosHref="/genero/10759" />}
      </div>
    </div>
  );
}
