import { detectarAmbiente } from "./site-mode";

export const PUBLIC_ORIGIN = "https://obaflixbr.com";
const LEGACY_HOSTS = new Set(["obaflix.online", "obaflix.vercel.app", "www.obaflixbr.com"]);

/** Routing only: client markers never grant authentication or authorization. */
export function publicDomainRedirect(
  url: URL,
  userAgent?: string | null,
  client?: string | null,
  surface = "public",
): URL | null {
  if (surface !== "public" || !LEGACY_HOSTS.has(url.hostname)) return null;
  if (url.pathname === "/api" || url.pathname.startsWith("/api/")) return null;
  if (detectarAmbiente(userAgent, client) !== "navegador" || /ObaflixTV\//i.test(userAgent ?? "")) return null;

  // Assign components rather than resolving a user-controlled path against a
  // base URL: even a pathname beginning with // cannot replace the destination.
  const destination = new URL(PUBLIC_ORIGIN);
  destination.pathname = url.pathname;
  destination.search = url.search;
  return destination;
}

/** Existing env remains authoritative for local/preview/admin environments. */
export function publicSiteUrl(configured = PUBLIC_ORIGIN): string {
  const url = new URL(configured);
  if (LEGACY_HOSTS.has(url.hostname) || url.hostname === "obaflixbr.com") return PUBLIC_ORIGIN;
  return configured.replace(/\/$/, "");
}
