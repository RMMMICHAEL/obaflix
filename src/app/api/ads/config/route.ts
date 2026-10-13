import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/authSession";
import { entitlementsDoUsuario } from "@/lib/entitlements";
import { exigeAnuncio } from "@/lib/ads/politica";
import { ehClientePlay } from "@/config/play";
import { adsRemoteConfig } from "@/lib/ads/remoteConfig";
import { rewardedConfigurado } from "@/lib/ads/levelplayRewarded";
export const dynamic = "force-dynamic";
export async function GET(req: NextRequest) {
  const headers = { "Cache-Control": "no-store" };
  const off = adsRemoteConfig(undefined, true, false);
  const user = await getUserFromRequest(req);
  if (!user || !/ObaflixApp\//i.test(req.headers.get("user-agent") ?? "")) return NextResponse.json(off, { headers });
  try {
    const rights = await entitlementsDoUsuario(user.userId);
    const config = adsRemoteConfig(process.env.LEVELPLAY_REMOTE_CONFIG, ehClientePlay(req.headers.get("user-agent")), exigeAnuncio(rights.direitos));
    config.rewarded = config.rewarded && rewardedConfigurado();
    return NextResponse.json(config, { headers });
  } catch { return NextResponse.json(off, { headers }); }
}
