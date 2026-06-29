export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { createPlayToken, checkRateLimit, isIpBlocked, recordAbuseAttempt } from "@/lib/playTokens";
import { audit } from "@/lib/auditLog";

const NO_STORE = { "Cache-Control": "no-store, no-cache, must-revalidate, private" };

function clientIp(req: NextRequest): string {
  return (
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    req.headers.get("x-real-ip") ||
    "unknown"
  );
}

function clientUa(req: NextRequest): string {
  return req.headers.get("user-agent") || "unknown";
}

export async function POST(req: NextRequest) {
  const ip = clientIp(req);
  const ua = clientUa(req);

  if (await isIpBlocked(ip)) {
    audit("ip_blocked", { ip, ua, detail: "bloqueado em /token" });
    return NextResponse.json({ error: "Acesso negado" }, { status: 429, headers: NO_STORE });
  }

  const origin = req.headers.get("origin");
  const host = req.headers.get("host");
  if (origin && host && !origin.includes(host)) {
    await recordAbuseAttempt(ip);
    audit("origin_rejected", { ip, ua, detail: `origin=${origin}` });
    return NextResponse.json({ error: "Acesso negado" }, { status: 403, headers: NO_STORE });
  }

  const session = await getServerSession(authOptions);
  if (!session?.user) {
    await recordAbuseAttempt(ip);
    audit("auth_failure", { ip, ua, detail: "/token sem sessão" });
    return NextResponse.json({ error: "Acesso negado" }, { status: 401, headers: NO_STORE });
  }

  const userId = (session.user as { id: string }).id;
  if (!userId) return NextResponse.json({ error: "Acesso negado" }, { status: 401, headers: NO_STORE });

  if (!(await checkRateLimit(userId))) {
    return NextResponse.json({ error: "Muitas solicitações" }, { status: 429, headers: NO_STORE });
  }

  let embedUrl: string;
  try {
    const body = await req.json();
    embedUrl = body?.embedUrl;
    if (!embedUrl || typeof embedUrl !== "string") throw new Error();
    new URL(embedUrl);
  } catch {
    return NextResponse.json({ error: "Parâmetros inválidos" }, { status: 400, headers: NO_STORE });
  }

  const playToken = createPlayToken(userId, embedUrl, ip);
  return NextResponse.json({ playToken }, { headers: NO_STORE });
}
