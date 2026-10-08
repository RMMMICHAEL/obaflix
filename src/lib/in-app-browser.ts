/**
 * Detecção de navegador interno de aplicativo (in-app browser / WebView) no
 * Android.
 *
 * Para quê: a landing `/baixar` entrega o APK por `/download/android`. Dentro do
 * navegador embutido de alguns aplicativos — o caso confirmado é o do feed de
 * vídeos onde o link costuma ser colado — o toque em "Baixar para Android" não
 * inicia o download do APK. A página precisa, então, oferecer primeiro "Abrir no
 * navegador" e só depois o download.
 *
 * Princípios:
 *   - **Conservador.** Na dúvida, classificamos como `browser`. É pior bloquear
 *     um Chrome de verdade do que deixar um WebView passar: o segundo ainda vê o
 *     botão de download, só não o atalho de abrir fora.
 *   - **Só Android.** O fluxo do APK é do Android. iOS e desktop retornam
 *     `browser` de propósito — não queremos mexer no que já funciona neles.
 *   - **Aplicativos oficiais nunca.** O WebView do APK do Obaflix e o Chromium do
 *     Electron carregam o próprio site; eles não podem receber "abra no
 *     navegador". Identificamos pelos mesmos marcadores de User-Agent que o
 *     roteamento de ambiente já usa (`ObaflixApp/`, `ObaflixDesktop/`).
 *   - **Função pura.** Recebe a string do User-Agent e nada mais. Sem `window`,
 *     sem rede, sem efeito colateral — para ser testável com User-Agents reais.
 *
 * Nenhum User-Agent é coletado, logado ou enviado a lugar nenhum: a string é
 * lida, classificada e descartada no próprio cliente.
 */

export type InAppBrowser =
  | "tiktok"
  | "instagram"
  | "facebook"
  | "android-webview"
  | "browser";

/** Clientes oficiais do Obaflix. Nunca são tratados como navegador interno. */
const OBAFLIX_OFICIAL = /ObaflixApp\/|ObaflixDesktop\//i;

/**
 * Sinais de WebView do aplicativo de vídeos (ByteDance). Vários tokens em vez de
 * um só porque a composição do User-Agent varia por versão e por região
 * (app internacional, app "Trill", webview da ByteDance). Qualquer um basta.
 * São tokens distintivos, então casamos por substring — sem fronteira de
 * palavra, que falharia em `trill_2022…` e `musical_ly_2022…`.
 */
const TIKTOK = /bytedancewebview|musical_ly|trill_|aweme|bytelocale|bytefullscreen|zhiliaoapp|tiktok/i;

/** Navegador embutido do Instagram. */
const INSTAGRAM = /\binstagram\b/i;

/** Família Facebook/Messenger: FBAN, FBAV, FB_IAB, FB4A, FBSV, Orca (Messenger). */
const FACEBOOK = /\bfb(?:an|av|_iab|4a|sv)\b|\borca\b/i;

/**
 * Marcador padrão do WebView do Android: o token `wv` dentro do bloco de
 * plataforma, p.ex. `(Linux; Android 13; SM-G991B Build/...; wv)`. Chrome,
 * Samsung Internet, Firefox, Edge e Opera **não** o incluem.
 */
const ANDROID_WEBVIEW = /;\s*wv[);]/i;

/**
 * Classifica o User-Agent num rótulo fechado. A ordem importa: marcas conhecidas
 * primeiro (recebem rótulo específico), WebView genérico por último.
 */
export function detectInAppBrowser(userAgent: string): InAppBrowser {
  const ua = (userAgent ?? "").trim();
  if (!ua) return "browser";

  // Fora do Android o fluxo do APK não se aplica: não mexemos em iOS nem desktop.
  if (!/android/i.test(ua)) return "browser";

  // Nossos próprios aplicativos carregam o site num WebView/Chromium: jamais os
  // empurramos para "abrir no navegador".
  if (OBAFLIX_OFICIAL.test(ua)) return "browser";

  if (TIKTOK.test(ua)) return "tiktok";
  if (INSTAGRAM.test(ua)) return "instagram";
  if (FACEBOOK.test(ua)) return "facebook";
  if (ANDROID_WEBVIEW.test(ua)) return "android-webview";

  return "browser";
}

/** `true` quando é um navegador interno de aplicativo no Android. */
export function isAndroidInAppBrowser(userAgent: string): boolean {
  return detectInAppBrowser(userAgent) !== "browser";
}
