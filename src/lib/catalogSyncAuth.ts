import crypto from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { checkRateLimit, clientIp } from "@/lib/requestSecurity";

export function catalogTokenMatches(supplied: string | null, expected: string | undefined): boolean {
  if (!supplied || !expected || expected.length < 32 || supplied.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(expected));
}

export function catalogTokenScopeAllows(pathname: string): boolean {
  return pathname === "/api/integracoes/catalogo" || pathname.startsWith("/api/integracoes/catalogo/");
}

function suppliedToken(req: NextRequest): string | null {
  const authorization = req.headers.get("authorization");
  if (authorization?.startsWith("Bearer ")) return authorization.slice(7).trim();
  return req.headers.get("x-catalog-sync-token");
}

export async function requireCatalogSync(req: NextRequest) {
  if (!catalogTokenScopeAllows(req.nextUrl.pathname)) {
    return NextResponse.json({ error: "Credencial fora do escopo" }, { status: 403 });
  }
  const rate = await checkRateLimit(`catalog-sync:${clientIp(req)}`, 120, 60);
  if (!rate.allowed) {
    return NextResponse.json({ error: "Limite de requisições excedido" }, { status: 429 });
  }
  if (!catalogTokenMatches(suppliedToken(req), process.env.CATALOG_SYNC_TOKEN)) {
    return NextResponse.json({ error: "Credencial de integração inválida" }, { status: 403 });
  }
  return null;
}
