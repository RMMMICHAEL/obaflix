/**
 * Endereços dos instaladores.
 *
 * Ponto único de alteração: os links definitivos ficarão no Cloudflare R2,
 * servidos por `app.obaflix.online`. Nada aqui é hospedado nem passa por proxy
 * na Vercel — são links diretos para fora.
 *
 * Enquanto o R2 não estiver pronto, deixe a URL vazia: o botão aparece
 * desabilitado com "Aguardando link definitivo" em vez de apontar para um
 * destino falso.
 */
export type Instalador = {
  url: string;
  versao: string;
  tamanho: string;
};

const env = (valor: string | undefined) => (valor ?? "").trim();

export const INSTALADORES = {
  android: {
    url: env(process.env.NEXT_PUBLIC_DOWNLOAD_ANDROID),
    versao: env(process.env.NEXT_PUBLIC_DOWNLOAD_ANDROID_VERSAO),
    tamanho: env(process.env.NEXT_PUBLIC_DOWNLOAD_ANDROID_TAMANHO),
  },
  androidTv: {
    url: env(process.env.NEXT_PUBLIC_DOWNLOAD_ANDROID_TV),
    versao: env(process.env.NEXT_PUBLIC_DOWNLOAD_ANDROID_TV_VERSAO),
    tamanho: env(process.env.NEXT_PUBLIC_DOWNLOAD_ANDROID_TV_TAMANHO),
  },
  windows: {
    url: env(process.env.NEXT_PUBLIC_DOWNLOAD_WINDOWS),
    versao: env(process.env.NEXT_PUBLIC_DOWNLOAD_WINDOWS_VERSAO),
    tamanho: env(process.env.NEXT_PUBLIC_DOWNLOAD_WINDOWS_TAMANHO),
  },
} satisfies Record<string, Instalador>;

/** Código do app na loja do Downloader (AFTV News), para Android TV / TV Box. */
export const CODIGO_DOWNLOADER = "2746802";
