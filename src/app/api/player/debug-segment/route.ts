export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { assertSafeUrl } from "@/lib/ssrf";

// Testa um segmento .ts (ou qualquer URL de CDN) com diferentes combinações de headers,
// retornando status + headers de resposta para cada combinação.
// Uso: GET /api/player/debug-segment?url=<segment_url>&ref=<embed_url>
//
// Isso permite identificar se o bloqueio é por:
// - IP de datacenter (todos os combos retornam 403/404/503)
// - Referer/Origin inválido (alguns combos passam, outros não)
// - Token/assinatura com IP binding (200 do servidor ≠ comportamento do browser)

const COMBOS = [
  {
    label: "sem headers",
    headers: {},
  },
  {
    label: "UA apenas",
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122.0.0.0 Safari/537.36",
    },
  },
  {
    label: "UA + Referer embed",
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122.0.0.0 Safari/537.36",
      "Referer": "__REF__",
    },
  },
  {
    label: "UA + Referer embed + Origin CDN",
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122.0.0.0 Safari/537.36",
      "Referer": "__REF__",
      "Origin": "__CDN_ORIGIN__",
    },
  },
  {
    label: "UA + Referer CDN base + Origin CDN",
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122.0.0.0 Safari/537.36",
      "Referer": "__CDN_ORIGIN__/",
      "Origin": "__CDN_ORIGIN__",
    },
  },
  {
    label: "UA + Referer megaflix + Origin megaflix",
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122.0.0.0 Safari/537.36",
      "Referer": "https://megaflix.lat/",
      "Origin": "https://megaflix.lat",
    },
  },
  {
    label: "UA + Referer embed + Origin embed + Sec-Fetch",
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122.0.0.0 Safari/537.36",
      "Referer": "__REF__",
      "Origin": "__CDN_ORIGIN__",
      "Sec-Fetch-Dest": "empty",
      "Sec-Fetch-Mode": "cors",
      "Sec-Fetch-Site": "same-origin",
    },
  },
  {
    label: "sem Origin (simula <video> nativo)",
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122.0.0.0 Safari/537.36",
      "Referer": "__REF__",
    },
  },
];

async function probeUrl(
  url: string,
  headers: Record<string, string>,
  timeout = 8000
): Promise<{ status: number | null; headers: Record<string, string>; error?: string; bytes?: number }> {
  try {
    const res = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(timeout),
      redirect: "follow",
    });

    const respHeaders: Record<string, string> = {};
    const relevant = [
      "content-type", "content-length", "access-control-allow-origin",
      "access-control-allow-headers", "set-cookie", "cf-cache-status",
      "x-cache", "server", "x-powered-by", "location", "vary",
    ];
    for (const key of relevant) {
      const val = res.headers.get(key);
      if (val) respHeaders[key] = val;
    }

    // Lê apenas os primeiros bytes para confirmar se é conteúdo real ou página de erro
    const reader = res.body?.getReader();
    let bytes = 0;
    if (reader) {
      const { value } = await reader.read();
      bytes = value?.byteLength ?? 0;
      reader.cancel();
    }

    return { status: res.status, headers: respHeaders, bytes };
  } catch (e: any) {
    return { status: null, headers: {}, error: e?.message ?? "timeout" };
  }
}

export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user) return NextResponse.json({ error: "Não autenticado" }, { status: 401 });

  const segUrl = req.nextUrl.searchParams.get("url");
  const refUrl = req.nextUrl.searchParams.get("ref") ?? "";

  if (!segUrl) return NextResponse.json({ error: "url obrigatória (?url=<segmento_url>&ref=<embed_url>)" }, { status: 400 });

  let parsedSeg: URL;
  try {
    parsedSeg = await assertSafeUrl(segUrl);
  } catch (e: any) {
    return NextResponse.json({ error: e?.message }, { status: 400 });
  }

  const cdnOrigin = parsedSeg.origin;
  const refOrigin = refUrl ? (() => { try { return new URL(refUrl).origin; } catch { return ""; } })() : "";

  // Substitui placeholders nos headers de cada combo
  const combos = COMBOS.map((c) => ({
    label: c.label,
    headers: Object.fromEntries(
      Object.entries(c.headers).map(([k, v]) => [
        k,
        v
          .replace("__REF__", refUrl || cdnOrigin + "/")
          .replace(/__CDN_ORIGIN__/g, cdnOrigin)
          .replace(/__EMBED_ORIGIN__/g, refOrigin),
      ])
    ),
  }));

  // Executa todos os combos em paralelo
  const results = await Promise.all(
    combos.map(async (c) => {
      const result = await probeUrl(segUrl, c.headers);
      return { label: c.label, headers_sent: c.headers, ...result };
    })
  );

  return NextResponse.json({
    segment_url: segUrl,
    ref_url: refUrl,
    cdn_origin: cdnOrigin,
    server_ip_note: "requests feitas pelo IP do servidor Vercel (datacenter)",
    results,
  });
}
