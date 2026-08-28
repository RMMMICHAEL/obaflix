export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/authSession";
import { prisma } from "@/lib/prisma";
import { publicMedia } from "@/lib/publicMedia";

export async function GET(req: NextRequest) {
  const usuario = await getUserFromRequest(req);
  if (!usuario) return NextResponse.json([], { status: 401 });
  const userId = usuario.userId;

  const historico = await prisma.watchHistory.findMany({
    where: { userId, concluido: false },
    orderBy: { updatedAt: "desc" },
    take: 20,
    include: {
      filme: true,
      serie: true,
    },
  });

  return NextResponse.json(historico.map((item) => ({
    ...item,
    filme: item.filme ? publicMedia(item.filme) : null,
  })));
}
