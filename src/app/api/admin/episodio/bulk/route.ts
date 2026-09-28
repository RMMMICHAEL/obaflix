export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { isLegacyAdminTokenRequest, requireAdminOrLegacyCatalogToken, withCors } from "@/lib/auth";
import { CATALOG_WRITE_MAQUINA, upsertCatalogEpisodesBulk } from "@/lib/catalog-write";

export async function OPTIONS(req: NextRequest) {
  const guard = await requireAdminOrLegacyCatalogToken(req); return guard ?? new NextResponse(null, { status: 204 });
}

// POST /api/admin/episodio/bulk
export async function POST(req: NextRequest) {
  const guard = await requireAdminOrLegacyCatalogToken(req); if (guard) return guard;

  const { serieId, episodios } = await req.json();
  if (!serieId || !Array.isArray(episodios)) {
    return NextResponse.json({ error: "serieId e episodios[] obrigatórios" }, { status: 400 });
  }

  // Token legado = produtor máquina: null não apaga (mesma regra da integração).
  const result = await upsertCatalogEpisodesBulk(serieId, episodios, undefined, isLegacyAdminTokenRequest(req) ? CATALOG_WRITE_MAQUINA : {});
  return withCors(NextResponse.json({ ok: result.added + result.updated, errors: result.errors.length }), req);
}
