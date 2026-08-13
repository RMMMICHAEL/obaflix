export const dynamic = "force-dynamic";
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { publicMedia } from "@/lib/publicMedia";

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session?.user) return NextResponse.json([], { status: 401 });
  const userId = (session.user as { id: string }).id;

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
