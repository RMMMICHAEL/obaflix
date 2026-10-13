import { NextRequest, NextResponse } from "next/server";
import { LevelPlayRewards, s2sReceiverConfigurado, type Commission } from "@/lib/ads/levelplayRewarded";
export const dynamic = "force-dynamic";
function createCallbackHandler(deps = {
  enabled: s2sReceiverConfigurado,
  secret: () => process.env.LEVELPLAY_S2S_PRIVATE_KEY ?? "",
  process: (input: Commission, secret: string) => new LevelPlayRewards().callback(input, secret),
}) {
return async function callback(req: NextRequest) {
  const headers = { "Cache-Control": "no-store" };
  if (!deps.enabled()) return new NextResponse("Unavailable", { status: 503, headers });
  if (req.nextUrl.protocol !== "https:") return new NextResponse("HTTPS required", { status: 400, headers });
  const fields = ["applicationUserId", "eventId", "timestamp", "rewards", "signature"] as const;
  const params = req.nextUrl.searchParams;
  if (fields.some(key => params.getAll(key).length !== 1)) return new NextResponse("Invalid", { status: 400, headers });
  const input = Object.fromEntries(fields.map(key => [key, params.get(key)])) as unknown as Commission;
  try {
    const result = await deps.process(input, deps.secret());
    return new NextResponse(result === "ok" ? `${input.eventId}:OK` : "Rejected", { status: result === "ok" ? 200 : 403, headers });
  } catch {
    return new NextResponse("Unavailable", { status: 503, headers });
  }
};
}
export const GET = Object.assign(createCallbackHandler(), { createForTest: createCallbackHandler });
