import { NextRequest, NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/prisma";

export async function POST(req: NextRequest) {
  const { nome, email, senha } = await req.json();
  if (!email || !senha) return NextResponse.json({ error: "Dados incompletos" }, { status: 400 });

  const existe = await prisma.user.findUnique({ where: { email } });
  if (existe) return NextResponse.json({ error: "Email já cadastrado" }, { status: 409 });

  const senhaHash = await bcrypt.hash(senha, 10);
  const user = await prisma.user.create({ data: { nome, email, senhaHash } });

  return NextResponse.json({ id: user.id, email: user.email });
}
