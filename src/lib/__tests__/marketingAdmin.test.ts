import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { NextRequest } from "next/server";
import { aggregateDownloadMetrics, type MetricRow } from "../marketing/landing-metrics";
import { handleDownloadMetrics } from "../marketing/download-metrics-handler";

const NOW = Date.parse("2026-10-08T12:00:00Z");
const source = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

const ROWS: MetricRow[] = [
  { day: "2026-10-08", event: "landing_view", context: "in_app", placement: "page", source: "tiktok", medium: "promote", campaign: "android_outubro", content: "video01", count: 100 },
  { day: "2026-10-08", event: "open_external_browser_click", context: "in_app", placement: "hero", source: "tiktok", medium: "promote", campaign: "android_outubro", content: "video01", count: 60 },
  { day: "2026-10-08", event: "landing_view", context: "browser", placement: "page", source: "tiktok", medium: "promote", campaign: "android_outubro", content: "video01", count: 55 },
  { day: "2026-10-08", event: "android_download_click", context: "browser", placement: "hero", source: "tiktok", medium: "promote", campaign: "android_outubro", content: "video01", count: 40 },
  { day: "2026-10-07", event: "landing_view", context: "in_app", placement: "page", source: "tiktok", medium: "promote", campaign: "android_outubro", content: "video02", count: 20 },
];

test("aggregateDownloadMetrics soma o funil, taxas e agrupa por campanha", () => {
  const r = aggregateDownloadMetrics(ROWS, 7, NOW);
  assert.deepEqual(r.summary, { inAppViews: 120, openBrowserClicks: 60, browserViews: 55, downloadClicks: 40 });
  assert.equal(r.rates.openBrowserRate, 60 / 120);
  assert.equal(r.rates.downloadClickRate, 40 / 55);
  assert.equal(r.rates.inAppToDownloadRate, 40 / 120);
  // janela de 7 dias, contínua
  assert.equal(r.series.length, 7);
  assert.equal(r.window.from, "2026-10-02");
  assert.equal(r.window.to, "2026-10-08");
  // Série é por dia: 10-08 tem 100 views in_app (as outras 20 são de 10-07).
  assert.deepEqual(r.series.find((d) => d.day === "2026-10-08"), { day: "2026-10-08", inAppViews: 100, downloadClicks: 40 });
  assert.deepEqual(r.series.find((d) => d.day === "2026-10-07"), { day: "2026-10-07", inAppViews: 20, downloadClicks: 0 });
  // campanhas: v1 (com download) antes de v2
  assert.equal(r.campaigns.length, 2);
  assert.equal(r.campaigns[0].content, "video01");
  assert.deepEqual(r.campaigns[0], { source: "tiktok", medium: "promote", campaign: "android_outubro", content: "video01", inApp: 100, openBrowser: 60, browser: 55, download: 40 });
  assert.equal(r.campaigns[1].inApp, 20);
});

test("divisor zero vira null (admin mostra —)", () => {
  const r = aggregateDownloadMetrics([], 7, NOW);
  assert.deepEqual(r.summary, { inAppViews: 0, openBrowserClicks: 0, browserViews: 0, downloadClicks: 0 });
  assert.equal(r.rates.openBrowserRate, null);
  assert.equal(r.rates.downloadClickRate, null);
  assert.equal(r.rates.inAppToDownloadRate, null);
  assert.equal(r.campaigns.length, 0);
});

test("resposta do admin não fala em instalação", () => {
  const r = aggregateDownloadMetrics(ROWS, 7, NOW);
  assert.doesNotMatch(JSON.stringify(r), /install|instala/i);
});

function get(days: string): NextRequest {
  return new Request(`https://obaflixbr.com/api/admin/marketing/download-metrics?days=${days}`) as unknown as NextRequest;
}
const admin = async () => null;
const denied = async () => new Response(JSON.stringify({ error: "x" }), { status: 403 });

test("admin: não autenticado/não admin é bloqueado e não lê o banco", async () => {
  let leu = false;
  const res = await handleDownloadMetrics(get("7"), { requireAdmin: denied, loadRows: async () => { leu = true; return []; } });
  assert.equal(res.status, 403);
  assert.equal(leu, false);
});

test("admin: days só aceita 1, 7, 30", async () => {
  for (const d of ["1", "7", "30"]) {
    const res = await handleDownloadMetrics(get(d), { requireAdmin: admin, loadRows: async () => [], now: NOW });
    assert.equal(res.status, 200, d);
  }
  for (const d of ["5", "0", "-7", "abc", "7.5", "", "365"]) {
    const res = await handleDownloadMetrics(get(d), { requireAdmin: admin, loadRows: async () => [] });
    assert.equal(res.status, 400, d);
  }
});

test("admin: com sessão admin devolve o relatório agregado", async () => {
  const res = await handleDownloadMetrics(get("7"), { requireAdmin: admin, loadRows: async () => ROWS, now: NOW });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.summary.downloadClicks, 40);
  assert.equal(body.campaigns[0].content, "video01");
  assert.doesNotMatch(JSON.stringify(body), /install/i);
});

test("privacidade reflete a medição first-party sem terceiros", () => {
  const page = source("app/privacidade/page.tsx");
  assert.match(page, /force-static/);
  assert.match(page, /first-party/i);
  assert.match(page, /TikTok Pixel/);
  assert.match(page, /utm_source/);
  assert.match(page, /não.*instalad/i);
  assert.match(page, /sem identificador de conta ou de visitante/i);
  // continua sem prometer anonimato absoluto
  assert.doesNotMatch(page, /100% an[oô]nimo/i);
});
