export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/prisma";

function isAdmin(req: NextRequest) {
  return req.headers.get("x-admin-token") === process.env.ADMIN_SECRET_TOKEN;
}

// POST /api/admin/reset-password
// Body: { email: string, novaSenha: string }
export async function POST(req: NextRequest) {
  if (!isAdmin(req)) return NextResponse.json({ error: "Não autorizado" }, { status: 403 });

  const { email, novaSenha } = await req.json();
  if (!email || !novaSenha) return NextResponse.json({ error: "email e novaSenha obrigatórios" }, { status: 400 });

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
