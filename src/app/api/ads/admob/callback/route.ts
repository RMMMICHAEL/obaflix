import { NextRequest, NextResponse } from "next/server";
import { googleSsvKeys, InvalidSsv, unitsFromEnv, verifySsv } from "@/lib/ads/admobSsv";
import { AdmobRewards } from "@/lib/ads/admobStore";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
function createHandler(deps = {
  enabled: () => process.env.ADMOB_SSV_RECEIVER_ENABLED === "true",
  units: unitsFromEnv,
  keys: googleSsvKeys as Pick<typeof googleSsvKeys, "get">,
  receive: (event: Awaited<ReturnType<typeof verifySsv>>) => new AdmobRewards().receive(event),
  now: Date.now,
}) {
  return async function callback(req: NextRequest) {
    const headers = { "Cache-Control": "no-store" };
    const units = deps.units();
    if (!deps.enabled() || !units) return new NextResponse("Unavailable", { status: 503, headers });
    if (req.nextUrl.protocol !== "https:") return new NextResponse("HTTPS required", { status: 400, headers });
    try {
      // Preserve original percent escaping and parameter order. No reserialization.
      const query = new URL(req.url).search.slice(1);
      const event = await verifySsv(query, deps.keys, units, deps.now());
      await deps.receive(event);
      return new NextResponse("OK", { status: 200, headers });
    } catch (error) {
      return new NextResponse("Unavailable", { status: error instanceof InvalidSsv ? 403 : 503, headers });
    }
  };
}
export const GET = Object.assign(createHandler(), { createForTest: createHandler });
