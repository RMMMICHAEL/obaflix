import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  const session = await getServerSession(authOptions);
  if (!session?.user) return NextResponse.json({ error: "Não autenticado" }, { status: 401 });
  const userId = (session.user as { id: string }).id;
  const conteudoTipo = req.nextUrl.searchParams.get("tipo") ?? "filme";

  await prisma.watchlist.delete({
    where: { userId_conteudoId_conteudoTipo: { userId, conteudoId: params.id, conteudoTipo } },
  });

  return NextResponse.json({ ok: true });
}
