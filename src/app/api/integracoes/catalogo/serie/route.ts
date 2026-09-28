import { NextRequest, NextResponse } from "next/server";
import { requireCatalogSync } from "@/lib/catalogSyncAuth";
import { upsertCatalogSeries } from "@/lib/catalog-write";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const guard = await requireCatalogSync(req); if (guard) return guard;
  try {
    const result = await upsertCatalogSeries(await req.json());
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Payload inválido" }, { status: 400 });
  }
}
