#!/usr/bin/env node
/**
 * extract-player-url.js
 * Extrai stream de qualquer URL de embed diretamente.
 * Útil para testar um player específico antes de cadastrar no site.
 *
 * Uso:
 *   node scripts/extract-player-url.js <embed_url>
 *
 * Exemplos:
 *   node scripts/extract-player-url.js "https://vidsrc.to/embed/movie/tt30749092"
 *   node scripts/extract-player-url.js "https://playhide.shop/v/abc123"
 */

const puppeteer = require("puppeteer");

const STREAM_PATTERNS = [
  /\.m3u8(\?[^"'\s]*)?/i,
  /\.mp4(\?[^"'\s]*)?/i,
  /\/manifest(\?[^"'\s]*)?/i,
  /\/hls\//i,
  /\/dash\//i,
  /playlist\.m3u8/i,
];

const IGNORE_PATTERNS = [
  /google|gstatic|gtag|analytics|doubleclick|facebook|twitter/i,
  /\.(css|js|woff|woff2|png|jpg|jpeg|svg|ico|gif)(\?|$)/i,
];

async function extract(embedUrl) {
  console.log(`\n🔍 Extraindo de: ${embedUrl}\n`);

  const browser = await puppeteer.launch({
    headless: "new",
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-web-security",
      "--autoplay-policy=no-user-gesture-required",
    ],
  });

  const page = await browser.newPage();
  const found = new Map(); // url → source

  await page.setRequestInterception(true);

  page.on("request", (req) => {
    const url = req.url();
    if (!IGNORE_PATTERNS.some((p) => p.test(url))) {
      if (STREAM_PATTERNS.some((p) => p.test(url))) {
        if (!found.has(url)) {
          found.set(url, "request");
          console.log(`  ✓ [REDE]  ${url}`);
        }
      }
    }
    req.continue();
  });

  page.on("response", async (res) => {
    const url = res.url();
    const ct = res.headers()["content-type"] ?? "";
    if ((ct.includes("json") || ct.includes("javascript")) && !IGNORE_PATTERNS.some((p) => p.test(url))) {
      try {
        const text = await res.text();
        const matches = text.match(/https?:\/\/[^"'\s\\]+\.(m3u8|mp4)[^"'\s\\]*/gi) ?? [];
        matches.forEach((m) => {
          if (!found.has(m)) {
            found.set(m, "json-response");
            console.log(`  ✓ [JSON]  ${m}`);
          }
        });
      } catch { /**/ }
    }
  });

  await page.setUserAgent(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
  );

  let origin = "https://obaflix.vercel.app";
  try { origin = new URL(embedUrl).origin; } catch { /**/ }

  await page.setExtraHTTPHeaders({ Referer: origin + "/", Origin: origin });

  try {
    await page.goto(embedUrl, { waitUntil: "networkidle2", timeout: 25000 });
  } catch { /**/ }

  // Tenta clicar em play
  const selectors = [
    "button[class*='play']", "div[class*='play']", ".jw-icon-playback",
    ".vjs-play-control", "#play-btn", "video", ".play", "[data-plyr='play']",
    "[aria-label*='lay']",
  ];
  for (const sel of selectors) {
    try {
      await page.waitForSelector(sel, { timeout: 2000 });
      await page.click(sel);
      console.log(`  ▶ Clicou: ${sel}`);
      await new Promise((r) => setTimeout(r, 4000));
      break;
    } catch { /**/ }
  }

  await new Promise((r) => setTimeout(r, 4000));

  // Varre o HTML/scripts da página
  try {
    const domMatches = await page.evaluate(() => {
      const text = document.documentElement.innerHTML;
      return text.match(/https?:\/\/[^"'\s\\]+\.(m3u8|mp4)[^"'\s\\]*/gi) ?? [];
    });
    domMatches.forEach((u) => {
      if (!found.has(u)) {
        found.set(u, "dom");
        console.log(`  ✓ [DOM]   ${u}`);
      }
    });
  } catch { /**/ }

  await browser.close();

  const results = [...found.entries()].map(([url, source]) => ({ url, source }));

  console.log("\n═══════════════ RESULTADO ═══════════════");
  if (results.length === 0) {
    console.log("❌ Nenhum stream encontrado.");
    console.log("   Dicas:");
    console.log("   - O player pode exigir interação manual");
    console.log("   - Tente rodar com headless: false (ver comentário no código)");
    console.log("   - O Referer/Origin pode estar errado");
  } else {
    results.forEach((r, i) => {
      const tipo = r.url.includes(".mp4") ? "MP4" : "HLS";
      console.log(`\n[${i + 1}] ${tipo} (via ${r.source})`);
      console.log(`    ${r.url}`);
    });
    console.log(`\n✅ ${results.length} stream(s) encontrado(s)`);
  }

  return results;
}

const embedUrl = process.argv[2];
if (!embedUrl) {
  console.log("Uso: node scripts/extract-player-url.js <embed_url>");
  console.log('Ex:  node scripts/extract-player-url.js "https://vidsrc.to/embed/movie/tt30749092"');
  process.exit(1);
}

extract(embedUrl).catch(console.error);
