export const dynamic = "force-dynamic";
export const maxDuration = 30;

import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { headerMatchesHost } from "@/lib/requestSecurity";
import { isIpBlocked, recordAbuseAttempt } from "@/lib/playTokens";
import { audit } from "@/lib/auditLog";
import crypto from "crypto";

const NO_STORE = { "Cache-Control": "no-store, no-cache, must-revalidate, private" };

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

function clientIp(req: NextRequest): string {
  return (
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    req.headers.get("x-real-ip") ||
    "unknown"
  );
}

export interface PlayerflixSource {
  id: string;
  name: string;
  provider: string;
  url: string;
  /** false = não temos extrator; a fonte só serve como iframe de última linha. */
  hasExtractor: boolean;
}

/**
 * Mesma classificação por host que `detectProvider()` usa no Kotlin, no Electron e
 * na rota de extração. Aqui ela só rotula a fonte — quem extrai continua sendo o
 * pipeline existente, que reconhece essas mesmas URLs.
 */
function providerOf(hostname: string): { provider: string; hasExtractor: boolean } {
  const host = hostname.toLowerCase();
  const hostIs = (...allowed: string[]) =>
    allowed.some((a) => host === a || host.endsWith(`.${a}`));

  if (hostIs("v1.watchplay.shop")) return { provider: "watchplayer", hasExtractor: true };
  if (hostIs("embedplayer1.xyz", "embedplayer2.xyz", "xn--kcksk7a2bl5le7b6doc1h3f.com")) {
    return { provider: "embedplayer", hasExtractor: true };
  }
  if (hostIs("superflixapi.pro", "superflixapi.sbs")) return { provider: "superflix", hasExtractor: true };
  if (hostIs("playhide.shop", "hidehide.shop", "vidhidehub.com")) {
    return { provider: "hide", hasExtractor: true };
  }
  if (hostIs("luluvdo.com", "lulu.gg", "luluvid.com", "lulustream.com")) {
    return { provider: "lulu", hasExtractor: true };
  }
  if (
    hostIs("streamwish.com", "playerwish.com", "hlswish.com", "wishonly.site",
      "cdnwish.com", "asnwish.com", "swishsrv.com")
  ) {
    return { provider: "wish", hasExtractor: true };
  }
  if (hostIs("boltcdn.xyz", "upbolt.to")) return { provider: "bolt", hasExtractor: true };
  if (hostIs("bigshare.link")) return { provider: "big", hasExtractor: true };
  return { provider: "desconhecido", hasExtractor: false };
}

/**
 * Ordem de tentativa. Reproduz a preferência que já existe em extractPlayerflix
 * (WatchPlay primeiro, depois embedplayer2, depois qualquer embedplayer); o resto
 * vem em seguida e as fontes sem extrator ficam por último, como fallback.
 */
function priorityOf(hostname: string, provider: string, hasExtractor: boolean): number {
  const host = hostname.toLowerCase();
  if (host === "v1.watchplay.shop") return 0;
  if (host === "embedplayer2.xyz") return 1;
  if (provider === "embedplayer") return 2;
  if (provider === "superflix") return 3;
  if (hasExtractor) return 4;
  return 9;
}

