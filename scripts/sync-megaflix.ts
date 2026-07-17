/**
 * sync-megaflix.ts
 * Busca conteúdo novo no Megaflix e importa para o banco.
 *
 * Uso:
 *   npx tsx scripts/sync-megaflix.ts --email SEU@EMAIL --senha SUASENHA
 *   npx tsx scripts/sync-megaflix.ts --email SEU@EMAIL --senha SUASENHA --import
 *   npx tsx scripts/sync-megaflix.ts --email SEU@EMAIL --senha SUASENHA --import --tipo filmes
 *   npx tsx scripts/sync-megaflix.ts --email SEU@EMAIL --senha SUASENHA --import --tipo series
 */

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const args = process.argv.slice(2);
const getArg = (flag: string) => { const i = args.indexOf(flag); return i !== -1 ? args[i + 1] : null; };
const hasFlag = (flag: string) => args.includes(flag);

const EMAIL = getArg("--email") ?? "";
const SENHA = getArg("--senha") ?? "";
const ADMIN_URL = "https://admin.megafrixapi.com";
const DO_IMPORT = hasFlag("--import");
const TIPO = getArg("--tipo") ?? "ambos"; // "filmes" | "series" | "ambos"
const PAGE_LIMIT = Number(getArg("--paginas") ?? "5"); // quantas páginas buscar

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122.0.0.0 Safari/537.36";
const TMDB_KEY = process.env.TMDB_API_KEY;

let BASE = ADMIN_URL;
let sessionToken = "";
let cookieJar = "";

// ── Auth ──────────────────────────────────────────────────────────────────────

