export const AD_PLACEMENTS = ["home", "filmes", "series", "animes", "kids", "detail", "playback"] as const;
export type AdPlacement = typeof AD_PLACEMENTS[number];
export interface AdsRemoteConfig {
  interstitial: boolean; rewarded: boolean; banner: boolean; appOpen: boolean;
  placements: AdPlacement[]; sessionCap: number; intervalSeconds: number;
}
const OFF: AdsRemoteConfig = { interstitial: false, rewarded: false, banner: false, appOpen: false,
  placements: [], sessionCap: 0, intervalSeconds: 120 };
/** Server-owned environment config, no URLs, credentials, executable values or IDs. */
export function adsRemoteConfig(raw: string | undefined, play: boolean, eligible: boolean): AdsRemoteConfig {
  if (!eligible || !raw || raw.length > 2048) return { ...OFF };
  try {
    const value = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) return { ...OFF };
    return {
      interstitial: !play && value.interstitial === true,
      rewarded: value.rewarded === true,
      banner: value.banner === true,
      // App Open remains closed for both builds until a separate review enables it.
      appOpen: false,
      placements: Array.isArray(value.placements) ? AD_PLACEMENTS.filter(p => p !== "kids" && value.placements.includes(p)) : [],
      sessionCap: typeof value.sessionCap === "number" && Number.isFinite(value.sessionCap) ? Math.floor(Math.max(0, Math.min(4, value.sessionCap))) : 0,
      intervalSeconds: typeof value.intervalSeconds === "number" && Number.isFinite(value.intervalSeconds) ? Math.floor(Math.min(86400, Math.max(120, value.intervalSeconds))) : 120,
    };
  } catch { return { ...OFF }; }
}
