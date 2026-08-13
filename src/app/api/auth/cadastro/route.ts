export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/prisma";
import { checkRateLimit, clientIp, readJsonBody } from "@/lib/requestSecurity";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function POST(req: NextRequest) {
  const rate = await checkRateLimit(`signup:${clientIp(req)}`, 5, 15 * 60);
  if (!rate.allowed) {
    return NextResponse.json(
      { error: "Muitas tentativas. Aguarde alguns minutos e tente novamente." },
      { status: 429, headers: { "Retry-After": "900" } },
    );
  }

  let body: { nome?: unknown; email?: unknown; senha?: unknown };
  try { body = await readJsonBody(req, 4096); }
  catch { return NextResponse.json({ error: "Dados inválidos" }, { status: 400 }); }
  const { nome, email, senha } = body;
  if (!email || !senha) return NextResponse.json({ error: "Dados incompletos" }, { status: 400 });

  if (typeof email !== "string" || !EMAIL_RE.test(email)) {
    return NextResponse.json({ error: "Email inválido" }, { status: 400 });
  }
  if (typeof senha !== "string" || senha.length < 8 || senha.length > 128) {
    return NextResponse.json(
      { error: "A senha deve ter entre 8 e 128 caracteres" },
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

  const normalizedEmail = email.toLowerCase().trim();
  if (normalizedEmail.length > 254 || (nome != null && (typeof nome !== "string" || nome.trim().length > 80))) {
    return NextResponse.json({ error: "Dados inválidos" }, { status: 400 });
  }
  const existe = await prisma.user.findUnique({ where: { email: normalizedEmail } });
  if (existe) return NextResponse.json({ error: "Não foi possível criar a conta com esses dados" }, { status: 409 });

  const senhaHash = await bcrypt.hash(senha, 10);
  const user = await prisma.user.create({ data: { nome: typeof nome === "string" ? nome.trim() || null : null, email: normalizedEmail, senhaHash } });

  return NextResponse.json({ id: user.id, email: user.email });
}
