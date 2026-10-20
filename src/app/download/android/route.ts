import { INSTALADORES } from "@/config/downloads";
import { validatedDownloadUrl } from "@/config/public-download";

export const dynamic = "force-dynamic";

// No fetch, streaming or user-controlled destination. APK bytes stay at R2.
export function GET(request: Request) {
  if (new URL(request.url).search) {
    return new Response("Parâmetros não são aceitos.", { status: 400 });
  }
  const destination = validatedDownloadUrl(INSTALADORES.android.url);
  if (!destination) return new Response("Download temporariamente indisponível.", { status: 503 });
  return new Response(null, {
    status: 302,
    headers: {
      Location: destination,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "X-Robots-Tag": "noindex, follow",
    },
  });
}
