/**
 * next-auth 4.24.15 decide a origem (redirect_uri, cookies de estado, redirecionamentos) em
 * `utils/detect-origin.js`, que devolve `process.env.NEXTAUTH_URL` ANTES de olhar o host do pedido. Este patch faz essa
 * função consultar primeiro um AsyncLocalStorage (`globalThis.__obaflixAuthOrigin`, preenchido por `src/lib/authHost.ts`
 * só para pedidos de domínios oficiais). Fora desse contexto nada muda; nenhuma variável de ambiente é escrita.
 *
 * Idempotente. Só altera o arquivo ORIGINAL conhecido (hash); se a versão do next-auth mudar, falha em voz alta — o
 * patch precisa ser reavaliado, nunca aplicado às cegas. Roda no `postinstall` e antes do `build`.
 */
const fs = require("node:fs");
const crypto = require("node:crypto");
const path = require("node:path");

const ORIGINAL_SHA256 = "19185633035ef522"; // prefixo do sha256 do arquivo da 4.24.15
const MARCA = "__obaflixAuthOrigin";

function aplicar(arquivo = path.join(__dirname, "..", "node_modules", "next-auth", "utils", "detect-origin.js")) {
  const texto = fs.readFileSync(arquivo, "utf8");
  if (texto.includes(MARCA)) return "ja-aplicado";
  const hash = crypto.createHash("sha256").update(texto).digest("hex");
  if (!hash.startsWith(ORIGINAL_SHA256)) {
    throw new Error("next-auth/utils/detect-origin.js diferente do esperado (4.24.15): reavaliar patch-next-auth-origin.cjs");
  }
  const alvo = "function detectOrigin(forwardedHost, protocol) {\n";
  if (!texto.includes(alvo)) throw new Error("assinatura de detectOrigin nao encontrada");
  const patch =
    alvo +
    `  var _obaflix = globalThis.${MARCA} && globalThis.${MARCA}.getStore && globalThis.${MARCA}.getStore();\n` +
    "  if (_obaflix && _obaflix.origem) return _obaflix.origem;\n";
  fs.writeFileSync(arquivo, texto.replace(alvo, patch));
  return "aplicado";
}

module.exports = { aplicar };

if (require.main === module) {
  try {
    console.log("patch-next-auth-origin:", aplicar());
  } catch (e) {
    console.error("patch-next-auth-origin FALHOU:", e.message);
    process.exit(1);
  }
}
