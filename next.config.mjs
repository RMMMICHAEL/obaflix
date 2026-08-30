/**
 * Hosts autorizados como iframe de fallback.
 *
 * Ficavam embutidos aqui, e por isso o header CSP publicava a lista de
 * provedores em TODA resposta — inclusive para visitante anônimo na home, que
 * nunca chega perto de um player. Agora vêm de PLAYER_FRAME_HOSTS (lista
 * separada por vírgula, sem esquema), e o header só é emitido nas rotas que
 * realmente montam iframe.
 *
 * Sem a variável configurada vale a lista abaixo, que é a que já estava em uso.
 * Deixar o padrão vazio seria uma quebra silenciosa: servidores sem extrator
 * caem no iframe e sumiriam do menu sem erro visível — foi exatamente o caso de
 * strmup e vidnest. A variável existe para estreitar a lista por deploy, nunca
 * para ser o único lugar que a define.
 */
const FRAME_HOSTS_PADRAO = [
  "playhide.shop", "luluvdo.com", "lulu.gg", "streamwish.com", "playerwish.com",
  "hlswish.com", "superflixapi.pro", "strmup.to", "vidnest.live",
];

const frameSrc = (process.env.PLAYER_FRAME_HOSTS
  ? process.env.PLAYER_FRAME_HOSTS.split(",").map((h) => h.trim()).filter(Boolean)
  : FRAME_HOSTS_PADRAO)
  .flatMap((h) => [`https://${h}`, `https://*.${h}`])
  .join(" ") || "'none'";

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
    //
    // Só /assistir/* monta iframe de provedor. /player usa <video> via
    // StreamPlayer e não precisa da lista — fica na regra restritiva.
    // Fichas de filme e serie: cache no CDN, nao no framework.
    //
    // As duas rotas sao `force-dynamic` de proposito (ver a nota em
    // src/app/filme/[id]/page.tsx). Sem ISR nao existe entrada de cache por
    // titulo, e portanto nao existe ISR Write quando um crawler percorre o
    // catalogo — o que sobra e uma invocacao de funcao no miss e nada no hit.
    //
    // O Next so define o proprio `Cache-Control` quando a resposta ainda nao tem
    // um, entao este valor prevalece. `stale-while-revalidate` evita que a
    // expiracao devolva uma espera sincrona ao visitante.
    //
    // 404 tambem entra no cache, e isso e desejado: id inexistente descoberto
    // por bot para de custar uma invocacao por acesso.
    const cacheCdn = (sMaxAge, swr) => ({
      key: "Cache-Control",
      value: `public, s-maxage=${sMaxAge}, stale-while-revalidate=${swr}`,
    });

    return [
      { source: "/assistir/:path*", headers: [...baseHeaders, csp(frameSrc)] },
      { source: "/((?!assistir).*)", headers: [...baseHeaders, csp("'none'")] },
      // 6h: a ficha de filme so muda quando o sync reescreve a linha.
      { source: "/filme/:id*", headers: [cacheCdn(21600, 86400)] },
      // 1h: serie no ar ganha episodio, e sem ISR nada purga antes da expiracao.
      { source: "/serie/:id*", headers: [cacheCdn(3600, 86400)] },
    ];
  },
};

export default nextConfig;
