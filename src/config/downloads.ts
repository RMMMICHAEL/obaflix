/**
 * Endereços dos instaladores.
 *
 * Ponto único de alteração. Os arquivos vivem no Cloudflare R2, servidos por
 * `app.obaflix.online` — nada é hospedado nem passa por proxy na Vercel.
 *
 * O padrão fica no código de propósito: é o link que está publicado hoje, e
 * uma variável esquecida no painel não pode derrubar o botão de download. As
 * variáveis de ambiente continuam vencendo quando presentes, para trocar de
 * versão sem deploy.
 *
 * Ao subir uma versão nova: mude a URL, a versão e o tamanho juntos. O tamanho
 * é o `Content-Length` real do arquivo — quem baixa em rede móvel decide por
 * ele.
 */
export type Instalador = {
  url: string;
  versao: string;
  tamanho: string;
};

const ou = (valor: string | undefined, padrao: string) => (valor ?? "").trim() || padrao;

export const INSTALADORES = {
  android: {
    url: ou(process.env.NEXT_PUBLIC_DOWNLOAD_ANDROID, "https://app.obaflix.online/Obaflix-1.0.10.apk"),
    versao: ou(process.env.NEXT_PUBLIC_DOWNLOAD_ANDROID_VERSAO, "Versão 1.0.10"),
    tamanho: ou(process.env.NEXT_PUBLIC_DOWNLOAD_ANDROID_TAMANHO, "10,7 MB"),
  },
  androidTv: {
    url: ou(process.env.NEXT_PUBLIC_DOWNLOAD_ANDROID_TV, "https://app.obaflix.online/Obaflix-TV-0.7.21.apk"),
    versao: ou(process.env.NEXT_PUBLIC_DOWNLOAD_ANDROID_TV_VERSAO, "Versão 0.7.21"),
    tamanho: ou(process.env.NEXT_PUBLIC_DOWNLOAD_ANDROID_TV_TAMANHO, "5,2 MB"),
  },
  windows: {
    url: ou(
      process.env.NEXT_PUBLIC_DOWNLOAD_WINDOWS,
      "https://app.obaflix.online/Obaflix-Setup-1.0.10.exe",
    ),
    versao: ou(process.env.NEXT_PUBLIC_DOWNLOAD_WINDOWS_VERSAO, "Versão 1.0.10"),
    tamanho: ou(process.env.NEXT_PUBLIC_DOWNLOAD_WINDOWS_TAMANHO, "116,3 MB"),
  },
} satisfies Record<string, Instalador>;

/** Código do app na loja do Downloader (AFTV News), para Android TV / TV Box. */
export const CODIGO_DOWNLOADER = "2746802";
