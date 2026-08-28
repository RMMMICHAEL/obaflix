export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/authSession";
import { prisma } from "@/lib/prisma";

export async function GET(req: NextRequest) {
  const usuario = await getUserFromRequest(req);
  if (!usuario) return NextResponse.json(null);
  const userId = usuario.userId;
  const serieId = req.nextUrl.searchParams.get("serieId");

  if (!serieId) return NextResponse.json(null);

  const ultimo = await prisma.watchHistory.findFirst({
    where: { userId, serieId, concluido: false },
    orderBy: { updatedAt: "desc" },
  });

  return NextResponse.json(ultimo);
}
