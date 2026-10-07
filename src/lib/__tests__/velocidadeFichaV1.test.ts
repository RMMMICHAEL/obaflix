import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { extrairMetadataEpisodios } from "@/lib/tmdbEpisodios";

/**
 * Fase Velocidade 1A — ficha de série utilizável mais cedo.
 *
 * O extrator de metadata é testado de verdade (função pura). As decisões que
 * dependeriam de banco/TMDB/render (caminho crítico, Suspense, não-vazamento de
 * URL, endpoint sob demanda) são travadas por asserção de fonte, mesmo padrão
 * dos testes de SEO/android já existentes.
 */
const ler = (p: string) => readFileSync(p, "utf8");
/** Remove comentários de bloco: as travas de não-vazamento valem para o código,
 *  não para doc-comments que legitimamente citam urlDub/provider/token. */
const semBloco = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "");
const page = () => ler("src/app/serie/[id]/page.tsx");
const grid = () => ler("src/app/serie/[id]/EpisodeGrid.tsx");
const secundario = () => ler("src/app/serie/[id]/SerieSecundario.tsx");
const endpoint = () => ler("src/app/api/series/[id]/temporada/[temporada]/route.ts");

// ── 4. Temporadas: nada de all-seasons no render inicial ─────────────────────

test("não há mais Promise.all sobre TODAS as temporadas no render inicial", () => {
  const src = page();
  assert.doesNotMatch(src, /temporadas\.map\(\(t\) => getTVSeasonDetails/);
  assert.doesNotMatch(src, /Promise\.all\(temporadas\.map/);
  // Só a primeira temporada entra no caminho crítico.
  assert.match(src, /getTVSeasonDetails\(serie\.tmdbId, initialSeason\)/);
  assert.match(src, /const initialSeason = temporadas\[0\]/);
});

test("troca de temporada busca metadata sob demanda num endpoint público", () => {
  assert.match(grid(), /fetch\(`\/api\/series\/\$\{serieId\}\/temporada\/\$\{temp\}`/);
});

// ── 7. Metadata por episódio preservada (overview/runtime/thumbnail/rating) ──

test("extrairMetadataEpisodios mantém overview, runtime, thumbnail e nota", () => {
  const season = {
    season_number: 2,
    episodes: [
      { season_number: 2, episode_number: 1, overview: "  Piloto da T2.  ", runtime: 48, still_path: "/a.jpg", vote_average: 8.3, vote_count: 10 },
      { season_number: 2, episode_number: 2, overview: "", runtime: null, still_path: null, vote_average: 0, vote_count: 0 },
    ],
  } as any;
  const { ratingMap, metadataMap } = extrairMetadataEpisodios([season]);

  assert.equal(ratingMap["2_1"], 8.3);
  assert.equal(ratingMap["2_2"], undefined, "nota 0 não entra");
  assert.deepEqual(metadataMap["2_1"], { overview: "Piloto da T2.", runtime: 48, thumbnail: "/a.jpg" });
  assert.deepEqual(metadataMap["2_2"], { overview: null, runtime: null, thumbnail: null });
});

test("extrairMetadataEpisodios é seguro com temporada ausente/sem episódios", () => {
  assert.deepEqual(extrairMetadataEpisodios([null]), { ratingMap: {}, metadataMap: {} });
  assert.deepEqual(extrairMetadataEpisodios([{ season_number: 1 } as any]), {
    ratingMap: {},
    metadataMap: {},
  });
});

// ── 3. urlDub/urlLeg nunca atravessam para o cliente ─────────────────────────

test("a página descarta urlDub/urlLeg antes do payload público dos episódios", () => {
  assert.match(page(), /episodios\.map\(\(\{ urlDub, urlLeg, \.\.\.ep \}\)/);
});

test("nem a grade, nem os componentes secundários, nem o endpoint conhecem URL de mídia", () => {
  assert.doesNotMatch(semBloco(grid()), /urlDub|urlLeg/);
  assert.doesNotMatch(semBloco(secundario()), /urlDub|urlLeg/);
  assert.doesNotMatch(semBloco(endpoint()), /urlDub|urlLeg/);
});

// ── 2. Conteúdo essencial vem dos dados locais ───────────────────────────────

test("hero/assistir/episódios saem dos dados locais (Prisma), sem depender de TMDB secundário", () => {
  const src = page();
  assert.match(src, /prisma\.episodio\.findMany/);
  assert.match(src, /const temporadas = Array\.from\(new Set\(episodios\.map/);
  assert.match(src, /const primeiroEp = episodios\[0\]/);
  assert.match(src, /const watchHref = primeiroEp/);
  // Elenco/direção/recomendações saíram do caminho crítico da página.
  assert.doesNotMatch(src, /getTVCredits|getTVRecommendations/);
});

// ── 2/2. Imagens só quando falta arte local; fallback preservado ─────────────

test("getTVImages só quando falta backdrop OU logo local; fallback preservado", () => {
  const src = page();
  assert.match(src, /const precisaImagens = !serie\.background \|\| !serie\.logo/);
  assert.match(src, /precisaImagens && serie\.tmdbId \? getTVImages\(serie\.tmdbId\) : null/);
  assert.match(src, /serie\.logo \?\? pickLogo\(images\)/);
  assert.match(src, /serie\.background \?\? pickHeroBackdrop\(images\)/);
});

test("fallback de thumbnail do episódio continua (local → metadata TMDB)", () => {
  assert.match(grid(), /ep\.thumbnail \?\? metadata\?\.thumbnail/);
});

// ── 3/5/6. Secundário deferido via Suspense, mas presente ────────────────────

test("elenco, recomendações e JSON-LD da série ficam em <Suspense>, sem bloquear", () => {
  const src = page();
  assert.match(src, /import \{ Suspense \} from "react"/);
  assert.match(src, /<Suspense fallback=\{null\}>\s*<SerieCreditos/);
  assert.match(src, /<Suspense fallback=\{null\}>\s*<SerieRecomendacoes/);
});

test("PeopleRow (elenco/direção) continua existindo no bloco secundário", () => {
  const src = secundario();
  assert.match(src, /title="Criação e direção"/);
  assert.match(src, /title="Elenco principal"/);
  const peopleRows = src.match(/<PeopleRow/g) ?? [];
  assert.equal(peopleRows.length, 2);
});

test("'Conteúdos parecidos' continua existindo no bloco secundário", () => {
  const src = secundario();
  assert.match(src, /Conteúdos parecidos com \$\{serieTitulo\}/);
  assert.match(src, /<LandscapeRow/);
});

// ── 9. SEO existente não regride ─────────────────────────────────────────────

test("JSON-LD preservado: breadcrumb crítico + TVSeries (com actor) no secundário", () => {
  assert.match(page(), /<JsonLd data=\{breadcrumbSchema\} \/>/);
  const src = secundario();
  assert.match(src, /"@type": "TVSeries"/);
  assert.match(src, /actor: cast\.map\(\(person\) => \(\{ "@type": "Person", name: person\.name \}\)\)/);
});

test("metadata/canonical/H1/FichaSeoExtra da série preservados", () => {
  const src = page();
  assert.match(src, /title: tituloFicha\("serie", serie\.titulo\)/);
  assert.match(src, /path: catalogPath\("serie", id, serie\.titulo\)/);
  assert.match(src, /heading=\{`Assistir \$\{serie\.titulo\} online`\}/);
  assert.match(src, /dub=\{temDub\} leg=\{temLeg\}/);
});

// ── 8. Ações Android presentes/inalteradas ───────────────────────────────────

test("AndroidEpisodeActions segue na grade, fora do <Link>", () => {
  const src = grid();
  const fimDoLink = src.lastIndexOf("</Link>");
  const acoes = src.indexOf("<AndroidEpisodeActions");
  assert.ok(acoes > 0 && fimDoLink > 0 && acoes > fimDoLink);
});

test("AndroidHeroActions segue presente no MediaHero (hero intocado)", () => {
  assert.match(ler("src/components/ui/MediaHero.tsx"), /<AndroidHeroActions/);
});

// ── Endpoint sob demanda: seguro e de metadata pública ───────────────────────

test("endpoint de temporada valida entrada, só lê tmdbId e é cache público", () => {
  const src = endpoint();
  assert.match(src, /Number\.isInteger\(temporada\)/);
  assert.match(src, /temporada < 0 \|\| temporada > TEMPORADA_MAX/);
  assert.match(src, /select: \{ tmdbId: true \}/);
  assert.match(src, /extrairMetadataEpisodios\(\[details\]\)/);
  assert.match(src, /Cache-Control.*public, s-maxage=/);
  // Nada de provider/token/sessão no código do handler.
  assert.doesNotMatch(semBloco(src), /provider|token|authorization|getServerSession/i);
});
