import { NextRequest, NextResponse } from "next/server";
import { requireAdminSession } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const guard = await requireAdminSession(req); if (guard) return guard;
  const q = (req.nextUrl.searchParams.get("q") ?? "").trim().slice(0, 120);
  const status = (req.nextUrl.searchParams.get("status") ?? "").toUpperCase();
  const planoId = (req.nextUrl.searchParams.get("plano") ?? "").trim();
  const page = Math.max(1, Number(req.nextUrl.searchParams.get("page")) || 1);
  const take = 30;
  const where: any = {};
  if (status) where.status = status;
  if (planoId) where.planoId = planoId;
  if (q) where.user = { OR: [{ nome: { contains: q, mode: "insensitive" } }, { email: { contains: q, mode: "insensitive" } }] };
  const [items, total, planos] = await Promise.all([
    prisma.assinatura.findMany({ where, orderBy: { terminaEm: "desc" }, skip: (page - 1) * take, take, include: { user: { select: { id: true, nome: true, email: true } }, plano: { select: { id: true, nome: true } } } }),
    prisma.assinatura.count({ where }),
    prisma.plano.findMany({ where: { ativo: true }, orderBy: { ordem: "asc" }, select: { id: true, nome: true } }),
  ]);
  return NextResponse.json({ items, total, page, pages: Math.ceil(total / take), planos });
}
