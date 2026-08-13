import { assertSafeUrl } from "./ssrf";

// Server-side extraction is intentionally limited to providers used by the
// product. This prevents authenticated accounts from turning the app into an
// arbitrary outbound-request service.
const PROVIDER_HOSTS = [
  "playerflix.ink",
  "webcinevs2.com",
  "playhide.shop",
  "hidehide.shop",
  "vidhidehub.com",
  "streamwish.com",
  "playerwish.com",
  "hlswish.com",
  "wishonly.site",
  "cdnwish.com",
  "asnwish.com",
  "swishsrv.com",
  "luluvdo.com",
  "lulu.gg",
  "luluvid.com",
  "lulustream.com",
  "embedplayer1.xyz",
  "embedplayer2.xyz",
  "xn--kcksk7a2bl5le7b6doc1h3f.com",
  "llanfairpwllgwyngy.com",
  "boltcdn.xyz",
  "upbolt.to",
  "bigshare.link",
  "superflixapi.pro",
  "v1.watchplay.shop",
  "megafrixapi.com",
] as const;

function matchesHost(hostname: string, allowed: string): boolean {
  return hostname === allowed || hostname.endsWith(`.${allowed}`);
}

export async function assertAllowedMediaUrl(raw: string): Promise<URL> {
  const parsed = await assertSafeUrl(raw);
  if (parsed.protocol !== "https:") throw new Error("protocolo de mídia não permitido");
  const hostname = parsed.hostname.toLowerCase();
  if (!PROVIDER_HOSTS.some((allowed) => matchesHost(hostname, allowed))) {
    throw new Error("provedor de mídia não permitido");
  }
  return parsed;
}
