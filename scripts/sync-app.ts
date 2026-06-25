/**
 * Sincroniza conteúdo novo do Megaflix App → Obaflix
 * Lê apenas "Últimos Filmes", "Últimas Séries" e "Episodios Recentes" do viewHome.
 * Salva memória em scripts/.sync-memory.json para não reimportar o que já foi visto.
 *
 * Uso:
 *   npx tsx scripts/sync-app.ts            — sync normal
 *   npx tsx scripts/sync-app.ts --init     — pré-popula memória com todos os IDs já no obaflix
 */

import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

const APP     = "https://app.megafrixapi.com/4.6.2";
const OBAFLIX = process.env.OBAFLIX_URL ?? "https://obaflix.vercel.app";
const TOKEN   = process.env.ADMIN_SECRET_TOKEN ?? "@Oba152535";
const UA      = "okhttp/4.9.3";
const DELAY   = 400;
const MEMORY_FILE = join(import.meta.dirname, ".sync-memory.json");

type Memory = {
  filmes: string[];
  series: string[];
  eps: string[];   // "serieId-TxE"
};

function loadMemory(): Memory {
  if (existsSync(MEMORY_FILE)) {
    try { return JSON.parse(readFileSync(MEMORY_FILE, "utf8")); } catch { /**/ }
  }
  return { filmes: [], series: [], eps: [] };
}
function saveMemory(m: Memory) {
  writeFileSync(MEMORY_FILE, JSON.stringify(m, null, 2), "utf8");
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// ── Parsing do viewHome ───────────────────────────────────────────────────────

function section(html: string, from: string, to: string) {
  const s = html.indexOf(from);
  if (s === -1) return "";
  const e = html.indexOf(to, s + from.length);
  return html.slice(s, e === -1 ? html.length : e);
}

function parseUltimosFilmes(html: string) {
  return [...section(html, "Últimos Filmes", "Últimas Séries").matchAll(/openMovie\((\d+)\)/g)].map(m => m[1]);
}
function parseUltimasSeries(html: string) {
  return [...section(html, "Últimas Séries", "Episodios Recentes").matchAll(/openMovie\((\d+)\)/g)].map(m => m[1]);
}
function parseEpsRecentes(html: string): Array<{ serieId: string; temp: number; ep: number }> {
  const sec = section(html, "Episodios Recentes", "Coleções");
  return [...sec.matchAll(/openMovie\((\d+)\)[\s\S]*?class="ano">\s*(\d+)x(\d+)/g)]
    .map(m => ({ serieId: m[1], temp: Number(m[2]), ep: Number(m[3]) }));
}

// ── Parsing de item/episódios ─────────────────────────────────────────────────

function parseItem(html: string) {
  const str    = (k: string) => html.match(new RegExp(`${k}:\\s*["\`]([^"\`]+)["\`]`))?.[1] ?? null;
  const num    = (k: string) => html.match(new RegExp(`${k}:\\s*([\\d.]+)`))?.[1] ?? null;
  const b64    = html.match(/title:\s*atob\("([^"]+)"\)/)?.[1];
  const title  = b64 ? Buffer.from(b64, "base64").toString() : (str("title") ?? null);
  const poster = str("poster")?.replace("https://d1muf25xaso8hp.cloudfront.net/", "") ?? null;
  const opts   = html.match(/openOptions\(\{\s*br:\s*'([^']*)'\s*,\s*eng:\s*'([^']*)'/);
  return {
    id:          num("id"),
    tmdb:        str("tmdb"),
    title,
    poster,
    sinopse:     html.match(/<span class="sinopse-text">\s*([\s\S]*?)\s*<\/span>/)?.[1]?.trim() ?? null,
    ano:         html.match(/<span>Ano:<\/span>\s*<span>(\d{4})<\/span>/)?.[1] ?? null,
    nota:        html.match(/<span>Nota:<\/span>\s*<span>([\d.]+)<\/span>/)?.[1] ?? null,
    duracaoMin:  html.match(/<span>Duração:<\/span>\s*<span>(\d+)/)?.[1] ?? null,
    temporadas:  html.match(/openEpisodes\((\d+)\)/)?.[1] ?? null,
    movie:       html.includes("movie: true"),
    urlBR:       opts?.[1]?.split(",")[0]?.trim() || null,
    urlENG:      opts?.[2]?.split(",")[0]?.trim() || null,
  };
}

function parseEpisodes(html: string) {
  return [...html.matchAll(/data-episode='({[^']+})'/g)].flatMap(m => {
    try {
      const d = JSON.parse(m[1]);
      return [{
        ep:     Number(d.episode.episode_num),
        temp:   Number(d.episode.season_num),
        titulo: d.episode.title ?? null,
        urlDub: d.br?.split(",")[0]?.trim() || null,
        urlLeg: d.eng?.split(",")[0]?.trim() || null,
      }];
    } catch { return []; }
  });
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────

async function fetchApp(path: string, body?: string) {
  const r = await fetch(`${APP}/${path}`, {
    method: body ? "POST" : "GET",
    headers: { "User-Agent": UA, ...(body ? { "Content-Type": "application/x-www-form-urlencoded" } : {}) },
    ...(body ? { body } : {}),
  });
  return r.text();
}

async function obaPost(path: string, data: object): Promise<any> {
  const r = await fetch(`${OBAFLIX}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-admin-token": TOKEN },
    body: JSON.stringify(data),
  });
  return r.json().catch(() => ({}));
}

async function obaExisteFilme(id: string): Promise<boolean> {
  const r = await fetch(`${OBAFLIX}/api/admin/filme?q=${id}`, { headers: { "x-admin-token": TOKEN } });
  const d = await r.json().catch(() => ({ items: [] }));
  return d.items?.some((x: any) => x.id === id) ?? false;
}

async function obaExisteSerie(id: string): Promise<boolean> {
  const r = await fetch(`${OBAFLIX}/api/admin/serie?q=${id}`, { headers: { "x-admin-token": TOKEN } });
  const d = await r.json().catch(() => ({ items: [] }));
  return d.items?.some((x: any) => x.id === id) ?? false;
}

async function obaEpCount(serieId: string): Promise<number> {
  const r = await fetch(`${OBAFLIX}/api/admin/serie?q=${serieId}`, { headers: { "x-admin-token": TOKEN } });
  const d = await r.json().catch(() => ({ items: [] }));
  return d.items?.find((x: any) => x.id === serieId)?._count?.episodios ?? 0;
}

// ── --init: pré-popular memória com todos os IDs do obaflix ──────────────────

async function initMemory() {
  console.log("🔄 Buscando todos os IDs do obaflix para pré-popular memória...");
  const mem = loadMemory();
  const filmesSet = new Set(mem.filmes);
  const seriesSet = new Set(mem.series);

  let page = 1, total = 0;
  while (true) {
    const r = await fetch(`${OBAFLIX}/api/admin/filme?page=${page}`, { headers: { "x-admin-token": TOKEN } });
    const d = await r.json().catch(() => ({ items: [], pages: 0 }));
    if (!d.items?.length) break;
    d.items.forEach((x: any) => filmesSet.add(x.id));
    total += d.items.length;
    if (page >= d.pages) break;
    page++;
    await sleep(100);
  }
  console.log(`   ✅ ${total} filmes indexados`);

  page = 1; total = 0;
  while (true) {
    const r = await fetch(`${OBAFLIX}/api/admin/serie?page=${page}`, { headers: { "x-admin-token": TOKEN } });
    const d = await r.json().catch(() => ({ items: [], pages: 0 }));
    if (!d.items?.length) break;
    d.items.forEach((x: any) => seriesSet.add(x.id));
    total += d.items.length;
    if (page >= d.pages) break;
    page++;
    await sleep(100);
  }
  console.log(`   ✅ ${total} séries indexadas`);

  mem.filmes = [...filmesSet];
  mem.series = [...seriesSet];
  saveMemory(mem);
  console.log(`💾 Memória salva em .sync-memory.json\n`);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);

  if (args.includes("--init")) {
    await initMemory();
    return;
  }

  console.log(`\n🎬 Megaflix → Obaflix Sync`);
  const mem = loadMemory();

  console.log(`📡 Buscando viewHome...`);
  const homeHtml = await fetchApp("?page=viewHome");

  const filmesIds   = parseUltimosFilmes(homeHtml);
  const seriesIds   = parseUltimasSeries(homeHtml);
  const epsRecentes = parseEpsRecentes(homeHtml);

  const novosFilmes = filmesIds.filter(id => !mem.filmes.includes(id));
  const novasSeries = seriesIds.filter(id => !mem.series.includes(id));
  const novosEps    = epsRecentes.filter(e => !mem.eps.includes(`${e.serieId}-${e.temp}x${e.ep}`));

  console.log(`\n📋 Novidades detectadas:`);
  console.log(`   🎬 Filmes: ${novosFilmes.length} novos (de ${filmesIds.length})`);
  console.log(`   📺 Séries: ${novasSeries.length} novas (de ${seriesIds.length})`);
  console.log(`   🎞️  Episódios: ${novosEps.length} novos (de ${epsRecentes.length})\n`);

  let totalFilmes = 0, totalSeries = 0, totalEps = 0;

  // ── Filmes ────────────────────────────────────────────────────────────────
  for (const id of novosFilmes) {
    await sleep(DELAY);
    // Dupla verificação: memória + obaflix
    if (await obaExisteFilme(id)) {
      mem.filmes.push(id);
      continue;
    }
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

    mem.filmes.push(id);
    if (r.ok) { totalFilmes++; console.log(`  ✅ Filme: ${item.title}`); }
    else console.log(`  ❌ Filme: ${item.title} —`, r);
  }

  // ── Séries novas ──────────────────────────────────────────────────────────
  for (const id of novasSeries) {
    await sleep(DELAY);
    // Dupla verificação: se já existe, só atualiza eps novos
    const jaExiste = await obaExisteSerie(id);
    if (jaExiste) {
      console.log(`  ↩ Série ${id} já existe — sincronizando apenas eps novos`);
      mem.series.push(id);
    }

    const html = await fetchApp(`?page=viewItem&id=${id}`);
    const item = parseItem(html);
    if (!item.id || !item.title) { mem.series.push(id); continue; }

    // Upsert metadados da série (idempotente)
    await obaPost("/api/admin/serie", {
      id: item.id, titulo: item.title, poster: item.poster, tmdbId: item.tmdb,
      ano: item.ano ? Number(item.ano) : null,
      nota: item.nota ? Number(item.nota) : null,
      temporadas: item.temporadas ? Number(item.temporadas) : null,
      sinopse: item.sinopse, tipo: "serie",
    });

    const tempCount = Number(item.temporadas ?? 1);
    const epsCountAntes = jaExiste ? await obaEpCount(id) : 0;

    // Se já existia com todos os eps da última temporada, importa só a última temp
    // Se é nova ou tem menos eps que o esperado, importa tudo
    const tempsParaBuscar = jaExiste
      ? [tempCount]  // só a temporada mais recente
      : Array.from({ length: tempCount }, (_, i) => i + 1);  // todas

    const todosEps: ReturnType<typeof parseEpisodes> = [];
    for (const t of tempsParaBuscar) {
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
    console.log(`  ✅ Série: ${item.title} (${jaExiste ? "atualizada" : "nova"}) — ${todosEps.length} eps processados`);
  }

  // ── Episódios Recentes ────────────────────────────────────────────────────
  for (const { serieId, temp, ep } of novosEps) {
    await sleep(DELAY);

    // Garante que a série existe antes de adicionar o ep
    const jaExiste = await obaExisteSerie(serieId);
    if (!jaExiste) {
      const html = await fetchApp(`?page=viewItem&id=${serieId}`);
      const item = parseItem(html);
      if (item.id && item.title) {
        await obaPost("/api/admin/serie", {
          id: item.id, titulo: item.title, poster: item.poster, tmdbId: item.tmdb,
          ano: item.ano ? Number(item.ano) : null,
          nota: item.nota ? Number(item.nota) : null,
          temporadas: item.temporadas ? Number(item.temporadas) : null,
          sinopse: item.sinopse, tipo: "serie",
        });
      }
    }

    const epsHtml = await fetchApp(`?page=getEpisodes`, `item=${serieId}&season=${temp}&userEpisodes=[]`);
    const alvo = parseEpisodes(epsHtml).filter(e => e.ep === ep && e.temp === temp);
    if (alvo.length === 0) continue;

    const r: any = await obaPost("/api/admin/episodio/bulk", { serieId, episodios: alvo });
    if (r.ok > 0) {
      mem.eps.push(`${serieId}-${temp}x${ep}`);
      totalEps++;
      console.log(`  ✅ Ep T${temp}E${ep} — série ${serieId}`);
    }
  }

  saveMemory(mem);

  console.log(`\n🎉 Concluído! Filmes: ${totalFilmes} | Séries: ${totalSeries} | Eps: ${totalEps}`);
  if (!totalFilmes && !totalSeries && !totalEps) {
    console.log(`   Nada novo desde a última execução.`);
  }
}

main().catch(console.error);
