export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { createPlayToken, checkRateLimit, isIpBlocked, recordAbuseAttempt } from "@/lib/playTokens";

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

  if (isIpBlocked(ip)) {
    return NextResponse.json({ error: "Acesso temporariamente bloqueado" }, { status: 429 });
  }

  // Origin deve ser nosso próprio domínio
  const origin = req.headers.get("origin");
  const host = req.headers.get("host");
  if (origin && host && !origin.includes(host)) {
    recordAbuseAttempt(ip);
    return NextResponse.json({ error: "Origem inválida" }, { status: 403 });
  }

  const session = await getServerSession(authOptions);
  if (!session?.user) {
    recordAbuseAttempt(ip);
    return NextResponse.json({ error: "Não autenticado" }, { status: 401 });
  }

  const userId = (session.user as { id: string }).id;
  if (!userId) return NextResponse.json({ error: "Sessão inválida" }, { status: 401 });

  if (!checkRateLimit(userId)) {
    return NextResponse.json({ error: "Muitas solicitações" }, { status: 429 });
  }

  let embedUrl: string;
  try {
    const body = await req.json();
    embedUrl = body?.embedUrl;
    if (!embedUrl || typeof embedUrl !== "string") throw new Error();
    new URL(embedUrl);
  } catch {
    return NextResponse.json({ error: "Parâmetros inválidos" }, { status: 400 });
  }

  const playToken = createPlayToken(userId, embedUrl, ip);
  return NextResponse.json({ playToken });
}
