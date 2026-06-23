export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";

const TMDB_KEY = process.env.TMDB_API_KEY;
const BASE = "https://api.themoviedb.org/3";

function isAdmin(req: NextRequest) {
  return req.headers.get("x-admin-token") === process.env.ADMIN_SECRET_TOKEN;
}

export async function GET(req: NextRequest) {
  if (!isAdmin(req)) return NextResponse.json({ error: "Não autorizado" }, { status: 403 });

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
