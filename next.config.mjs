/** @type {import('next').NextConfig} */
const nextConfig = {
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
    const securityHeaders = [
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
      {
        // Permite iframes apenas de players conhecidos; bloqueia injeção de frames externos.
        // connect-src 'self' garante que fetch/XHR só vá para nossa própria API.
        key: "Content-Security-Policy",
        value: [
          "default-src 'self'",
          // Scripts: nosso app + JW Player CDN + Chromecast SDK
          "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://ssl.p.jwpcdn.com https://www.gstatic.com",
          // Estilos
          "style-src 'self' 'unsafe-inline'",
          // Imagens: TMDB, Google, dados inline
          "img-src 'self' data: blob: https://image.tmdb.org https://lh3.googleusercontent.com",
          // Frames: players embed conhecidos (iframes de fallback)
          // Servidores sem extrator nativo caem no iframe; se o host não estiver
          // aqui o player some sem erro visível (foi o caso de strmup/vidnest,
          // servidores 3 e 4 de várias séries — Teen Wolf entre elas).
          "frame-src https://playhide.shop https://luluvdo.com https://lulu.gg https://streamwish.com https://playerwish.com https://hlswish.com https://superflixapi.pro https://*.superflixapi.pro https://strmup.to https://*.strmup.to https://vidnest.live https://*.vidnest.live",
          // HLS.js baixa segmentos diretamente dos CDNs dinâmicos dos provedores.
          "connect-src 'self' https:",
          // A reprodução nativa também pode consumir mídia HTTPS diretamente.
          "media-src 'self' blob: https:",
          // Workers (HLS.js usa blob workers)
          "worker-src 'self' blob:",
          "object-src 'none'",
          "base-uri 'self'",
          "form-action 'self'",
          "frame-ancestors 'self'",
          "upgrade-insecure-requests",
        ].join("; "),
      },
    ];
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
