/**
 * Sincroniza conteúdo novo do Megaflix App → Obaflix
 * Lê apenas "Últimos Filmes", "Últimas Séries" e "Episodios Recentes" do viewHome.
 * Salva memória em scripts/.sync-memory.json para não reimportar o que já foi visto.
 *
 * Uso: npx tsx scripts/sync-app.ts
 */

import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

const APP    = "https://app.megafrixapi.com/4.6.2";
const OBAFLIX = process.env.OBAFLIX_URL ?? "https://obaflix.vercel.app";
const TOKEN  = process.env.ADMIN_SECRET_TOKEN ?? "@Oba152535";
const UA     = "okhttp/4.9.3";
const DELAY  = 500;
const MEMORY_FILE = join(import.meta.dirname, ".sync-memory.json");

type Memory = {
  filmes: string[];   // IDs já importados
  series: string[];   // IDs já importados
  eps: string[];      // "serieId-TxE" já importados
};

function loadMemory(): Memory {
  if (existsSync(MEMORY_FILE)) {
    try { return JSON.parse(readFileSync(MEMORY_FILE, "utf8")); } catch { /**/ }
  }
  return { filmes: [], series: [], eps: [] };
}

function saveMemory(mem: Memory) {
  writeFileSync(MEMORY_FILE, JSON.stringify(mem, null, 2), "utf8");
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// ── Parsing do viewHome ───────────────────────────────────────────────────────

function getSection(html: string, title: string, nextTitle: string): string {
  const start = html.indexOf(title);
  if (start === -1) return "";
  const end = html.indexOf(nextTitle, start + title.length);
  return html.slice(start, end === -1 ? html.length : end);
}

function parseUltimosFilmes(html: string): string[] {
  const sec = getSection(html, "Últimos Filmes", "Últimas Séries");
  return [...sec.matchAll(/openMovie\((\d+)\)/g)].map(m => m[1]);
}

function parseUltimasSeries(html: string): string[] {
  const sec = getSection(html, "Últimas Séries", "Episodios Recentes");
  return [...sec.matchAll(/openMovie\((\d+)\)/g)].map(m => m[1]);
}

function parseEpisodiosRecentes(html: string): Array<{ serieId: string; temp: number; ep: number }> {
  const sec = getSection(html, "Episodios Recentes", "Coleções");
  return [...sec.matchAll(/openMovie\((\d+)\)[\s\S]*?class="ano">\s*(\d+)x(\d+)/g)]
    .map(m => ({ serieId: m[1], temp: Number(m[2]), ep: Number(m[3]) }));
}

// ── Parsing de item e episódios ───────────────────────────────────────────────

function parseItem(html: string) {
  const get    = (key: string) => html.match(new RegExp(`${key}:\\s*["\`]([^"\`]+)["\`]`))?.[1] ?? null;
  const getNum = (key: string) => html.match(new RegExp(`${key}:\\s*([\\d.]+)`))?.[1] ?? null;

  const id      = getNum("id");
  const tmdb    = get("tmdb");
  const poster  = get("poster")?.replace("https://d1muf25xaso8hp.cloudfront.net/", "") ?? null;
  const movie   = html.includes("movie: true");

  const titleB64 = html.match(/title:\s*atob\("([^"]+)"\)/)?.[1];
  const titleRaw = html.match(/title:\s*"([^"]+)"/)?.[1];
  const title    = titleB64 ? Buffer.from(titleB64, "base64").toString("utf-8") : (titleRaw ?? null);

  const sinopse    = html.match(/<span class="sinopse-text">\s*([\s\S]*?)\s*<\/span>/)?.[1]?.trim() ?? null;
  const ano        = html.match(/<span>Ano:<\/span>\s*<span>(\d{4})<\/span>/)?.[1] ?? null;
  const nota       = html.match(/<span>Nota:<\/span>\s*<span>([\d.]+)<\/span>/)?.[1] ?? null;
  const duracaoMin = html.match(/<span>Duração:<\/span>\s*<span>(\d+)/)?.[1] ?? null;
  const temporadas = html.match(/openEpisodes\((\d+)\)/)?.[1] ?? null;

  const opts  = html.match(/openOptions\(\{\s*br:\s*'([^']*)'\s*,\s*eng:\s*'([^']*)'/);
  const urlBR = opts?.[1]?.split(",")[0]?.trim() || null;
  const urlENG = opts?.[2]?.split(",")[0]?.trim() || null;

  return { id, tmdb, title, poster, sinopse, ano, nota, duracaoMin, urlBR, urlENG, movie, temporadas };
}

function parseEpisodes(html: string) {
  return [...html.matchAll(/data-episode='({[^']+})'/g)].flatMap(m => {
    try {
      const d = JSON.parse(m[1]);
      return [{
        ep: Number(d.episode.episode_num),
        temp: Number(d.episode.season_num),
        titulo: d.episode.title ?? null,
        urlDub: d.br?.split(",")[0]?.trim() || null,
        urlLeg: d.eng?.split(",")[0]?.trim() || null,
      }];
    } catch { return []; }
  });
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────