/** Nome legível: o provedor às vezes manda a própria URL como rótulo (ok.ru). */
function displayName(rawLabel: string, hostname: string): string {
  const label = (rawLabel || "").trim();
  if (!label || /^https?:\/\//i.test(label)) return hostname.replace(/^www\./, "");
  return label.slice(0, 40);
}

function sourceId(url: string, provider: string): string {
  const hash = crypto.createHash("sha1").update(url).digest("hex").slice(0, 8);
  return `${provider}-${hash}`;
}

export async function GET(req: NextRequest) {
  const ip = clientIp(req);

  if (await isIpBlocked(ip)) {
    return NextResponse.json({ error: "Acesso negado" }, { status: 429, headers: NO_STORE });
  }

  const origin = req.headers.get("origin");
  const host = req.headers.get("host");
  if (origin && host && !headerMatchesHost(origin, host)) {
    await recordAbuseAttempt(ip);
    audit("origin_rejected", { ip, ua: req.headers.get("user-agent") || "unknown", detail: "/playerflix-sources" });
    return NextResponse.json({ error: "Acesso negado" }, { status: 403, headers: NO_STORE });
  }

  const session = await getServerSession(authOptions);
  if (!session?.user) {
    return NextResponse.json({ error: "Acesso negado" }, { status: 401, headers: NO_STORE });
  }

  const params = req.nextUrl.searchParams;
  const tmdbId = (params.get("tmdbId") || "").trim();
  const tipo = params.get("type") === "tv" ? "tv" : "movie";
  const season = (params.get("season") || "").trim();
  const episode = (params.get("episode") || "").trim();

  if (!/^\d{1,12}$/.test(tmdbId)) {
    return NextResponse.json({ error: "tmdbId inválido" }, { status: 400, headers: NO_STORE });
  }
  if (tipo === "tv" && (!/^\d{1,4}$/.test(season) || !/^\d{1,5}$/.test(episode))) {
    return NextResponse.json({ error: "temporada/episódio inválidos" }, { status: 400, headers: NO_STORE });
  }

  const ajax = new URL("https://playerflix.ink/inc/Ajax.php");
  ajax.searchParams.set("type", tipo);
  ajax.searchParams.set("id", tmdbId);
  if (tipo === "tv") {
    ajax.searchParams.set("season", season);
    ajax.searchParams.set("episode", episode);
  }
  // Sem este Referer a API responde {"status":false}, como se o conteúdo não existisse.
  const pageReferer =
    tipo === "tv"
      ? `https://playerflix.ink/serie/${tmdbId}/${season}/${episode}`
      : `https://playerflix.ink/filme/${tmdbId}`;

  let payload: unknown;
  try {
    const res = await fetch(ajax, {
      headers: {
        "User-Agent": UA,
        Accept: "application/json, text/plain, */*",
        "Accept-Language": "pt-BR,pt;q=0.5",
        Referer: pageReferer,
        "X-Requested-With": "XMLHttpRequest",
      },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      // Lista vazia mantém o Player 1 exatamente como é hoje: só a fonte Automática.
      return NextResponse.json({ sources: [] }, { headers: NO_STORE });
    }
    payload = await res.json();
  } catch {
    return NextResponse.json({ sources: [] }, { headers: NO_STORE });
  }

  const options = (payload as { data?: { options?: unknown } } | null)?.data?.options;
  if (!Array.isArray(options)) {
    return NextResponse.json({ sources: [] }, { headers: NO_STORE });
  }

  const vistos = new Set<string>();
  const usados = new Map<string, number>();
  const sources: (PlayerflixSource & { _prioridade: number })[] = [];

  for (const raw of options) {
    if (!raw || typeof raw !== "object") continue;
    const embed = (raw as { embed?: unknown }).embed;
    if (typeof embed !== "string" || !embed) continue;

    let parsed: URL;
    try { parsed = new URL(embed); } catch { continue; }
    if (parsed.protocol !== "https:") continue;
    if (vistos.has(parsed.toString())) continue;
    vistos.add(parsed.toString());

    const { provider, hasExtractor } = providerOf(parsed.hostname);
    let name = displayName(String((raw as { label?: unknown }).label ?? ""), parsed.hostname);
    // Rótulos repetem (o mesmo título traz duas fontes "VIP Player"); numera a
    // partir da segunda para o menu não mostrar duas linhas idênticas.
    const repeticoes = (usados.get(name) || 0) + 1;
    usados.set(name, repeticoes);
    if (repeticoes > 1) name = `${name} ${repeticoes}`;

    sources.push({
      id: sourceId(parsed.toString(), provider),
      name,
      provider,
      url: parsed.toString(),
      hasExtractor,
      _prioridade: priorityOf(parsed.hostname, provider, hasExtractor),
    });
  }

  sources.sort((a, b) => a._prioridade - b._prioridade);

  return NextResponse.json(
    { sources: sources.map(({ _prioridade, ...s }) => s) },
    { headers: NO_STORE },
  );
}
