export const dynamic = "force-dynamic";
export const maxDuration = 60;
import { timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { ambienteTesteIsolado } from "@/lib/isolamentoTeste";

// TEMPORÁRIA: o catálogo mínimo usou ids "teste-<tmdb>", mas /api/player/fontes busca
// o warez2 pelo id do item Megafrix e a produção guarda os links do próprio item.
// Cria (só cria) os mesmos filmes com o id Megafrix e as fontes públicas, como o
// /api/cron/sync faz. Remover após executar.
const NO_STORE = { "Cache-Control": "no-store" };
const ITENS: Record<string, string> = { "184": "155", "16638": "603", "16198": "157336", "12957": "27205" };
const UA = "okhttp/4.9.3";

function tokenValido(recebido: string | null): boolean {
  const esperado = process.env.PREPARO_TOKEN ?? "";
  if (esperado.length < 32 || !recebido) return false;
  const a = Buffer.from(recebido), b = Buffer.from(esperado);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function fontesMegafrix(id: string) {
  const html = await (await fetch(`https://app.megafrixapi.com/4.6.2/?page=viewItem&id=${id}`, {
    headers: { "User-Agent": UA }, cache: "no-store", signal: AbortSignal.timeout(15000),
  })).text();
  const tmdb = html.match(/tmdb:\s*["`](\d+)["`]/)?.[1] ?? null;
  const opts = html.match(/openOptions\(\{\s*br:\s*'([^']*)'\s*,\s*eng:\s*'([^']*)'/);
  const w = await fetch(`https://megafrixapi.com/iptv/warez2.php?item_id=${id}`, {
    headers: { "User-Agent": UA }, cache: "no-store", signal: AbortSignal.timeout(8000),
  }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  // Mesma regra do mergeUrls do cron: warez primeiro, depois o 1º link do item.
  const juntar = (extras: unknown, doItem: string | undefined) => {
    const todas = Array.isArray(extras) ? extras.filter((u): u is string => typeof u === "string") : [];
    const u = doItem?.split(",")[0]?.trim();
    if (u && !todas.includes(u)) todas.push(u);
    return todas.length ? todas.join(",") : null;
  };
  return { tmdb, urlDub: juntar(w?.br, opts?.[1]), urlLeg: juntar(w?.eng, opts?.[2]) };
}

export async function POST(req: NextRequest) {
  if (process.env.VERCEL_ENV !== "preview" || process.env.OBAFLIX_AMBIENTE !== "teste"
    || process.env.VERCEL_GIT_COMMIT_REF !== "feat/cortes-permissoes") {
    return new NextResponse(null, { status: 404, headers: NO_STORE });
  }
  if (!tokenValido(req.headers.get("x-preparo-token"))) return new NextResponse(null, { status: 404, headers: NO_STORE });
  if (!ambienteTesteIsolado(process.env)) return NextResponse.json({ etapa: "isolamento", ok: false }, { status: 503, headers: NO_STORE });

  const relatorio: Record<string, string> = {};
  try {
    const marcador = await prisma.$queryRawUnsafe<{ ambiente: string }[]>(`SELECT "ambiente" FROM "_ObaflixAmbiente"`);
    if (marcador.length !== 1 || marcador[0].ambiente !== "teste") throw new Error("marcador");

    for (const [id, tmdb] of Object.entries(ITENS)) {
      if (await prisma.filme.findUnique({ where: { id }, select: { id: true } })) { relatorio[id] = "mantido"; continue; }
      const base = await prisma.filme.findUnique({ where: { id: `teste-${tmdb}` }, include: { generos: true } });
      const m = await fontesMegafrix(id);
      if (!base || m.tmdb !== tmdb || !m.urlDub) { relatorio[id] = `ignorado:${!base ? "sem-base" : m.tmdb !== tmdb ? "tmdb" : "sem-fonte"}`; continue; }
      const { id: _id, createdAt: _c, updatedAt: _u, generos, urlDub: _d, urlLeg: _l, ...dados } = base;
      await prisma.filme.create({
        data: {
          ...dados, id, urlDub: m.urlDub, urlLeg: m.urlLeg,
          generos: { create: generos.map(({ generoId }) => ({ generoId })) },
        },
      });
      relatorio[id] = `criado:${m.urlDub.split(",").length}`;
    }
    return NextResponse.json({ ok: true, relatorio }, { headers: NO_STORE });
  } catch (e) {
    return NextResponse.json({ ok: false, relatorio, erro: e instanceof Error ? e.message.slice(0, 200) : "erro" }, { status: 500, headers: NO_STORE });
  }
}
