export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/authSession";
import { prisma } from "@/lib/prisma";

export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  const usuario = await getUserFromRequest(req);
  if (!usuario) return NextResponse.json({ error: "Não autenticado" }, { status: 401 });
  const userId = usuario.userId;
  const conteudoTipo = req.nextUrl.searchParams.get("tipo") ?? "filme";

  await prisma.watchlist.delete({
    where: { userId_conteudoId_conteudoTipo: { userId, conteudoId: params.id, conteudoTipo } },
  });

  return NextResponse.json({ ok: true });
}
