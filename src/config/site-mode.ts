/**
 * Chave única que abre ou fecha a interface pública de streaming na web.
 *
 * Enquanto `WEB_STREAMING_ENABLED` não for exatamente `"true"`, as páginas
 * públicas do catálogo redirecionam para a landing page de download. Para
 * reativar o site inteiro basta definir a variável e fazer redeploy — nenhum
 * arquivo precisa ser tocado.
 *
 * O que este flag NÃO faz, de propósito:
 *   - não desliga nenhuma rota de `/api/*` (auth, sessão, pareamento, catálogo,
 *     progresso, favoritos, player). Android, Android TV e Electron continuam
 *     falando com o backend exatamente como antes;
 *   - não afeta clientes nativos: o WebView do Android e o Electron se anunciam
 *     pelo User-Agent e passam direto;
 *   - não bloqueia `/parear`, `/login`, `/cadastro` nem `/admin`.
 */
export const WEB_STREAMING_ENABLED = process.env.WEB_STREAMING_ENABLED === "true";

/**
 * Caminhos públicos que continuam abertos mesmo com o streaming web fechado.
 * É uma allowlist justamente para que uma rota nova nasça fechada: esquecer de
 * adicionar aqui é seguro, esquecer de adicionar numa blocklist não seria.
 */
const SEMPRE_ABERTO = [
  "/parear",
  "/login",
  "/cadastro",
  "/android",
  "/admin",
  "/api",
  "/robots.txt",
  "/sitemap",
  "/manifest",
  "/favicon.ico",
  "/opensearch.xml",
];

/** User-Agents dos nossos clientes nativos. Espelha os UAs realmente enviados:
 *  `ObaflixApp/` (WebView do Android/Android TV) e `ObaflixDesktop/` (Electron). */
const UA_CLIENTE_NATIVO = /Obaflix(App|Desktop)\//i;

export function ehClienteNativo(userAgent: string | null | undefined): boolean {
  return UA_CLIENTE_NATIVO.test(userAgent ?? "");
}

/** A rota é uma página pública de streaming que deve redirecionar para a landing? */
export function ehPaginaFechada(pathname: string): boolean {
  if (WEB_STREAMING_ENABLED) return false;
  if (pathname === "/") return false;
  return !SEMPRE_ABERTO.some(
    (base) => pathname === base || pathname.startsWith(`${base}/`),
  );
}
