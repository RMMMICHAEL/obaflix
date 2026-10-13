import { NextRequest, NextResponse } from "next/server";
import { optionalChallengesEnabled, unitsFromEnv } from "@/lib/ads/admobSsv";
import { AdmobRewards } from "@/lib/ads/admobStore";
import { optionalRequestScope } from "@/lib/ads/admobOptionalRequest";
import { readJsonBody } from "@/lib/requestSecurity";
import { prisma } from "@/lib/prisma";
export const dynamic = "force-dynamic";
export async function POST(req: NextRequest) {
  const headers = { "Cache-Control": "no-store" };
  // No optional benefit policy exists yet. This fixed code gate keeps issuance off.
  if (!optionalChallengesEnabled()) return NextResponse.json({ state: "unavailable", benefitGranted: false }, { status: 503, headers });
  try {
    const scope = await optionalRequestScope(req);
    const units = unitsFromEnv();
    if (!scope || !units) return new NextResponse(null, { status: 403, headers });
    const body = await readJsonBody<{ tipo?: unknown; conteudoId?: unknown; temporada?: unknown; episodio?: unknown }>(req, 1024);
    if ((body.tipo !== "filme" && body.tipo !== "serie") || typeof body.conteudoId !== "string" || body.conteudoId.length > 128) return new NextResponse(null, { status: 400, headers });
    const exists = body.tipo === "filme" ? await prisma.filme.findUnique({ where: { id: body.conteudoId }, select: { id: true } }) :
      await prisma.serie.findUnique({ where: { id: body.conteudoId }, select: { id: true } });
    if (!exists) return new NextResponse(null, { status: 404, headers });
    // No content/access purpose is accepted from the client. The sole stored purpose
    // is an unapproved optional placeholder, never reproducao/download/transmissao.
    const result = await new AdmobRewards().openAuthorized({ ...scope, target: { tipo: body.tipo, conteudoId: body.conteudoId } }, units);
    return NextResponse.json({ ...result, protocol: "admob-ssv-v1", benefitGranted: false }, { headers });
  } catch { return NextResponse.json({ state: "unavailable", benefitGranted: false }, { status: 503, headers }); }
}
