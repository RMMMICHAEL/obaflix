import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/authSession";
import { checkRateLimit, headerMatchesHost, readJsonBody } from "@/lib/requestSecurity";
import { LevelPlayRewards, rewardedConfigurado } from "@/lib/ads/levelplayRewarded";
import { ehClientePlay } from "@/config/play";
export const dynamic = "force-dynamic";
export async function POST(req: NextRequest) {
  const headers = { "Cache-Control": "no-store" };
  if (!rewardedConfigurado()) return NextResponse.json({ state: "unavailable" }, { status: 503, headers });
  const origin = req.headers.get("origin");
  if (origin && !headerMatchesHost(origin, req.headers.get("host") ?? "")) return new NextResponse(null, { status: 403, headers });
  const user = await getUserFromRequest(req);
  if (!user) return new NextResponse(null, { status: 401, headers });
  try {
    if (!(await checkRateLimit(`ads:levelplay:status:${user.userId}`, 120, 60)).allowed) return new NextResponse(null, { status: 429, headers });
    const body = await readJsonBody<{ desafioId?: unknown; cancelar?: unknown }>(req, 512);
    if (typeof body.desafioId !== "string") return new NextResponse(null, { status: 400, headers });
    // Distribution is derived from the existing request contract, never from body.
    // UA is not attestation; the missing signed-build guarantee keeps grants off.
    const distribution = ehClientePlay(req.headers.get("user-agent")) ? "play" : "direct";
    const service = new LevelPlayRewards();
    if (body.cancelar === true) return NextResponse.json({ state: "unavailable", cancelled: await service.cancel(body.desafioId, user.userId, distribution) }, { headers });
    return NextResponse.json(await service.status(body.desafioId, user.userId, distribution), { headers });
  } catch {
    return NextResponse.json({ state: "unavailable" }, { status: 503, headers });
  }
}
