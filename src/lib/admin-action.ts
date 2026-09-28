import { getServerSession } from "next-auth";
import { NextRequest, NextResponse } from "next/server";
import { authOptions, requireAdminSession } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { checkRateLimit, clientIp, headerMatchesHost } from "@/lib/requestSecurity";
import type { Prisma } from "@prisma/client";

const forbiddenMetadataKey = /(password|senha|hash|cookie|token|jwt|secret|url|stream|signed|assinad|authorization)/i;
// Valor com esquema (https://, rtmp://...) nunca entra, qualquer que seja a chave.
const urlLikeValue = /[a-z][a-z0-9+.-]*:\/\//i;

/** Só escalares, sem chaves sensíveis e sem valores que pareçam URL. */
export function sanitizeAuditMetadata(input: Record<string, unknown> | undefined) {
  if (!input) return undefined;
  return Object.fromEntries(Object.entries(input).flatMap(([key, value]) => {
    if (forbiddenMetadataKey.test(key)) return [];
    if (typeof value === "string" && urlLikeValue.test(value)) return [];
    if (["string", "number", "boolean"].includes(typeof value) || value === null) return [[key, value]];
    return [];
  }));
}

export async function requireAdminAction(req: NextRequest, action: string) {
  const guard = await requireAdminSession(req);
  if (guard) return { response: guard, adminUserId: null };
  const origin = req.headers.get("origin");
  const host = req.headers.get("host");
  if (origin && host && !headerMatchesHost(origin, host)) {
    return { response: NextResponse.json({ error: "Origem inválida" }, { status: 403 }), adminUserId: null };
  }
  const session = await getServerSession(authOptions);
  const adminUserId = (session?.user as { id?: string } | undefined)?.id;
  if (!adminUserId) return { response: NextResponse.json({ error: "Sessão administrativa obrigatória" }, { status: 401 }), adminUserId: null };
  const rate = await checkRateLimit(`admin-action:${action}:${adminUserId}:${clientIp(req)}`, 20, 60);
  if (!rate.allowed) return { response: NextResponse.json({ error: "Limite de ações excedido" }, { status: 429 }), adminUserId: null };
  return { response: null, adminUserId };
}

export async function recordAdminAudit(args: {
  adminUserId: string;
  action: string;
  targetType: string;
  targetId?: string | null;
  reason: string;
  metadata?: Record<string, unknown>;
}) {
  return prisma.adminAudit.create({
    data: {
      adminUserId: args.adminUserId,
      action: args.action,
      targetType: args.targetType,
      targetId: args.targetId ?? null,
      reason: args.reason.trim().slice(0, 500),
      metadata: sanitizeAuditMetadata(args.metadata) as Prisma.InputJsonObject | undefined,
    },
  });
}
