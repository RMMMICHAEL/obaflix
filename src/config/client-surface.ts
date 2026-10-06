import { detectAndroidMode } from "@/components/layout/AppMode";

/**
 * Qual superfície está renderizando AGORA, decidido no cliente.
 *
 * O roteamento por ambiente vive no servidor (`site-mode.ts`, via middleware),
 * mas as fichas de catálogo são a MESMA página cacheada para os três públicos —
 * o HTML é idêntico para navegador, Electron e Android. Então o que muda o
 * comportamento de um clique em Assistir (abrir o player vs. abrir o modal de
 * download) só pode ser decidido depois da hidratação, aqui.
 *
 * Isto NÃO é segredo nem autenticação: é a mesma leitura de ambiente que o
 * middleware já faz, só que no cliente. Diz qual interface entregar, nunca quem
 * a pessoa é nem o que pode acessar.
 */

/**
 * `true` apenas no navegador comum: nem WebView do Android, nem janela do
 * Electron. É quem não tem player — e para quem o clique em Assistir deve virar
 * o convite para baixar o aplicativo.
 *
 * As duas negações reaproveitam os sinais já usados no projeto:
 *   - Android: `detectAndroidMode` (UA `ObaflixApp/`, `__OBAFLIX_ANDROID__`,
 *     `obaflixDesktop.platform === "android"`, sessionStorage do modo app);
 *   - Electron: a ponte `obaflixDesktop.isDesktop` (só o preload a define) ou o
 *     User-Agent `ObaflixDesktop/` das versões já instaladas.
 */
export function ehNavegadorComum(pathname: string): boolean {
  if (typeof window === "undefined") return false;
  if (detectAndroidMode(pathname)) return false;

  const ponte = (window as { obaflixDesktop?: { isDesktop?: unknown; platform?: unknown } })
    .obaflixDesktop;
  if (ponte?.isDesktop === true && ponte.platform !== "android") return false;
  if (/ObaflixDesktop\//i.test(navigator.userAgent)) return false;

  return true;
}
