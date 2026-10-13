import { NextRequest, NextResponse } from "next/server";
import { optionalChallengesEnabled, unitsFromEnv } from "@/lib/ads/admobSsv";
import { AdmobRewards } from "@/lib/ads/admobStore";
import { optionalRequestScope } from "@/lib/ads/admobOptionalRequest";
import { readJsonBody } from "@/lib/requestSecurity";
export const dynamic = "force-dynamic";
export async function POST(req: NextRequest) {
  const headers = { "Cache-Control": "no-store" };
  if (!optionalChallengesEnabled()) return NextResponse.json({ state: "unavailable", eligibleForAd: false, benefitGranted: false }, { status: 503, headers });
  try {
    const scope = await optionalRequestScope(req);
    const units = unitsFromEnv();
    if (!scope || !units) return new NextResponse(null, { status: 403, headers });
    const body = await readJsonBody<{ nonce?: unknown; cancelar?: unknown }>(req, 512);
    if (typeof body.nonce !== "string") return new NextResponse(null, { status: 400, headers });
    return NextResponse.json(await new AdmobRewards().status(body.nonce, scope.accountId, scope.distribution, units, body.cancelar === true), { headers });
  } catch { return NextResponse.json({ state: "unavailable", eligibleForAd: false, benefitGranted: false }, { status: 503, headers }); }
}
