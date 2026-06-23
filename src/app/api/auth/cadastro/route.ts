export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/prisma";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function POST(req: NextRequest) {
  const { nome, email, senha } = await req.json();
  if (!email || !senha) return NextResponse.json({ error: "Dados incompletos" }, { status: 400 });

  if (typeof email !== "string" || !EMAIL_RE.test(email)) {
    return NextResponse.json({ error: "Email inválido" }, { status: 400 });
  }
  if (typeof senha !== "string" || senha.length < 8) {
    return NextResponse.json(
      { error: "A senha deve ter pelo menos 8 caracteres" },
      { status: 400 },
    );
  }
  // Exige ao menos uma letra e um número.
  if (!/[a-zA-Z]/.test(senha) || !/[0-9]/.test(senha)) {
    return NextResponse.json(
      { error: "A senha deve conter letras e números" },
      { status: 400 },
    );
  }

  const existe = await prisma.user.findUnique({ where: { email } });
  if (existe) return NextResponse.json({ error: "Email já cadastrado" }, { status: 409 });

  const senhaHash = await bcrypt.hash(senha, 10);
  const user = await prisma.user.create({ data: { nome, email, senhaHash } });

  return NextResponse.json({ id: user.id, email: user.email });
}
