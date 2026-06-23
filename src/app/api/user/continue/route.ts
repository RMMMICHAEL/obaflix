import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user) return NextResponse.json(null);
  const userId = (session.user as { id: string }).id;
  const serieId = req.nextUrl.searchParams.get("serieId");

  if (!serieId) return NextResponse.json(null);

  const ultimo = await prisma.watchHistory.findFirst({
    where: { userId, serieId, concluido: false },
    orderBy: { updatedAt: "desc" },
  });

  return NextResponse.json(ultimo);
}
