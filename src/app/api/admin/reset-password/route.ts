export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/auth";

// GET /api/admin/reset-password — lista todos os usuários
export async function GET(req: NextRequest) {
  const guard = await requireAdmin(req); if (guard) return guard;

  const users = await prisma.user.findMany({
    select: { id: true, email: true, nome: true, role: true, createdAt: true },
    orderBy: { createdAt: "desc" },
  });

  return NextResponse.json(users);
}

// POST /api/admin/reset-password
// Body: { email: string, novaSenha: string }
export async function POST(req: NextRequest) {
  const guard = await requireAdmin(req); if (guard) return guard;

  const { email, novaSenha } = await req.json();
  if (!email || !novaSenha) return NextResponse.json({ error: "email e novaSenha obrigatórios" }, { status: 400 });
  if (typeof novaSenha !== "string" || novaSenha.length < 12 || novaSenha.length > 128) {
    return NextResponse.json({ error: "A nova senha deve ter entre 12 e 128 caracteres" }, { status: 400 });
  }

  const user = await prisma.user.findFirst({
    where: { email: { equals: email, mode: "insensitive" } },
  });

  if (!user) return NextResponse.json({ error: "Usuário não encontrado" }, { status: 404 });

  const senhaHash = await bcrypt.hash(novaSenha, 10);
  await prisma.user.update({
    where: { id: user.id },
    data: { senhaHash, email: user.email.toLowerCase() },
  });

  return NextResponse.json({ ok: true, email: user.email.toLowerCase() });
}
