import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * Fase Velocidade 1A.1 — robustez do endpoint de metadata de temporada.
 *
 * Travas de fonte (o handler precisa de Prisma + TMDB para rodar): validação
 * local da temporada, 503 não-cacheável em falha transitória e retry no cliente.
 */
const ler = (p: string) => readFileSync(p, "utf8");
const semBloco = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "");
const endpoint = () => ler("src/app/api/series/[id]/temporada/[temporada]/route.ts");
const grid = () => ler("src/app/serie/[id]/EpisodeGrid.tsx");

// ── 1. Temporada precisa existir localmente, antes de tocar no TMDB ───────────

test("valida existência local da temporada numa única consulta (episodios.some.temporada)", () => {
  const src = endpoint();
  assert.match(src, /episodios: \{ some: \{ temporada \} \}/);
  assert.match(src, /findFirst\(/);
  // Só tmdbId sai do banco.
  assert.match(src, /select: \{ tmdbId: true \}/);
  // Uma consulta de série só (sem COUNT, sem segunda consulta).
  const consultas = src.match(/prisma\.serie\.(findFirst|findUnique|count|findMany)/g) ?? [];
  assert.equal(consultas.length, 1);
  assert.doesNotMatch(src, /\.count\(/);
});

test("temporada inexistente localmente NÃO chega ao TMDB (checagem antes do fetch)", () => {
  const src = endpoint();
  const idxCheck = src.indexOf("episodios: { some: { temporada } }");
  const idxGuardFail = src.indexOf("if (!serie)");
  const idxTmdb = src.indexOf("getTVSeasonDetails(");
  assert.ok(idxCheck >= 0 && idxGuardFail > idxCheck, "guard 404 depois da consulta");
  assert.ok(idxTmdb > idxGuardFail, "getTVSeasonDetails só depois do guard 404");
});

test("série/temporada inexistente responde 404", () => {
  assert.match(endpoint(), /if \(!serie\) return NextResponse\.json\(\{ error: "Não encontrado" \}, \{ status: 404 \}\)/);
});

// ── 2. tmdbId ausente vs falha transitória do TMDB ───────────────────────────

test("tmdbId ausente ⇒ 200 com mapas vazios (cache público, ausência legítima)", () => {
  const src = endpoint();
  assert.match(src, /if \(!serie\.tmdbId\) \{/);
  // devolve extrairMetadataEpisodios([null]) com cache de sucesso.
  assert.match(src, /extrairMetadataEpisodios\(\[null\]\)/);
});

test("tmdbId presente + TMDB null ⇒ 503 genérico, sem cache de 24h", () => {
  const src = endpoint();
  // Isola o bloco do 503 para checar headers.
  const m = src.match(/if \(!details\) \{[\s\S]*?\n  \}/);
  assert.ok(m, "bloco do 503 não encontrado");
  const bloco = m![0];
  assert.match(bloco, /status: 503/);
  assert.match(bloco, /"Cache-Control": "no-store"/);
  assert.match(bloco, /Retry-After/);
  assert.match(bloco, /Metadata temporariamente indisponível/);
  // 503 não pode ser cacheável por 24h.
  assert.doesNotMatch(bloco, /s-maxage/);
});

test("sucesso continua cache público s-maxage=86400", () => {
  const src = endpoint();
  const m = src.match(/const maps = extrairMetadataEpisodios\(\[details\]\)[\s\S]*?\n\}/);
  assert.ok(m, "bloco de sucesso não encontrado");
  assert.match(m![0], /Cache-Control.*public, s-maxage=86400/);
});

// ── 3. Cliente pode tentar de novo após resposta não-OK ──────────────────────

test("EpisodeGrid trata resposta não-OK como erro (throw), não como null", () => {
  const src = grid();
  assert.match(src, /if \(!r\.ok\) throw new Error/);
});

test("em erro, remove a temporada de temporadasCarregadas para permitir retry", () => {
  const src = grid();
  const idxCatch = src.indexOf(".catch(");
  const idxDelete = src.indexOf("temporadasCarregadas.current.delete(temp)", idxCatch);
  assert.ok(idxCatch >= 0 && idxDelete > idxCatch, "delete(temp) deve estar no catch");
});

// ── Segurança: nada de provider/token/URL de mídia ───────────────────────────

test("endpoint não expõe provider/token/urlDub/urlLeg/URL de mídia no código", () => {
  const src = semBloco(endpoint());
  assert.doesNotMatch(src, /urlDub|urlLeg|provider|token|authorization|getServerSession/i);
  // Corpos de erro são genéricos, sem nome de provider/TMDB nem detalhe técnico.
  const errosJson = src.match(/error: "[^"]*"/g) ?? [];
  assert.ok(errosJson.length >= 3, "deve haver mensagens de erro genéricas");
  for (const e of errosJson) {
    assert.doesNotMatch(e, /tmdb|themoviedb|provider|token/i);
  }
});
