import { NextRequest, NextResponse } from "next/server";
import { requireAdminSession } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const guard = await requireAdminSession(req); if (guard) return guard;
  const q = (req.nextUrl.searchParams.get("q") ?? "").trim().slice(0, 120);
  const status = (req.nextUrl.searchParams.get("status") ?? "").toUpperCase();
  const page = Math.max(1, Number(req.nextUrl.searchParams.get("page")) || 1);
  const take = 30;
  const where: any = {};
  if (status) where.status = status;
  if (q) where.user = { OR: [{ nome: { contains: q, mode: "insensitive" } }, { email: { contains: q, mode: "insensitive" } }] };
  const [items, total] = await Promise.all([
    prisma.pedidoPagamento.findMany({ where, orderBy: { criadoEm: "desc" }, skip: (page - 1) * take, take, select: { id: true, status: true, provedor: true, valorCentavos: true, moeda: true, operacao: true, criadoEm: true, atualizadoEm: true, user: { select: { id: true, nome: true, email: true } }, plano: { select: { nome: true } }, revisoes: { where: { status: "PENDENTE" }, select: { id: true } } } }),
    prisma.pedidoPagamento.count({ where }),
  ]);
  return NextResponse.json({ items, total, page, pages: Math.ceil(total / take) });
}
