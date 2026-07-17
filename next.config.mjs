/** @type {import('next').NextConfig} */
const nextConfig = {
  eslint: { ignoreDuringBuilds: true },
  typescript: { ignoreBuildErrors: true },
  images: {
    remotePatterns: [
      { protocol: "https", hostname: "image.tmdb.org" },
      { protocol: "https", hostname: "lh3.googleusercontent.com" },
    ],
    formats: ["image/avif", "image/webp"],
    minimumCacheTTL: 86400,
  },
  async headers() {
    const securityHeaders = [
      { key: "X-Frame-Options", value: "SAMEORIGIN" },
      { key: "X-Content-Type-Options", value: "nosniff" },
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
          "frame-src https://playhide.shop https://luluvdo.com https://lulu.gg https://streamwish.com https://playerwish.com https://hlswish.com",
          // Conexões: apenas nossa API + CDNs dos players já proxiados
          "connect-src 'self'",
          // Media: nosso proxy (segmentos HLS/MP4)
          "media-src 'self' blob:",
          // Workers (HLS.js usa blob workers)
          "worker-src 'self' blob:",
        ].join("; "),
      },
    ];
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
