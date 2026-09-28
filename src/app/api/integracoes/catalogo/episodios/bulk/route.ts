import { NextRequest, NextResponse } from "next/server";
import { requireCatalogSync } from "@/lib/catalogSyncAuth";
import { CATALOG_WRITE_MAQUINA, upsertCatalogEpisodesBulk } from "@/lib/catalog-write";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const guard = await requireCatalogSync(req); if (guard) return guard;
  try {
    const { serieId, episodios } = await req.json();
    if (typeof serieId !== "string" || !Array.isArray(episodios) || episodios.length > 1000) {
      return NextResponse.json({ error: "serieId e episodios[] (máximo 1000) são obrigatórios" }, { status: 400 });
    }
    const result = await upsertCatalogEpisodesBulk(serieId, episodios, undefined, CATALOG_WRITE_MAQUINA);
    return NextResponse.json({ ok: result.errors.length === 0, ...result });
  } catch {
    return NextResponse.json({ error: "Payload inválido" }, { status: 400 });
  }
}
