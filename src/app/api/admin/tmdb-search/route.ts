export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";

const TMDB_KEY = process.env.TMDB_API_KEY;
const BASE = "https://api.themoviedb.org/3";

import { requireAdmin } from "@/lib/auth";

export async function GET(req: NextRequest) {
  const guard = await requireAdmin(req); if (guard) return guard;

  const q = req.nextUrl.searchParams.get("q") ?? "";
  const tipo = req.nextUrl.searchParams.get("tipo") ?? "filme"; // "filme" | "serie"
  const tmdbId = req.nextUrl.searchParams.get("tmdbId");

  if (!TMDB_KEY) return NextResponse.json({ error: "TMDB_API_KEY não configurada" }, { status: 500 });

  // Busca detalhes de um ID específico
  if (tmdbId) {
    const endpoint = tipo === "serie" ? "tv" : "movie";
    const r = await fetch(`${BASE}/${endpoint}/${tmdbId}?api_key=${TMDB_KEY}&language=pt-BR`);
    const data = await r.json();
    return NextResponse.json(data);
  }

  if (!q) return NextResponse.json({ results: [] });

  const endpoint = tipo === "serie" ? "search/tv" : "search/movie";
  const r = await fetch(
    `${BASE}/${endpoint}?api_key=${TMDB_KEY}&language=pt-BR&query=${encodeURIComponent(q)}&page=1`,
  );
  const data = await r.json();
  return NextResponse.json(data);
}
