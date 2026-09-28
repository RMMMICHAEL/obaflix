import { NextRequest, NextResponse } from "next/server";
import { requireAdminSession } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const guard = await requireAdminSession(req); if (guard) return guard;
  const user = await prisma.user.findUnique({ where: { id: params.id }, select: {
    id: true, nome: true, email: true, role: true, createdAt: true,
    assinaturas: { orderBy: { terminaEm: "desc" }, select: { id: true, status: true, iniciaEm: true, terminaEm: true, origem: true, telasAdicionais: true, servidorVip: true, plano: { select: { id: true, nome: true } } } },
    dispositivos: { orderBy: { ultimoUso: "desc" }, select: { id: true, nome: true, modelo: true, criadoEm: true, ultimoUso: true, revogadoEm: true, ultimaRede: true } },
  } });
  if (!user) return NextResponse.json({ error: "Usuário não encontrado" }, { status: 404 });
  return NextResponse.json(user);
}
