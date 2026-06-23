#!/usr/bin/env node
/**
 * extract-watchplayer.js
 *
 * Modo headless (--headless): tenta extrair automaticamente
 * Modo visual (padrão):       abre Chrome visível — você resolve CAPTCHA se aparecer
 *
 * Uso:
 *   node scripts/extract-watchplayer.js filme tt30749092
 *   node scripts/extract-watchplayer.js filme tt30749092 --headless
 *   node scripts/extract-watchplayer.js serie 76479 1 1
 */

const puppeteer = require("puppeteer");

const HEADLESS = process.argv.includes("--headless");

const PLAYERS = {
  filme: [
    (id) => `https://multiembed.mov/?video_id=${id}&tmdb=1`,
    (id) => `https://vidsrc.to/embed/movie/${id}`,
    (id) => `https://vidsrc.xyz/embed/movie?imdb=${id}`,
    (id) => `https://embed.su/embed/movie/${id}`,
  ],
  serie: [
    (id, t, e) => `https://multiembed.mov/?video_id=${id}&tmdb=1&s=${t}&e=${e}`,
    (id, t, e) => `https://vidsrc.to/embed/tv/${id}/${t}-${e}`,
    (id, t, e) => `https://vidsrc.xyz/embed/tv?tmdb=${id}&season=${t}&episode=${e}`,
    (id, t, e) => `https://embed.su/embed/tv/${id}/${t}/${e}`,
  ],
};

const STEALTH = `
  Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  Object.defineProperty(navigator, 'plugins', { get: () => [1,2,3,4,5] });
  Object.defineProperty(navigator, 'languages', { get: () => ['pt-BR','pt','en'] });
  window.chrome = { runtime: {} };
`;

async function extractFromUrl(embedUrl) {
  console.log(`\n🔍 ${embedUrl}`);
  if (!HEADLESS) console.log("   [Modo visual — resolva CAPTCHA se aparecer, o script espera]");

  const browser = await puppeteer.launch({
    headless: HEADLESS ? "new" : false,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-blink-features=AutomationControlled",
      "--autoplay-policy=no-user-gesture-required",
    ],
    ignoreHTTPSErrors: true,
    defaultViewport: null,
  });

  const found = new Map();

  const setupPage = async (page) => {
    await page.evaluateOnNewDocument(STEALTH);
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
    );
    await page.setRequestInterception(true).catch(() => {});
    page.on("request", (req) => {
      const u = req.url();
      if (u.match(/\.(m3u8|mp4)/i) || u.includes("/hls/") || u.includes("manifest")) {
        if (!found.has(u)) { found.set(u, "network"); console.log(`  ✓ [NET]  ${u}`); }
      }
      req.continue().catch(() => {});
    });
    page.on("response", async (res) => {
      const ct = res.headers()["content-type"] ?? "";
      if (ct.includes("json") || ct.includes("javascript")) {
        try {
          const text = await res.text();
          const ms = [...text.matchAll(/https?:\/\/[^\s"'\\]+\.(m3u8|mp4)([?#][^\s"'\\]*)?/gi)];
          ms.forEach(([u]) => {
            if (!found.has(u)) { found.set(u, "json"); console.log(`  ✓ [JSON] ${u}`); }
          });
        } catch {}
      }
    });
  };

  const page = await browser.newPage();
  await setupPage(page);
  browser.on("targetcreated", async (t) => {
    if (t.type() !== "page") return;
    const p = await t.page().catch(() => null);
    if (p) await setupPage(p);
  });

  await page.setExtraHTTPHeaders({ Referer: "https://obaflix.vercel.app/" });

  try {
    await page.goto(embedUrl, { waitUntil: "networkidle2", timeout: 30000 });
  } catch {}

  // Aguarda mais no modo visual (usuário pode estar resolvendo CAPTCHA)
  const waitTime = HEADLESS ? 6000 : 20000;
  console.log(`  ⏳ Aguardando ${waitTime / 1000}s...`);
  await new Promise((r) => setTimeout(r, waitTime));

  // Tenta clicar play
  const selectors = [
    ".play-button", "button.play", "#play", ".jw-icon-playback",
    ".vjs-play-control", "[data-plyr='play']", "video",
    "[class*='play-btn']", "[aria-label*='Play']",
  ];
  for (const sel of selectors) {
    try {
      await page.waitForSelector(sel, { timeout: 1000 });
      await page.click(sel);
      console.log(`  ▶ Clicou: ${sel}`);
      await new Promise((r) => setTimeout(r, 5000));
      break;
    } catch {}
  }

  // Varre DOM de todos os frames
  for (const frame of page.frames()) {
    try {
      const matches = await frame.evaluate(() =>
        [...document.documentElement.innerHTML.matchAll(
          /https?:\/\/[^\s"'\\]+\.(m3u8|mp4)([?#][^\s"'\\]*)?/gi
        )].map((m) => m[0])
      );
      matches.forEach((u) => {
        if (!found.has(u)) { found.set(u, "dom"); console.log(`  ✓ [DOM]  ${u}`); }
      });
    } catch {}
  }

  await browser.close();
  return [...found.entries()].map(([url, source]) => ({ url, source }));
}

async function main() {
  const args = process.argv.filter(a => !a.startsWith("--"));
  const [,, tipo, id, temporada, episodio] = args;

  if (!tipo || !id) {
    console.log("Uso:");
    console.log("  node scripts/extract-watchplayer.js filme <imdb_id> [--headless]");
    console.log("  node scripts/extract-watchplayer.js serie <tmdb_id> <temp> <ep> [--headless]");
    process.exit(1);
  }

  const templates = PLAYERS[tipo];
  if (!templates) { console.error("Tipo: 'filme' ou 'serie'"); process.exit(1); }

  for (let i = 0; i < templates.length; i++) {
    const url = tipo === "filme"
      ? templates[i](id)
      : templates[i](id, temporada, episodio);

    console.log(`\n${"═".repeat(55)}`);
    console.log(`Player ${i + 1}/${templates.length}`);

    const streams = await extractFromUrl(url);
    if (streams.length > 0) {
      console.log(`\n✅ ${streams.length} stream(s) encontrado(s):`);
      streams.forEach((s, i) => {
        const tipo = s.url.includes(".mp4") ? "MP4" : "HLS";
        console.log(`  [${i + 1}] ${tipo} — ${s.url}`);
      });

      const fs = require("fs");
      const out = `result-${Date.now()}.json`;
      fs.writeFileSync(out, JSON.stringify({ player: url, streams }, null, 2));
      console.log(`\n💾 Salvo em: ${out}`);
      process.exit(0);
    }
    console.log("  — Nada encontrado neste player");
  }

  console.log("\n❌ Nenhum stream encontrado.");
  console.log("   Dica: tente sem --headless para resolver CAPTCHA manualmente");
}

main().catch(console.error);