async function login(): Promise<boolean> {
  console.log(`\n🔐 Lendo formulário de login em ${ADMIN_URL}...`);

  // 1. GET da página raiz para descobrir o formulário
  let loginPageUrl = ADMIN_URL;
  let formAction = "";
  let passwordField = "password";

  try {
    const page = await fetch(ADMIN_URL, {
      headers: { "User-Agent": UA },
      signal: AbortSignal.timeout(8000),
      redirect: "follow",
    });
    const html = await page.text();
    loginPageUrl = page.url; // URL final após redirecionamentos

    console.log(`   Página carregada: ${loginPageUrl} (${html.length} chars)`);

    // Extrai action do form
    const actionMatch = html.match(/<form[^>]+action=["']([^"']+)["']/i);
    if (actionMatch) {
      formAction = actionMatch[1].startsWith("http")
        ? actionMatch[1]
        : ADMIN_URL + actionMatch[1];
      console.log(`   Form action: ${formAction}`);
    } else {
      formAction = loginPageUrl; // POST na mesma URL
    }

    // Descobre o nome do campo de senha
    const inputMatch = html.match(/<input[^>]+type=["']password["'][^>]*name=["']([^"']+)["']/i)
      ?? html.match(/<input[^>]+name=["']([^"']+)["'][^>]*type=["']password["']/i);
    if (inputMatch) {
      passwordField = inputMatch[1];
      console.log(`   Campo senha: ${passwordField}`);
    }

    // Extrai CSRF token se existir
    const csrfMatch = html.match(/<input[^>]+name=["'](_token|csrf_token|_csrf)[^"']*["'][^>]*value=["']([^"']+)["']/i);
    const csrfToken = csrfMatch?.[2] ?? "";
    const csrfField = csrfMatch?.[1] ?? "";
    if (csrfToken) console.log(`   CSRF token encontrado: ${csrfToken.slice(0, 20)}...`);

    // 2. POST com form-urlencoded
    const formData = new URLSearchParams();
    formData.append(passwordField, SENHA);
    if (csrfToken && csrfField) formData.append(csrfField, csrfToken);

    console.log(`\n   POST ${formAction} com ${passwordField}=***`);
    const loginRes = await fetch(formAction, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": UA,
        "Referer": loginPageUrl,
        "Cookie": page.headers.get("set-cookie") ?? "",
      },
      body: formData.toString(),
      signal: AbortSignal.timeout(8000),
      redirect: "manual",
    });

    const setCookie = loginRes.headers.get("set-cookie") ?? "";
    const location = loginRes.headers.get("location") ?? "";
    const responseText = await loginRes.text().catch(() => "");

    console.log(`   Resposta: ${loginRes.status} | Location: ${location} | Cookie: ${setCookie.slice(0, 60)}`);
    console.log(`   Body preview: ${responseText.slice(0, 200)}`);

    // Login OK = redirect (302) para painel ou cookie de sessão
    if ((loginRes.status === 302 || loginRes.status === 301) && location && !location.includes("login")) {
      cookieJar = setCookie;
      console.log(`\n   ✅ Login OK! Redirecionado para ${location}`);
      return true;
    }

    if (setCookie && loginRes.ok) {
      cookieJar = setCookie;
      console.log(`\n   ✅ Login OK! Cookie de sessão recebido.`);
      return true;
    }

    console.error("\n   ❌ Login falhou. Verifique a senha ou cole o output acima.");
    return false;

  } catch (e: any) {
    console.error(`   ❌ Erro: ${e.message}`);
    return false;
  }
}

function authHeaders(): Record<string, string> {
  const h: Record<string, string> = { "User-Agent": UA };
  if (sessionToken) h["Authorization"] = `Bearer ${sessionToken}`;
  if (cookieJar) h["Cookie"] = cookieJar;
  return h;
}

// ── Fetch helpers ─────────────────────────────────────────────────────────────

async function apiGet(path: string): Promise<any> {
  const res = await fetch(`${BASE}${path}`, { headers: authHeaders() });
  if (!res.ok) throw new Error(`HTTP ${res.status} em ${path}`);
  return res.json();
}

// ── Descoberta de endpoints ───────────────────────────────────────────────────

async function discoverEndpoints() {
  console.log("\n🔍 Descobrindo endpoints da API...");
  const candidates = [
    "/api/filmes?page=1&per_page=5",
    "/api/movies?page=1&per_page=5",
    "/api/series?page=1&per_page=5",
    "/api/contents?page=1",
    "/api/catalog?page=1",
    "/api/recentes?page=1",
    "/filmes?page=1",
    "/series?page=1",
  ];

  for (const path of candidates) {
    try {
      const res = await fetch(`${BASE}${path}`, { headers: authHeaders(), signal: AbortSignal.timeout(6000) });
      console.log(`   ${res.ok ? "✅" : "❌"} ${path} → ${res.status}`);
      if (res.ok) {
        const text = await res.text();
        console.log(`      Preview: ${text.slice(0, 150)}`);
      }
    } catch (e: any) {
      console.log(`   ⏱️  ${path} → timeout/erro`);
    }
  }
}

// ── Fetch catálogo ────────────────────────────────────────────────────────────

interface MegaFilme {
  id: string | number;
  titulo?: string;
  title?: string;
  tmdb?: string | number;
  poster?: string;
  background?: string;
  sinopse?: string;
  ano?: number;
  nota?: number;
  duracao?: number;
  urlBR?: string;
  urlENG?: string;
  generos?: { id: number; nome: string }[];
}

interface MegaSerie extends MegaFilme {
  episodios?: {
    id: string | number;
    ep: number;
    temp: number;
    nome?: string;
    urlBR?: string;
    urlENG?: string;
    bg?: string;
  }[];
}

// Tenta múltiplos padrões de endpoint para catálogo
async function fetchCatalog(tipo: "filmes" | "series"): Promise<any[]> {
  const paths = [
    `/api/${tipo}`,
    `/api/catalog?tipo=${tipo}`,
    `/${tipo}`,
    `/api/content?tipo=${tipo}`,
  ];

  for (const basePath of paths) {
    const all: any[] = [];
    for (let page = 1; page <= PAGE_LIMIT; page++) {
      try {
        const sep = basePath.includes("?") ? "&" : "?";
        const data = await apiGet(`${basePath}${sep}page=${page}&per_page=50`);
        const items: any[] = data.data ?? data.items ?? data[tipo] ?? data ?? [];
        if (!Array.isArray(items) || items.length === 0) {
          if (page === 1) break; // endpoint não funcionou
          return all; // acabaram os itens
        }
        all.push(...items);
        process.stdout.write(`\r   ${tipo}: ${all.length} carregados (pág ${page})...`);
      } catch { break; }
    }
    if (all.length > 0) { console.log(); return all; }
  }
  console.log(`\n   ⚠️  Nenhum endpoint de ${tipo} funcionou.`);
  return [];
}

async function fetchFilmes(): Promise<MegaFilme[]> { return fetchCatalog("filmes"); }
async function fetchSeries(): Promise<MegaSerie[]> { return fetchCatalog("series"); }

// ── Classificação de tipo (anime/desenho/serie) ─────────────────────────────
// O catálogo do Megaflix não informa país de origem, então checamos no TMDB.
// Mesma heurística usada em import.ts/import-embedmovies.mjs: genero 16
// (Animação) + origin_country "JP" → anime; genero 16 sem JP → desenho.
async function fetchOriginCountry(tmdbId: string | number): Promise<string[]> {
  if (!TMDB_KEY) return [];
  try {
    const res = await fetch(`https://api.themoviedb.org/3/tv/${tmdbId}?api_key=${TMDB_KEY}`, {
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return [];
    const data = await res.json();
    return data.origin_country ?? [];
  } catch {
    return [];
  }
}

async function poolLimit<T>(items: T[], concurrency: number, fn: (item: T) => Promise<void>): Promise<void> {
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (i < items.length) { const item = items[i++]; await fn(item); }
    }),
  );
}

async function classificarTipos(series: MegaSerie[]): Promise<Map<string, "anime" | "desenho" | "serie">> {
  const tipos = new Map<string, "anime" | "desenho" | "serie">();
  await poolLimit(series, 5, async (s) => {
    const generoIds = (s.generos ?? []).map((g) => Number(g.id));
    let tipo: "anime" | "desenho" | "serie" = "serie";
    if (generoIds.includes(16)) {
      const origins = s.tmdb ? await fetchOriginCountry(s.tmdb) : [];
      tipo = origins.includes("JP") ? "anime" : "desenho";
    }
    tipos.set(String(s.id), tipo);
  });
  return tipos;
}

// ── Comparação com banco ──────────────────────────────────────────────────────

async function syncFilmes(filmes: MegaFilme[]) {
  if (filmes.length === 0) { console.log("   Nenhum filme encontrado na API."); return; }

  // IDs já no banco
  const existentes = new Set(
    (await prisma.filme.findMany({ select: { id: true } })).map((f) => f.id)
  );

  const novos = filmes.filter((f) => !existentes.has(String(f.id)));
  console.log(`\n🎬 Filmes: ${filmes.length} no Megaflix, ${existentes.size} no banco, ${novos.length} NOVOS`);

  if (novos.length === 0) { console.log("   ✅ Banco já está atualizado!"); return; }

  novos.slice(0, 10).forEach((f) => console.log(`   + ${f.titulo ?? f.title} (${f.ano ?? "?"})`));
  if (novos.length > 10) console.log(`   ... e mais ${novos.length - 10}`);

  if (!DO_IMPORT) { console.log("\n   ℹ️  Rode com --import para salvar."); return; }

  console.log("\n   Importando...");
  let ok = 0;
  const BATCH = 100;
  for (let i = 0; i < novos.length; i += BATCH) {
    const batch = novos.slice(i, i + BATCH);

    // Gêneros
    const genMap = new Map<number, string>();
    batch.forEach((f) => f.generos?.forEach((g) => genMap.set(Number(g.id), g.nome)));
    if (genMap.size > 0) {
      await prisma.genero.createMany({
        data: Array.from(genMap.entries()).map(([id, nome]) => ({ id, nome })),
        skipDuplicates: true,
      });
    }

    await prisma.filme.createMany({
      skipDuplicates: true,
      data: batch.map((f) => ({
        id: String(f.id),
        tmdbId: f.tmdb ? String(f.tmdb) : null,
        titulo: f.titulo ?? f.title ?? "Sem título",
        poster: f.poster ?? null,
        background: f.background ?? null,
        sinopse: f.sinopse ?? null,
        ano: f.ano ? Number(f.ano) : null,
        nota: f.nota ? Number(f.nota) : null,
        duracao: f.duracao ? Number(f.duracao) : null,
        urlDub: f.urlBR ?? null,
        urlLeg: f.urlENG ?? null,
      })),
    });

    // FilmeGenero
    const fgRows = batch.flatMap((f) =>
      (f.generos ?? []).map((g) => ({ filmeId: String(f.id), generoId: Number(g.id) }))
    );
    if (fgRows.length > 0) {
      await prisma.filmeGenero.createMany({ data: fgRows, skipDuplicates: true });
    }

    ok += batch.length;
    process.stdout.write(`\r   ${ok}/${novos.length} filmes...`);
  }
  console.log(`\n   ✅ ${ok} filmes importados!`);
}

async function syncSeries(series: MegaSerie[]) {
  if (series.length === 0) { console.log("   Nenhuma série encontrada na API."); return; }

  const existentes = new Set(
    (await prisma.serie.findMany({ select: { id: true } })).map((s) => s.id)
  );
  const existentesEp = new Set(
    (await prisma.episodio.findMany({ select: { id: true } })).map((e) => e.id)
  );

  const novasSeries = series.filter((s) => !existentes.has(String(s.id)));
  const episNovos = series.flatMap((s) =>
    (s.episodios ?? [])
      .filter((e) => !existentesEp.has(String(e.id)))
      .map((e) => ({ ...e, serieId: String(s.id) }))
  );

  console.log(`\n📺 Séries: ${series.length} no Megaflix, ${existentes.size} no banco, ${novasSeries.length} novas`);
  console.log(`   Episódios novos: ${episNovos.length}`);

  if (novasSeries.length === 0 && episNovos.length === 0) {
    console.log("   ✅ Banco já está atualizado!"); return;
  }

  novasSeries.slice(0, 10).forEach((s) => console.log(`   + ${s.titulo ?? s.title} (${s.ano ?? "?"})`));
  if (novasSeries.length > 10) console.log(`   ... e mais ${novasSeries.length - 10}`);

  if (!DO_IMPORT) { console.log("\n   ℹ️  Rode com --import para salvar."); return; }

  console.log("\n   Classificando tipo (anime/desenho/série) via TMDB...");
  const tipos = await classificarTipos(novasSeries);

  console.log("   Importando séries...");
  const BATCH = 100;

  // Gêneros
  const genMap = new Map<number, string>();
  series.forEach((s) => s.generos?.forEach((g) => genMap.set(Number(g.id), g.nome)));
  if (genMap.size > 0) {
    await prisma.genero.createMany({
      data: Array.from(genMap.entries()).map(([id, nome]) => ({ id, nome })),
      skipDuplicates: true,
    });
  }

  for (let i = 0; i < novasSeries.length; i += BATCH) {
    const batch = novasSeries.slice(i, i + BATCH);
    await prisma.serie.createMany({
      skipDuplicates: true,
      data: batch.map((s) => {
        const maxTemp = s.episodios?.length
          ? Math.max(...s.episodios.map((e) => Number(e.temp) || 1))
          : null;
        const tipo = tipos.get(String(s.id)) ?? "serie";
        return {
          id: String(s.id),
          tmdbId: s.tmdb ? String(s.tmdb) : null,
          titulo: s.titulo ?? s.title ?? "Sem título",
          poster: s.poster ?? null,
          background: s.background ?? null,
          sinopse: s.sinopse ?? null,
          ano: s.ano ? Number(s.ano) : null,
          nota: s.nota ? Number(s.nota) : null,
          temporadas: maxTemp,
          tipo,
        };
      }),
    });

    const sgRows = batch.flatMap((s) =>
      (s.generos ?? []).map((g) => ({ serieId: String(s.id), generoId: Number(g.id) }))
    );
    if (sgRows.length > 0) {
      await prisma.serieGenero.createMany({ data: sgRows, skipDuplicates: true });
    }
    process.stdout.write(`\r   ${Math.min(i + BATCH, novasSeries.length)}/${novasSeries.length} séries...`);
  }

  // Episódios novos (de séries novas E séries existentes com eps novos)
  if (episNovos.length > 0) {
    console.log(`\n   Importando ${episNovos.length} episódios novos...`);
    for (let i = 0; i < episNovos.length; i += BATCH) {
      const batch = episNovos.slice(i, i + BATCH);
      await prisma.episodio.createMany({
        skipDuplicates: true,
        data: batch.map((e) => ({
          id: String(e.id),
          serieId: e.serieId,
          numeroEp: Number(e.ep),
          temporada: Number(e.temp),
          titulo: e.nome ?? null,
          thumbnail: e.bg ?? null,
          urlDub: e.urlBR ?? null,
          urlLeg: e.urlENG ?? null,
        })),
      });
      process.stdout.write(`\r   ${Math.min(i + BATCH, episNovos.length)}/${episNovos.length} episódios...`);
    }
  }

  console.log(`\n   ✅ ${novasSeries.length} séries + ${episNovos.length} episódios importados!`);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  if (!SENHA) {
    console.log(`
Uso:
  npx tsx scripts/sync-megaflix.ts --email SEU@EMAIL --senha SUASENHA
  npx tsx scripts/sync-megaflix.ts --email SEU@EMAIL --senha SUASENHA --import
  npx tsx scripts/sync-megaflix.ts --email SEU@EMAIL --senha SUASENHA --import --tipo filmes
  npx tsx scripts/sync-megaflix.ts --email SEU@EMAIL --senha SUASENHA --import --tipo series
  npx tsx scripts/sync-megaflix.ts --email SEU@EMAIL --senha SUASENHA --paginas 10 --import

Flags:
  --import      Salva no banco (sem essa flag é só dry run)
  --tipo        "filmes", "series" ou "ambos" (padrão: ambos)
  --paginas     Quantas páginas buscar (padrão: 5, cada pág ~50 itens)
    `);
    process.exit(1);
  }

  const loggedIn = await login();

  // Se login falhou, tenta descobrir endpoints de qualquer forma
  if (!loggedIn) {
    await discoverEndpoints();
    process.exit(1);
  }

  if (TIPO === "filmes" || TIPO === "ambos") {
    console.log("\n📥 Buscando filmes...");
    const filmes = await fetchFilmes();
    await syncFilmes(filmes);
  }

  if (TIPO === "series" || TIPO === "ambos") {
    console.log("\n📥 Buscando séries...");
    const series = await fetchSeries();
    await syncSeries(series);
  }

  console.log("\n✅ Sync concluído!");
  await prisma.$disconnect();
}

main().catch((e) => { console.error(e); prisma.$disconnect(); process.exit(1); });
