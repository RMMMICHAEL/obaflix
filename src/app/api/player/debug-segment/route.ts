export const dynamic = "force-dynamic";
export const maxDuration = 60;
import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { assertSafeUrl } from "@/lib/ssrf";

// Testa a cadeia completa de reprodução HLS a partir do servidor Vercel:
//   master.m3u8 → variant playlist → 1º segmento
//
// Uso: GET /api/player/debug-segment?url=<master_ou_segmento>&ref=<embed_url>
//
// Permite identificar em qual nível da cadeia ocorre o bloqueio e qual
// combinação de headers (Referer, Origin, UA) o CDN aceita ou rejeita.

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

const COMBOS = [
  { label: "sem headers", headers: {} },
  { label: "UA apenas", headers: { "User-Agent": UA } },
  {
    label: "UA + Referer embed",
    headers: { "User-Agent": UA, "Referer": "__REF__" },
  },
  {
    label: "UA + Referer embed + Origin CDN",
    headers: { "User-Agent": UA, "Referer": "__REF__", "Origin": "__CDN_ORIGIN__" },
  },
  {
    label: "UA + Referer CDN raiz + Origin CDN",
    headers: { "User-Agent": UA, "Referer": "__CDN_ORIGIN__/", "Origin": "__CDN_ORIGIN__" },
  },
  {
    label: "UA + Referer megaflix + Origin megaflix",
    headers: { "User-Agent": UA, "Referer": "https://megaflix.lat/", "Origin": "https://megaflix.lat" },
  },
  {
    label: "UA + Referer embed + Origin CDN + Sec-Fetch cors",
    headers: {
      "User-Agent": UA, "Referer": "__REF__", "Origin": "__CDN_ORIGIN__",
      "Sec-Fetch-Dest": "empty", "Sec-Fetch-Mode": "cors", "Sec-Fetch-Site": "same-origin",
    },
  },
  {
    label: "UA + Referer embed (sem Origin — simula <video> nativo)",
    headers: { "User-Agent": UA, "Referer": "__REF__" },
  },
];

const RESP_HEADERS = [
  "content-type", "content-length", "access-control-allow-origin",
  "access-control-allow-headers", "access-control-allow-methods",
  "set-cookie", "cf-cache-status", "x-cache", "server",
  "x-powered-by", "location", "vary",
];

function resolveHeaders(
  raw: Record<string, string>,
  cdnOrigin: string,
  refUrl: string
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(raw).map(([k, v]) => [
      k,
      v
        .replace(/__REF__/g, refUrl || cdnOrigin + "/")
        .replace(/__CDN_ORIGIN__/g, cdnOrigin),
    ])
  );
}

async function probeUrl(
  url: string,
  headers: Record<string, string>,
  readBytes = true,
  timeout = 10000
): Promise<{ status: number | null; resp_headers: Record<string, string>; error?: string; bytes?: number; body_preview?: string }> {
  try {
    const res = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(timeout),
      redirect: "follow",
    });

    const respHeaders: Record<string, string> = {};
    for (const key of RESP_HEADERS) {
      const val = res.headers.get(key);
      if (val) respHeaders[key] = val;
    }

    let bytes = 0;
    let body_preview: string | undefined;
    if (readBytes && res.body) {
      const ct = res.headers.get("content-type") ?? "";
      const isPlaylist = ct.includes("mpegurl") || url.includes(".m3u8") || url.includes(".txt");
      if (isPlaylist) {
        // Lê o corpo completo para playlists (necessário para extrair URLs de variant/segmento)
        const text = await res.text();
        bytes = text.length;
        body_preview = text.slice(0, 4000);
      } else {
        // Para segmentos binários, lê apenas o primeiro chunk
        const reader = res.body.getReader();
        const { value } = await reader.read();
        reader.cancel();
        bytes = value?.byteLength ?? 0;
      }
    }

    return { status: res.status, resp_headers: respHeaders, bytes, body_preview };
  } catch (e: any) {
    return { status: null, resp_headers: {}, error: e?.message ?? "timeout" };
  }
}

// Extrai variantes e segmentos de um m3u8, incluindo formatos não-convencionais (/md/, /hls/, etc.)
function parseM3u8(text: string, baseUrl: string): { variants: string[]; segments: string[] } {
  const base = baseUrl.substring(0, baseUrl.lastIndexOf("/") + 1);
  const origin = new URL(baseUrl).origin;
  const lines = text.split("\n").map((l) => l.trim());
  const variants: string[] = [];
  const segments: string[] = [];

  let nextIsVariant = false;
  for (const line of lines) {
    if (!line) continue;
    if (line.startsWith("#EXT-X-STREAM-INF")) {
      nextIsVariant = true;
      continue;
    }
    if (line.startsWith("#")) continue;

    const abs = line.startsWith("http") ? line : line.startsWith("/") ? origin + line : base + line;

    if (nextIsVariant) {
      variants.push(abs);
      nextIsVariant = false;
    } else {
      // Linha de segmento (EXTINF já passou ou playlist flat)
      segments.push(abs);
    }
  }
  return { variants, segments };
}

