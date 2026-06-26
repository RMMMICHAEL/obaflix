export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { assertSafeUrl } from "@/lib/ssrf";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

// Faz fetch server-side (sem CORS) e devolve o conteúdo pro browser
export async function GET(req: NextRequest) {
  // Exige sessão para evitar uso do servidor como open proxy anônimo.
  const session = await getServerSession(authOptions);
  if (!session?.user) return new NextResponse("Não autenticado", { status: 401 });

  const url = req.nextUrl.searchParams.get("url");
  if (!url) return new NextResponse("url obrigatória", { status: 400 });

  // Valida contra SSRF (scheme http/https, bloqueia IPs internos / metadata).
  let parsed: URL;
  try {
    parsed = await assertSafeUrl(url);
  } catch (e: any) {
    return new NextResponse(e?.message ?? "URL inválida", { status: 400 });
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
          if (!trimmed) return line;

          // Reescreve URI do #EXT-X-KEY para que a chave AES-128 também passe pelo proxy
          if (trimmed.startsWith("#EXT-X-KEY") || trimmed.startsWith("#EXT-X-SESSION-KEY")) {
            return line.replace(/URI="([^"]+)"/, (_, uri: string) => {
              const absUri = uri.startsWith("http") ? uri : uri.startsWith("/") ? parsed.origin + uri : base + uri;
              return `URI="${origin}/api/player/proxy?url=${encodeURIComponent(absUri)}"`;
            });
          }

          if (trimmed.startsWith("#")) return line;

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
        "Cache-Control": "public, max-age=3600",
      },
    });

  } catch (err: any) {
    return new NextResponse(err?.message ?? "erro interno", { status: 500 });
  }
}
