import assert from "node:assert/strict";
import test from "node:test";
import { sanitizeErrorSummary, summarizeSyncSources, SYNC_SOURCES } from "../sync-sources";

const now = new Date("2026-09-28T15:00:00.000Z");
const run = (source: string, job: string, status: string, hoursAgo: number, extra: Record<string, unknown> = {}) => ({
  id: `${source}-${hoursAgo}`, source, job, status,
  startedAt: new Date(now.getTime() - hoursAgo * 3600000),
  finishedAt: new Date(now.getTime() - hoursAgo * 3600000),
  ...extra,
});

test("fonte sem telemetria aparece como tal, sem execução inventada nem atraso", () => {
  const { fontes, outras } = summarizeSyncSources([], now);
  assert.equal(fontes.length, SYNC_SOURCES.length);
  for (const f of fontes) {
    assert.equal(f.telemetria, false, f.id);
    assert.equal(f.ultima, null);
    assert.equal(f.ultimoSucessoEm, null);
    assert.equal(f.atrasada, false);
  }
  assert.deepEqual(outras, []);
});

test("job de 5h alerta só após 10h sem sucesso; falhas recentes não escondem o atraso", () => {
  const ok = summarizeSyncSources([run("megaflix-local", "ciclo", "SUCCESS", 9.9)], now).fontes.find((f) => f.id === "megaflix-local")!;
  assert.equal(ok.atrasada, false);
  const late = summarizeSyncSources([
    run("megaflix-local", "ciclo", "FAILED", 1),
    run("megaflix-local", "ciclo", "FAILED", 6),
    run("megaflix-local", "ciclo", "SUCCESS", 11),
  ], now).fontes.find((f) => f.id === "megaflix-local")!;
  assert.equal(late.ultima?.status, "FAILED");
  assert.equal(late.atrasada, true);
  assert.equal(late.horasSemSucesso, 11);
  const never = summarizeSyncSources([run("webcine-local", "ciclo", "FAILED", 1)], now).fontes.find((f) => f.id === "webcine-local")!;
  assert.equal(never.atrasada, true);
});

test("métrica legada do popular-sync fica em linha própria; fonte desconhecida vai para 'outras'", () => {
  const { fontes, outras } = summarizeSyncSources([
    run("tmdb", "popular-sync", "FAILED", 2, { legacy: true }),
    run("nova-fonte", "x", "SUCCESS", 1),
  ], now);
  // Métrica legada não é atribuída a local nem a Vercel.
  assert.equal(fontes.find((f) => f.id === "tmdb-popular-legado")?.ultima?.status, "FAILED");
  assert.equal(fontes.find((f) => f.id === "tmdb-popular-local")?.telemetria, false);
  assert.equal(fontes.find((f) => f.id === "tmdb-popular-vercel")?.telemetria, false);
  assert.deepEqual(outras.map((o) => o.source), ["nova-fonte"]);
  assert.equal(fontes.find((f) => f.id === "importacao-manual")!.frequenciaHoras, null);
});

test("resumo de erro remove URLs e segredos de query", () => {
  const s = sanitizeErrorSummary("fetch failed https://api.themoviedb.org/3/x?api_key=abc123 token=zzz e rtmp://h/s");
  assert.ok(s);
  assert.doesNotMatch(s!, /themoviedb|abc123|zzz|rtmp:\/\//);
  assert.equal(sanitizeErrorSummary(42), null);
  assert.equal(sanitizeErrorSummary("x".repeat(900))!.length, 500);
});

test("execuções local e Vercel do mesmo job aparecem separadas", () => {
  const { fontes } = summarizeSyncSources([
    run("tmdb-popular-local", "popular-sync", "FAILED", 1),
    run("tmdb-popular-vercel", "popular-sync", "SUCCESS", 3),
  ], now);
  assert.equal(fontes.find((f) => f.id === "tmdb-popular-local")?.ultima?.status, "FAILED");
  assert.equal(fontes.find((f) => f.id === "tmdb-popular-vercel")?.ultima?.status, "SUCCESS");
});
