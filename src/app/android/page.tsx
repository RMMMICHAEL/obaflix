import type { Metadata } from "next";
import { unstable_cache } from "next/cache";
import { prisma } from "@/lib/prisma";
import { AndroidContinueWatching } from "@/components/android/AndroidContinueWatching";
import { HeroSlider } from "@/components/ui/HeroSlider";
import { LandscapeRow } from "@/components/ui/LandscapeRow";
import { LazyRow } from "@/components/ui/LazyRow";
import { EpisodioRecenteRow, type EpisodioRecenteItem } from "@/components/ui/EpisodioRecenteRow";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { getContinueWatchingItems } from "@/lib/continue-watching";
import {
  getImdbTop250Showcases,
  getRecentSeriesEpisodes,
} from "@/lib/catalog-showcases";
import { dedupeCatalogo } from "@/lib/canonical";
import {
  BUSCA,
  NEW_EP_MS,
  POR_TRILHA,
  paraHero,
  paraTrilha,
  type TipoCard,
} from "@/lib/androidHome";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Obaflix para Android",
  description: "Catálogo Obaflix otimizado para celulares e tablets Android.",
  alternates: { canonical: "/android" },
  robots: { index: false, follow: true },
};

/**
 * `logo` estava faltando aqui, e era essa a causa de a home do app parecer
 * outro produto: o LandscapeCard desenha o logo oficial do TMDB dentro do
 * banner e so cai para texto quando ele nao existe — 74% dos filmes e 81% das
 * series do catalogo tem um. Sem a coluna no select, TODO card caia para texto.
 *
 * urlDub/urlLeg entram so como criterio de desempate entre duplicatas
 * (`pontuarRegistro`): a copia com player vence a copia sem. Elas nunca
 * atravessam `paraTrilha`, entao nao chegam ao cache nem ao HTML — a URL real
 * do provedor continua sem sair daqui.
 */
const filmSelect = {
  id: true, tmdbId: true, titulo: true, sinopse: true, poster: true, background: true,
  logo: true, ano: true, nota: true, createdAt: true, urlDub: true, urlLeg: true,
} as const;

const seriesSelect = {
  id: true, tmdbId: true, titulo: true, sinopse: true, poster: true, background: true,
  logo: true, ano: true, nota: true, tipo: true, createdAt: true,
} as const;

const ordemPopular = [
  { popularidade: { sort: "desc" as const, nulls: "last" as const } },
  { nota: "desc" as const },
];

/**
 * Catalogo da /android: identico para todo usuario, entao vive em cache
 * compartilhado em vez de ser refeito a cada visita.
 *
 * A pagina e `force-dynamic` porque checa sessao e monta "continuar
 * assistindo", mas isso nao obrigava as consultas de catalogo a rodarem junto —
 * elas nao dependem de quem esta olhando.
 *
 * As datas sao consumidas AQUI DENTRO de proposito: o unstable_cache serializa
 * o retorno em JSON, e um `Date` volta como string. Resolver `isNew` para
 * booleano antes de sair evita a armadilha; a janela e de 48h/72h, entao os 5
 * minutos de defasagem nao mudam nada.
 */
