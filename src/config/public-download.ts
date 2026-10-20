/** Exact public paths: never grant access to lookalike prefixes. */
export const DOWNLOAD_PUBLIC_PATHS = ["/baixar", "/termos", "/privacidade", "/download/android"] as const;

export function isDownloadPublicPath(pathname: string) {
  return DOWNLOAD_PUBLIC_PATHS.some((path) => pathname === path || pathname === `${path}/`);
}

export const ANDROID_DOWNLOAD_PATH = "/download/android";
export const DOWNLOAD_HOSTS = ["app.obaflix.online"] as const;

/**
 * URL canônica e fixa da landing. É o único destino que "Abrir no navegador"
 * pode tentar e o único texto que "Copiar link" entrega. Constante de propósito:
 * nunca derivada do Host da request, de preview `.vercel.app` ou de query do
 * usuário, para que não exista caminho de open redirect partindo daqui.
 */
export const PUBLIC_LANDING_URL = "https://obaflixbr.com/baixar";

/**
 * Converte uma URL https em um Intent URI de Android (`intent://…#Intent;…;end`)
 * que pede ao sistema a ação de VIEW. Sem `package=`: deixamos o Android escolher
 * o navegador padrão ou mostrar o seletor — não fixamos Chrome, então Samsung
 * Internet, Firefox e Edge continuam valendo.
 *
 * Só aceita https e descarta querystring/hash, que quebrariam a sintaxe do
 * Intent. Devolve `null` para qualquer entrada fora disso — na prática recebe
 * apenas `PUBLIC_LANDING_URL`, uma constante, então não há entrada de usuário
 * montando intent.
 */
export function androidViewIntentUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.port || url.search || url.hash) return null;
    if (!DOWNLOAD_HOSTS_LANDING.some((host) => url.hostname === host)) return null;
    const rest = `${url.host}${url.pathname}`;
    return `intent://${rest}#Intent;scheme=https;action=android.intent.action.VIEW;end`;
  } catch {
    return null;
  }
}

/** Host permitido como destino externo da landing. Fixo, separado do host do APK. */
const DOWNLOAD_HOSTS_LANDING = ["obaflixbr.com"] as const;

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
