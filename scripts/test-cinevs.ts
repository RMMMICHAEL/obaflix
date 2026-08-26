// ─────────────────────────────────────────────────────────────────────────────
// Diagnóstico LOCAL do extractCineVs — rode na SUA máquina com a SUA conta.
//
//   npm run test:cinevs -- --tmdb 27205 --type movie
//   npm run test:cinevs -- --tmdb 1399  --type tv --season 1 --episode 1 --q "Game of Thrones"
//
// Confirma: autenticação → catálogo → lista de servidores → obtenção da video_url.
// NÃO baixa nem redistribui mídia. NÃO imprime token nem URL completa.
//
// Preencha as variáveis em .env.local (veja docs/cinevs-diagnostico.md) e rode
// com `--diagnostic` implícito (este script sempre usa diagnostic=true).
// ─────────────────────────────────────────────────────────────────────────────
import { extractCineVs, cineVsConfig } from "../src/lib/cinevs";

// Carrega .env.local / .env (Node >= 20.12). Não falha se o arquivo não existir.
for (const f of [".env.local", ".env"]) {
  try {
    (process as unknown as { loadEnvFile: (p: string) => void }).loadEnvFile(f);
  } catch {
    /* arquivo ausente ou runtime sem loadEnvFile — usa vars já no ambiente */
  }
}

function arg(name: string, fallback = ""): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

async function main() {
  const tmdb = arg("tmdb");
  const type = (arg("type", "movie") === "tv" ? "tv" : "movie") as "movie" | "tv";
  const season = Number(arg("season", "1"));
  const episode = Number(arg("episode", "1"));
  const titleHint = arg("q");

  if (!tmdb) {
    console.error("Uso: npm run test:cinevs -- --tmdb <id> --type <movie|tv> [--season N --episode N --q \"Título\"]");
    process.exit(1);
  }

  // Valida config sem imprimir segredos.
  let cfg;
  try {
    cfg = cineVsConfig(true);
  } catch (e) {
    console.error(`Config inválida: ${e instanceof Error ? e.message : e}`);
    process.exit(1);
  }
  console.log("── Diagnóstico CineVs ──────────────────────────────");
  console.log(`host base .......: ${new URL(cfg.base).host}`);      // só host, sem path/segredo
  console.log(`auth path .......: ${cfg.authPath}`);
  console.log(`platform/device .: ${cfg.platform}/${cfg.deviceType}`);
  console.log(`refresh_token ...: ${cfg.refreshToken ? "definido (oculto)" : "AUSENTE"}`);
  console.log(`enabled (público): ${cfg.enabled ? "1" : "0 (permanece desativado)"}`);
  console.log(`alvo ............: tmdb=${tmdb} type=${type}${type === "tv" ? ` s${season}e${episode}` : ""}`);
  console.log("────────────────────────────────────────────────────");

  const res = await extractCineVs({ tmdbId: tmdb, type, season, episode, titleHint, diagnostic: true });

  console.log("────────────────────────────────────────────────────");
  if (!res) {
    console.log("RESULTADO: sem video_url. Veja os logs [cinevs/*] acima para a etapa que falhou.");
    console.log("Dicas: 401/403 no /video ⇒ atestado/ad-proof pode ser exigido no /api/v1/ (não forjamos).");
    process.exit(2);
  }
  console.log("RESULTADO: video_url obtida ✔  (conteúdo NÃO baixado)");
  console.log(`  formato .......: ${res.format}`);
  console.log(`  host da mídia .: ${res.mediaHost}`);
  console.log(`  tem expiração .: ${res.hasExpiry ? "sim (token/expires na query)" : "não detectada"}`);
  console.log(`  áudio .........: ${res.audioType}`);
  console.log(`  legendas ......: ${res.subtitles.length}`);
  console.log("  (URL completa e tokens omitidos por segurança)");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
