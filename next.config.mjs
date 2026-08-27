/**
 * Hosts autorizados como iframe de fallback.
 *
 * Ficavam embutidos aqui, e por isso o header CSP publicava a lista de
 * provedores em TODA resposta — inclusive para visitante anônimo na home, que
 * nunca chega perto de um player. Agora vêm de PLAYER_FRAME_HOSTS (lista
 * separada por vírgula, sem esquema), e o header só é emitido nas rotas que
 * realmente montam iframe.
 *
 * Sem a variável configurada, nenhum iframe de terceiro é autorizado. É a
 * falha segura correta: um provedor a mais some do menu, em vez de a lista
 * inteira vazar por padrão.
 */
const FRAME_HOSTS = (process.env.PLAYER_FRAME_HOSTS ?? "")
  .split(",")
  .map((h) => h.trim())
  .filter(Boolean)
  .flatMap((h) => [`https://${h}`, `https://*.${h}`]);

const frameSrc = FRAME_HOSTS.length ? FRAME_HOSTS.join(" ") : "'none'";

/** @type {import('next').NextConfig} */
const nextConfig = {
  eslint: { ignoreDuringBuilds: true },
  typescript: { ignoreBuildErrors: true },
  poweredByHeader: false,
  images: {
    unoptimized: true,
    remotePatterns: [
      { protocol: "https", hostname: "image.tmdb.org" },
      { protocol: "https", hostname: "lh3.googleusercontent.com" },
    ],
  },
  async headers() {
    const baseHeaders = [
      { key: "X-Frame-Options", value: "SAMEORIGIN" },
      { key: "X-Content-Type-Options", value: "nosniff" },
      { key: "X-DNS-Prefetch-Control", value: "off" },
      { key: "Cross-Origin-Opener-Policy", value: "same-origin-allow-popups" },
      { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
      { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
      {
        key: "Strict-Transport-Security",
        value: "max-age=63072000; includeSubDomains; preload",
      },
    ];

    // connect-src 'self' garante que fetch/XHR so va para nossa propria API.
    const csp = (frame) => ({
      key: "Content-Security-Policy",
      value: [
        "default-src 'self'",
        // Scripts: nosso app + JW Player CDN + Chromecast SDK
        "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://ssl.p.jwpcdn.com https://www.gstatic.com",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: blob: https://image.tmdb.org https://lh3.googleusercontent.com",
        `frame-src ${frame}`,
        // HLS.js baixa segmentos diretamente dos CDNs dinamicos dos provedores.
        "connect-src 'self' https:",
        // A reproducao nativa tambem pode consumir midia HTTPS diretamente.
        "media-src 'self' blob: https:",
        "worker-src 'self' blob:",
        "object-src 'none'",
        "base-uri 'self'",
        "form-action 'self'",
        "frame-ancestors 'self'",
        "upgrade-insecure-requests",
      ].join("; "),
    });

    // Duas regras que NAO se sobrepoem: a segunda usa lookahead negativo para
    // excluir as rotas de reproducao. Sem isso, duas regras casariam no mesmo
    // caminho e a precedencia entre elas ficaria implicita.
    //
    // Servidores sem extrator nativo caem no iframe; se o host nao estiver em
    // PLAYER_FRAME_HOSTS o player some sem erro visivel (foi o caso de
    // strmup/vidnest, servidores 3 e 4 de varias series).
    return [
      { source: "/assistir/:path*", headers: [...baseHeaders, csp(frameSrc)] },
      { source: "/player/:path*", headers: [...baseHeaders, csp(frameSrc)] },
      { source: "/((?!assistir|player).*)", headers: [...baseHeaders, csp("'none'")] },
    ];
  },
};

export default nextConfig;
