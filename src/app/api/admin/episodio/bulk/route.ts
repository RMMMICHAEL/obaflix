export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdmin, withCors } from "@/lib/auth";
import { upsertCatalogEpisodesBulk } from "@/lib/catalog-write";

export async function OPTIONS(req: NextRequest) {
  const guard = await requireAdmin(req); return guard ?? new NextResponse(null, { status: 204 });
}

// POST /api/admin/episodio/bulk
export async function POST(req: NextRequest) {
  const guard = await requireAdmin(req); if (guard) return guard;

  const { serieId, episodios } = await req.json();
  if (!serieId || !Array.isArray(episodios)) {
    return NextResponse.json({ error: "serieId e episodios[] obrigatórios" }, { status: 400 });
  }

  const result = await upsertCatalogEpisodesBulk(serieId, episodios);
  return withCors(NextResponse.json({ ok: result.added + result.updated, errors: result.errors.length }), req);
}
