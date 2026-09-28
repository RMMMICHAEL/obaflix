export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/prisma";
import { recordAdminAudit, requireAdminAction } from "@/lib/admin-action";
import { readJsonBody } from "@/lib/requestSecurity";

// POST /api/admin/reset-password
// Body: { userId: string, novaSenha: string, motivo: string }
export async function POST(req: NextRequest) {
  const auth = await requireAdminAction(req, "reset-password"); if (auth.response) return auth.response;

  let body: Record<string, unknown>;
  try {
    body = await readJsonBody(req, 2048);
  } catch {
    return NextResponse.json({ error: "Payload inválido" }, { status: 400 });
  }
  const { userId, novaSenha, motivo } = body;
  if (typeof userId !== "string") return NextResponse.json({ error: "userId obrigatório" }, { status: 400 });
  if (!userId || !novaSenha || typeof motivo !== "string" || motivo.trim().length < 5) return NextResponse.json({ error: "userId, novaSenha e motivo (mínimo 5 caracteres) são obrigatórios" }, { status: 400 });
  if (typeof novaSenha !== "string" || novaSenha.length < 12 || novaSenha.length > 128) {
    return NextResponse.json({ error: "A nova senha deve ter entre 12 e 128 caracteres" }, { status: 400 });
  }

  const user = await prisma.user.findUnique({ where: { id: userId } });

  if (!user) return NextResponse.json({ error: "Usuário não encontrado" }, { status: 404 });

  const senhaHash = await bcrypt.hash(novaSenha, 10);
  await prisma.user.update({
    where: { id: user.id },
    data: { senhaHash, email: user.email.toLowerCase() },
  });
  await recordAdminAudit({ adminUserId: auth.adminUserId!, action: "USER_PASSWORD_RESET", targetType: "User", targetId: user.id, reason: motivo });

  return NextResponse.json({ ok: true, email: user.email.toLowerCase() });
}
