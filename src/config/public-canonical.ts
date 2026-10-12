import { WEB_STREAMING_ENABLED, type Ambiente } from "./site-mode";

const ORIGEM_OFICIAL = "https://obaflixbr.com";
const HOST_DUPLICADO = /^(?:obaflix\.vercel\.app|www\.obaflixbr\.com)(?::(?:80|443))?$/i;
const FICHA_PUBLICA = /^\/(?:filme|serie|genero)\/[^/]+\/?$/;
const COOKIE_AUTH = /^(?:(?:__Secure|__Host)-)?next-auth\./;

/** Só documentos públicos anônimos. Não migra sessões nem origens dos apps. */
export function publicCanonicalUrl({
  host, method, pathname, search, ambiente, accept, rsc, cookieNames,
}: {
  host: string;
  method: string;
  pathname: string;
  search: string;
  ambiente: Ambiente;
  accept: string | null;
  rsc: string | null;
  cookieNames: string[];
}): URL | null {
  if (WEB_STREAMING_ENABLED || ambiente !== "navegador" || !HOST_DUPLICADO.test(host)) return null;
  if (method !== "GET" && method !== "HEAD") return null;
  if (rsc === "1" || (accept && !accept.includes("text/html") && !accept.includes("*/*"))) return null;
  // O callback pode voltar à raiz. Trocar de domínio perderia cookies host-only.
  if (cookieNames.some((name) => COOKIE_AUTH.test(name))) return null;
  if (!["/", "/filmes", "/filmes/", "/series", "/series/"].includes(pathname) && !FICHA_PUBLICA.test(pathname)) return null;

  const destino = new URL(ORIGEM_OFICIAL);
  destino.pathname = pathname;
  destino.search = search;
  return destino;
}
