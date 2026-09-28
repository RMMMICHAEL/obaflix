import { NextRequest, NextResponse } from "next/server";
import { requireAdminSession } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const guard = await requireAdminSession(req); if (guard) return guard;
  const page = Math.max(1, Number(req.nextUrl.searchParams.get("page")) || 1);
  const take = 50;
  const [items, total] = await Promise.all([
    prisma.adminAudit.findMany({ orderBy: { createdAt: "desc" }, skip: (page - 1) * take, take, include: { adminUser: { select: { id: true, nome: true, email: true } } } }),
    prisma.adminAudit.count(),
  ]);
  return NextResponse.json({ items, total, page, pages: Math.ceil(total / take) });
}
