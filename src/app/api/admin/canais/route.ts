import { NextRequest, NextResponse } from "next/server";
import { requireAdminSession } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { recordAdminAudit, requireAdminAction } from "@/lib/admin-action";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const guard = await requireAdminSession(req); if (guard) return guard;
  const q = (req.nextUrl.searchParams.get("q") ?? "").trim().slice(0, 120);
  const items = await prisma.canal.findMany({ where: q ? { OR: [{ nome: { contains: q, mode: "insensitive" } }, { categoria: { contains: q, mode: "insensitive" } }] } : {}, orderBy: [{ categoria: "asc" }, { ordem: "asc" }], select: { id: true, slug: true, nome: true, categoria: true, logoUrl: true, nivelMinimo: true, nivelRevisado: true, ativo: true, adulto: true, ordem: true, atualizadoEm: true } });
  return NextResponse.json({ items, total: items.length, ativos: items.filter((item) => item.ativo).length });
}

export async function POST(req: NextRequest) {
  const auth = await requireAdminAction(req, "channel-review"); if (auth.response) return auth.response;
  const body = await req.json();
  const motivo = typeof body.motivo === "string" ? body.motivo.trim() : "";
  if (!body.id || motivo.length < 5 || !["gratuito", "plus", "premium"].includes(body.nivelMinimo)) return NextResponse.json({ error: "Canal, nível e motivo são obrigatórios" }, { status: 400 });
  const canal = await prisma.canal.update({ where: { id: body.id }, data: { ativo: body.ativo === true, nivelMinimo: body.nivelMinimo, nivelRevisado: true } });
  await recordAdminAudit({ adminUserId: auth.adminUserId!, action: "CHANNEL_REVIEWED", targetType: "Canal", targetId: canal.id, reason: motivo, metadata: { ativo: canal.ativo, nivelMinimo: canal.nivelMinimo } });
  return NextResponse.json({ ok: true });
}
