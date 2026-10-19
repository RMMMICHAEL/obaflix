// Ignored Build Step do Vercel. Sai 10 = construir; qualquer outro código (inclusive
// erro deste script) = ignorar. Ou seja, falha fechada.
// Branch feat/cortes-permissoes: só o projeto obaflix constrói, e só se as variáveis
// provarem o Preview isolado — antes de qualquer build, conexão ou deploy.
// Remover antes de qualquer merge (vale só nesta branch).
import { ambienteTesteIsolado } from "../../src/lib/isolamentoTeste.ts";

const env = process.env;
if (env.VERCEL_GIT_COMMIT_REF !== "feat/cortes-permissoes") process.exit(10);
if (env.VERCEL_PROJECT_PRODUCTION_URL !== "obaflixbr.com") process.exit(0);
const ok = ambienteTesteIsolado(env);
console.log(`isolamento-preview: ${ok ? "OK" : "FALHA"}`);
process.exit(ok ? 10 : 0);
