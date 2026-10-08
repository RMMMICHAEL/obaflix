/** Exact public paths: never grant access to lookalike prefixes. */
export const DOWNLOAD_PUBLIC_PATHS = ["/baixar", "/termos", "/privacidade", "/download/android"] as const;

export function isDownloadPublicPath(pathname: string) {
  return DOWNLOAD_PUBLIC_PATHS.some((path) => pathname === path || pathname === `${path}/`);
}

export const ANDROID_DOWNLOAD_PATH = "/download/android";
export const DOWNLOAD_HOSTS = ["app.obaflix.online"] as const;

/** Server configuration only. To migrate later, add the verified new host here. */
export function validatedDownloadUrl(value: string, extension: "apk" | "exe" = "apk"): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.port || url.search || url.hash) return null;
    if (!DOWNLOAD_HOSTS.some((host) => url.hostname === host)) return null;
    if (!url.pathname.endsWith(`.${extension}`) || url.pathname.includes("%")) return null;
    return url.href;
  } catch {
    return null;
  }
}
