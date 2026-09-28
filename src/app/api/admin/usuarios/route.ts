import { NextRequest, NextResponse } from "next/server";
import { requireAdminSession } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const guard = await requireAdminSession(req); if (guard) return guard;
  const q = (req.nextUrl.searchParams.get("q") ?? "").trim().slice(0, 120);
  const page = Math.max(1, Number(req.nextUrl.searchParams.get("page")) || 1);
  const take = 30;
  const where = q ? { OR: [
    { nome: { contains: q, mode: "insensitive" as const } },
    { email: { contains: q, mode: "insensitive" as const } },
  ] } : {};
  const [items, total] = await Promise.all([
    prisma.user.findMany({ where, orderBy: { createdAt: "desc" }, skip: (page - 1) * take, take, select: {
      id: true, nome: true, email: true, role: true, createdAt: true,
      assinaturas: { orderBy: { terminaEm: "desc" }, take: 1, select: { status: true, iniciaEm: true, terminaEm: true, origem: true, plano: { select: { nome: true } } } },
      _count: { select: { dispositivos: true } },
    } }),
    prisma.user.count({ where }),
  ]);
  return NextResponse.json({ items, total, page, pages: Math.ceil(total / take) });
}
