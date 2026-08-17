// Testa a extração nativa (mesmo código do Electron) para uma lista de embeds.
// Uso: node scripts/diag-extract.js <url> [<url> ...]
const path = require("path");
const { detectProvider, extractStream } = require(path.join(__dirname, "..", "desktop", "electron", "extractors.js"));

(async () => {
  for (const url of process.argv.slice(2)) {
    const provider = detectProvider(url);
    const t0 = Date.now();
    if (!provider) {
      console.log(`SEM EXTRATOR  ${url}`);
      continue;
    }
    try {
      const r = await extractStream(url);
      console.log(`OK  provider=${provider} ${Date.now() - t0}ms  ${url}\n    -> ${r.stream.slice(0, 120)}`);
    } catch (e) {
      console.log(`FALHA provider=${provider} ${Date.now() - t0}ms  ${url}\n    -> ${e.message}`);
    }
  }
})();