const getCatalogoAndroid = unstable_cache(
  async () => {
    const [destaques, recentes, series, animes, desenhos, imdbTop250, episodios] = await Promise.all([
      prisma.filme.findMany({
        where: { OR: [{ urlDub: { not: null } }, { urlLeg: { not: null } }] },
        orderBy: ordemPopular,
        take: 8,
        select: filmSelect,
      }),
      prisma.filme.findMany({ orderBy: { createdAt: "desc" }, take: BUSCA, select: filmSelect }),
      prisma.serie.findMany({ where: { tipo: "serie" }, orderBy: ordemPopular, take: BUSCA, select: seriesSelect }),
      prisma.serie.findMany({ where: { tipo: "anime" }, orderBy: ordemPopular, take: BUSCA, select: seriesSelect }),
      prisma.serie.findMany({ where: { tipo: "desenho" }, orderBy: ordemPopular, take: BUSCA, select: seriesSelect }),
      getImdbTop250Showcases(),
      getRecentSeriesEpisodes(),
    ]);

    const agora = Date.now();
    const episodeItems: EpisodioRecenteItem[] = episodios.slice(0, POR_TRILHA).map((episodio) => ({
      episodioId: episodio.id,
      serieId: episodio.serieId,
      titulo: episodio.titulo,
      serieTitulo: episodio.serieTitulo,
      poster: episodio.seriePoster,
      thumbnail: episodio.thumbnail,
      temporada: episodio.temporada,
      numeroEp: episodio.numeroEp,
      tipo: (episodio.serieTipo ?? "serie") as "serie" | "anime" | "desenho",
      isNovoEpisodio: agora - new Date(episodio.atualizadoEm).getTime() < NEW_EP_MS,
      dub: episodio.dub,
      leg: episodio.leg,
    }));

    // As tabelas ainda podem conter duplicatas ate o merge canonico rodar; sem
    // isto a home mostraria o mesmo titulo duas ou tres vezes na mesma fileira.
    const trilha = (linhas: any[], tipo: TipoCard) =>
      dedupeCatalogo(linhas, tipo === "filme" ? "filme" : "serie")
        .slice(0, POR_TRILHA)
        .map((linha) => paraTrilha(linha, tipo));

    // O hero ja pagava por 8 linhas e usava so a primeira — as outras 7 eram
    // buscadas e descartadas. Agora alimentam o carrossel, como no site.
    const heroItems = paraHero(dedupeCatalogo(destaques, "filme"));

    return {
      heroItems,
      movies: trilha(recentes, "filme"),
      series: trilha(series, "serie"),
      // As vitrines do Top 250 ja chegam deduplicadas de catalog-showcases.
      topMovies: imdbTop250.filmes.map((item) => paraTrilha(item, "filme")),
      topSeries: imdbTop250.series.map((item) => paraTrilha(item, "serie")),
      animeItems: trilha(animes, "anime"),
      cartoonItems: trilha(desenhos, "desenho"),
      episodeItems,
    };
  },
  // v3: a forma mudou (itens completos com `logo`, hero com varios destaques).
  // Sem trocar a chave, o cache continuaria servindo o formato antigo, sem logo.
  ["android-catalogo-v3"],
  { revalidate: 300, tags: ["android-catalogo"] },
);

export default async function AndroidHomePage() {
  const session = await getServerSession(authOptions);
  const userId = (session?.user as { id?: string } | undefined)?.id;
  if (!userId) redirect("/login?callbackUrl=%2Fandroid");

  const [catalogo, continueItems] = await Promise.all([
    getCatalogoAndroid(),
    getContinueWatchingItems(userId),
  ]);
  const {
    heroItems, movies, series, topMovies, topSeries, animeItems, cartoonItems, episodeItems,
  } = catalogo;

  if (heroItems.length === 0 && movies.length === 0 && series.length === 0) {
    return (
      <div className="android-home android-empty-state">
        <span>OBAFLIX</span>
        <h1>O catálogo está sendo preparado</h1>
        <p>Volte em alguns instantes para começar a assistir.</p>
      </div>
    );
  }

  // A home do app usa os MESMOS componentes do site. A versao anterior tinha um
  // `MediaRail` proprio e uma arte propria (`.android-poster`), que era o unico
  // lugar do projeto sem logo no card e com banner abaixo do piso de largura do
  // LandscapeCard. As outras telas do app (/filmes, /series, /animes,
  // /desenhos) sempre usaram estes componentes — era so a home que destoava.
  return (
    <div className="min-h-screen pb-12">
      {heroItems.length > 0 && <HeroSlider items={heroItems} />}

      <div className={`mt-3 ${!heroItems.length ? "pt-20" : ""}`}>
        <AndroidContinueWatching initialItems={continueItems} />

        <EpisodioRecenteRow titulo="Episódios Recentes" items={episodeItems} />
        <LandscapeRow titulo="Adicionados Recentemente" items={movies} verTodosHref="/filmes" />
        <LandscapeRow titulo="Séries para Maratonar" items={series} verTodosHref="/series" />
        <LazyRow><LandscapeRow titulo="Filmes Mais Bem Avaliados" items={topMovies} verTodosHref="/melhores" /></LazyRow>
        <LazyRow><LandscapeRow titulo="Séries Mais Bem Avaliadas" items={topSeries} verTodosHref="/melhores" /></LazyRow>
        <LazyRow><LandscapeRow titulo="Animes em Alta" items={animeItems} verTodosHref="/animes" /></LazyRow>
        <LazyRow><LandscapeRow titulo="Para Toda a Família" items={cartoonItems} verTodosHref="/desenhos" /></LazyRow>
      </div>
    </div>
  );
}
