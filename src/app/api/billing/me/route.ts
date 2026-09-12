import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/authSession";
import { entitlementsDoUsuario } from "@/lib/entitlements";
import { prisma } from "@/lib/prisma";
export const dynamic = "force-dynamic";
export async function GET(req: NextRequest) {
  const user = await getUserFromRequest(req);
  if (!user) return NextResponse.json({ error: "Acesso negado" }, { status: 401 });
  const entitlements = await entitlementsDoUsuario(user.userId);
  const assinatura = entitlements.assinatura.ativa ? await prisma.assinatura.findFirst({
    where: { userId: user.userId, status: "ATIVA", iniciaEm: { lte: new Date() }, terminaEm: { gt: new Date() } },
    select: { terminaEm: true },
  }) : null;
  return NextResponse.json({ plano: { id: entitlements.assinatura.planoId }, assinatura: assinatura ? { status: "ATIVA", terminaEm: assinatura.terminaEm } : null }, { headers: { "Cache-Control": "no-store" } });
}
