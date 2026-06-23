export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

// Faz fetch server-side (sem CORS) e devolve o conteúdo pro browser
export async function GET(req: NextRequest) {
  const url = req.nextUrl.searchParams.get("url");
  if (!url) return new NextResponse("url obrigatória", { status: 400 });

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return new NextResponse("URL inválida", { status: 400 });
  }

  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": UA,
        "Accept": "*/*",
        "Accept-Language": "pt-BR,pt;q=0.5",
        "Origin": parsed.origin,
        "Referer": parsed.origin + "/",
      },
      signal: AbortSignal.timeout(20000),
      redirect: "follow",
    });

    if (!res.ok) {
      return new NextResponse(`Upstream error ${res.status}`, { status: res.status });
    }

    const contentType = res.headers.get("content-type") ?? "application/octet-stream";
    const isM3u8 =
      url.includes(".m3u8") ||
      url.includes(".txt") ||
      contentType.includes("mpegurl") ||
      contentType.includes("x-mpegurl");

    if (isM3u8) {
      // Reescreve o .m3u8 para que todos os segmentos também passem pelo proxy
      const text = await res.text();
      const base = url.substring(0, url.lastIndexOf("/") + 1);
      const origin = req.nextUrl.origin;

      const rewritten = text
        .split("\n")
        .map((line) => {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith("#")) return line;

          // Monta URL absoluta do segmento
          let segUrl: string;
          if (trimmed.startsWith("http")) {
            segUrl = trimmed;
          } else if (trimmed.startsWith("/")) {
            segUrl = parsed.origin + trimmed;
          } else {
            segUrl = base + trimmed;
          }

          return `${origin}/api/player/proxy?url=${encodeURIComponent(segUrl)}`;
        })
        .join("\n");

      return new NextResponse(rewritten, {
        status: 200,
        headers: {
          "Content-Type": "application/vnd.apple.mpegurl",
          "Access-Control-Allow-Origin": "*",
          "Cache-Control": "no-cache",
        },
      });
    }

    // Segmento .ts ou outro binário — faz stream direto
    const body = await res.arrayBuffer();
    return new NextResponse(body, {
      status: 200,
      headers: {
        "Content-Type": contentType,
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "public, max-age=3600",
      },
    });

  } catch (err: any) {
    return new NextResponse(err?.message ?? "erro interno", { status: 500 });
  }
}
