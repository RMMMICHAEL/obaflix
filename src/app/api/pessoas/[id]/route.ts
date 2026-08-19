import { NextResponse } from "next/server";
import { getPersonCatalog } from "@/lib/person-catalog";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const personId = Number(params.id);
  if (!Number.isInteger(personId) || personId <= 0) {
    return NextResponse.json({ error: "ID de pessoa inválido" }, { status: 400 });
  }

  const catalog = await getPersonCatalog(personId);
  if (!catalog) {
    return NextResponse.json({ error: "Pessoa não encontrada" }, { status: 404 });
  }

  return NextResponse.json(catalog, {
    headers: { "Cache-Control": "public, s-maxage=3600, stale-while-revalidate=86400" },
  });
}