async function fetchApp(path: string, body?: string): Promise<string> {
  const res = await fetch(`${APP}/${path}`, {
    method: body ? "POST" : "GET",
    headers: { "User-Agent": UA, ...(body ? { "Content-Type": "application/x-www-form-urlencoded" } : {}) },
    ...(body ? { body } : {}),
  });
  return res.text();
}

async function obaPost(path: string, data: object): Promise<any> {
  const res = await fetch(`${OBAFLIX}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-admin-token": TOKEN },
    body: JSON.stringify(data),
  });
  return res.json().catch(() => ({}));
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n🎬 Megaflix → Obaflix Sync`);
  const mem = loadMemory();

  console.log(`📡 Buscando viewHome...`);
  const homeHtml = await fetchApp("?page=viewHome");

  const filmesIds  = parseUltimosFilmes(homeHtml);
  const seriesIds  = parseUltimasSeries(homeHtml);
  const epsRecentes = parseEpisodiosRecentes(homeHtml);

  const novosFilmes  = filmesIds.filter(id => !mem.filmes.includes(id));
  const novasSeries  = seriesIds.filter(id => !mem.series.includes(id));
  const novosEps     = epsRecentes.filter(e => !mem.eps.includes(`${e.serieId}-${e.temp}x${e.ep}`));

  console.log(`\n📋 Novidades detectadas:`);
  console.log(`   🎬 Filmes: ${novosFilmes.length} novos (de ${filmesIds.length} no carrossel)`);
  console.log(`   📺 Séries: ${novasSeries.length} novas (de ${seriesIds.length} no carrossel)`);
  console.log(`   🎞️  Episódios: ${novosEps.length} novos (de ${epsRecentes.length} no carrossel)\n`);

  let totalFilmes = 0, totalSeries = 0, totalEps = 0;

  // ── Filmes ──────────────────────────────────────────────────────────────────
  for (const id of novosFilmes) {
    await sleep(DELAY);
    const html = await fetchApp(`?page=viewItem&id=${id}`);
    const item = parseItem(html);
    if (!item.id || !item.title) continue;

    const r = await obaPost("/api/admin/filme", {
      id: item.id, titulo: item.title, poster: item.poster, tmdbId: item.tmdb,
      ano: item.ano ? Number(item.ano) : null,
      nota: item.nota ? Number(item.nota) : null,
      duracao: item.duracaoMin ? Number(item.duracaoMin) : null,
      sinopse: item.sinopse, urlDub: item.urlBR, urlLeg: item.urlENG || null,
    });

    if (r.ok) {
      mem.filmes.push(id);
      totalFilmes++;
      console.log(`  ✅ Filme: ${item.title} (${id})`);
    } else {
      console.log(`  ❌ Filme: ${item.title} —`, r);
    }
  }

  // ── Séries ──────────────────────────────────────────────────────────────────
  for (const id of novasSeries) {
    await sleep(DELAY);
    const html = await fetchApp(`?page=viewItem&id=${id}`);
    const item = parseItem(html);
    if (!item.id || !item.title) continue;

    await obaPost("/api/admin/serie", {
      id: item.id, titulo: item.title, poster: item.poster, tmdbId: item.tmdb,
      ano: item.ano ? Number(item.ano) : null,
      nota: item.nota ? Number(item.nota) : null,
      temporadas: item.temporadas ? Number(item.temporadas) : null,
      sinopse: item.sinopse, tipo: "serie",
    });

    const tempCount = Number(item.temporadas ?? 1);
    const todosEps: ReturnType<typeof parseEpisodes> = [];
    for (let t = 1; t <= tempCount; t++) {
      await sleep(DELAY);
      const epsHtml = await fetchApp(`?page=getEpisodes`, `item=${item.id}&season=${t}&userEpisodes=[]`);
      todosEps.push(...parseEpisodes(epsHtml));
    }

    if (todosEps.length > 0) {
      const r: any = await obaPost("/api/admin/episodio/bulk", { serieId: item.id, episodios: todosEps });
      totalEps += r.ok ?? 0;
    }

    mem.series.push(id);
    totalSeries++;
    console.log(`  ✅ Série: ${item.title} — ${todosEps.length} eps`);
  }

  // ── Episódios Recentes ───────────────────────────────────────────────────────
  for (const { serieId, temp, ep } of novosEps) {
    await sleep(DELAY);
    const epsHtml = await fetchApp(`?page=getEpisodes`, `item=${serieId}&season=${temp}&userEpisodes=[]`);
    const alvo = parseEpisodes(epsHtml).filter(e => e.ep === ep && e.temp === temp);
    if (alvo.length === 0) continue;

    const r: any = await obaPost("/api/admin/episodio/bulk", { serieId, episodios: alvo });
    if (r.ok > 0) {
      mem.eps.push(`${serieId}-${temp}x${ep}`);
      totalEps++;
      console.log(`  ✅ Ep T${temp}E${ep} da série ${serieId}`);
    }
  }

  saveMemory(mem);

  console.log(`\n🎉 Concluído! Filmes: ${totalFilmes} | Séries: ${totalSeries} | Eps: ${totalEps}`);
  if (novosFilmes.length + novasSeries.length + novosEps.length === 0) {
    console.log(`   Nada novo desde a última execução.`);
  }
}

main().catch(console.error);