export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user) return NextResponse.json({ error: "Não autenticado" }, { status: 401 });

  const masterUrl = req.nextUrl.searchParams.get("url");
  const refUrl = req.nextUrl.searchParams.get("ref") ?? "";

  if (!masterUrl) {
    return NextResponse.json({ error: "url obrigatória (?url=<master.m3u8>&ref=<embed_url>)" }, { status: 400 });
  }

  try { await assertSafeUrl(masterUrl); } catch (e: any) {
    return NextResponse.json({ error: e?.message }, { status: 400 });
  }

  const cdnOrigin = new URL(masterUrl).origin;

  // ── Etapa 1: master.m3u8 ────────────────────────────────────────────────────
  const masterCombos = await Promise.all(
    COMBOS.map(async (c) => {
      const headers = resolveHeaders(c.headers, cdnOrigin, refUrl);
      const result = await probeUrl(masterUrl, headers, true);
      return { label: c.label, headers_sent: headers, ...result };
    })
  );

  // Escolhe o melhor resultado do master (primeiro com status 200/206)
  const bestMaster = masterCombos.find((r) => r.status === 200 || r.status === 206);

  // ── Etapa 2: variant playlist ────────────────────────────────────────────────
  let variantResults: any[] = [];
  let variantUrl: string | null = null;
  let bestVariant: any = null;

  if (bestMaster?.body_preview) {
    const { variants } = parseM3u8(bestMaster.body_preview, masterUrl);
    variantUrl = variants[0] ?? null;

    if (variantUrl) {
      const variantCdnOrigin = (() => { try { return new URL(variantUrl).origin; } catch { return cdnOrigin; } })();
      variantResults = await Promise.all(
        COMBOS.map(async (c) => {
          const headers = resolveHeaders(c.headers, variantCdnOrigin, refUrl);
          const result = await probeUrl(variantUrl!, headers, true);
          return { label: c.label, headers_sent: headers, ...result };
        })
      );
      bestVariant = variantResults.find((r) => r.status === 200 || r.status === 206);
    }
  }

  // ── Etapa 3: 1º segmento ────────────────────────────────────────────────────
  let segmentResults: any[] = [];
  let segmentUrl: string | null = null;

  const playlistForSegments = bestVariant?.body_preview
    ? { text: bestVariant.body_preview, url: variantUrl! }
    : bestMaster?.body_preview
    ? { text: bestMaster.body_preview, url: masterUrl }
    : null;

  if (playlistForSegments) {
    const { segments } = parseM3u8(playlistForSegments.text, playlistForSegments.url);
    segmentUrl = segments[0] ?? null;

    if (segmentUrl) {
      const segCdnOrigin = (() => { try { return new URL(segmentUrl).origin; } catch { return cdnOrigin; } })();
      segmentResults = await Promise.all(
        COMBOS.map(async (c) => {
          const headers = resolveHeaders(c.headers, segCdnOrigin, refUrl);
          const result = await probeUrl(segmentUrl!, headers, true);
          return { label: c.label, headers_sent: headers, ...result };
        })
      );
    }
  }

  // ── Veredicto ────────────────────────────────────────────────────────────────
  const ok = (r: any[]) => r.some((x) => x.status === 200 || x.status === 206);
  const verdicts = {
    master: ok(masterCombos) ? "✅ acessível" : "❌ bloqueado",
    variant: variantUrl ? (ok(variantResults) ? "✅ acessível" : "❌ bloqueado") : "⏭ não encontrado no master",
    segment: segmentUrl ? (ok(segmentResults) ? "✅ acessível" : "❌ bloqueado") : "⏭ não encontrado na playlist",
  };

  const overallVerdict =
    !ok(masterCombos)
      ? "❌ BLOQUEIO NO MASTER — IP binding ou bloqueio total de datacenter"
      : !variantUrl && !segmentUrl
      ? "⚠️ MASTER ACESSÍVEL mas parser não encontrou variant nem segmento — ver body_preview do master"
      : variantUrl && !ok(variantResults)
      ? "❌ BLOQUEIO NA VARIANT — master liberado mas playlist de qualidade bloqueada"
      : segmentUrl && !ok(segmentResults)
      ? "❌ BLOQUEIO NOS SEGMENTOS — master e variant liberados, CDN bloqueia bytes de vídeo"
      : "✅ CADEIA COMPLETA ACESSÍVEL — proxy viável";

  return NextResponse.json({
    note: "Todas as requisições são feitas pelo servidor Vercel (mesmo IP da extração)",
    master_url: masterUrl,
    variant_url: variantUrl,
    segment_url: segmentUrl,
    ref_url: refUrl,
    verdict: overallVerdict,
    chain: verdicts,
    master: masterCombos,
    variant: variantUrl ? variantResults : null,
    segment: segmentUrl ? segmentResults : null,
  });
}
