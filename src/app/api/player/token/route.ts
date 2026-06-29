export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { createPlayToken } from "@/lib/playTokens";

// Limite simples por userId (in-process; eficaz num único worker warm)
const rateBucket = new Map<string, { count: number; resetAt: number }>();
const MAX_TOKENS_PER_MINUTE = 20;

function checkRate(userId: string): boolean {
  const now = Date.now();
  let bucket = rateBucket.get(userId);
  if (!bucket || bucket.resetAt < now) {
    bucket = { count: 0, resetAt: now + 60_000 };
    rateBucket.set(userId, bucket);
  }
  if (bucket.count >= MAX_TOKENS_PER_MINUTE) return false;
  bucket.count++;
  return true;
}

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user) return NextResponse.json({ error: "Não autenticado" }, { status: 401 });

  const userId = (session.user as { id: string }).id;
  if (!userId) return NextResponse.json({ error: "Sessão inválida" }, { status: 401 });

  if (!checkRate(userId)) {
    return NextResponse.json({ error: "Muitas solicitações" }, { status: 429 });
  }

  let embedUrl: string;
  try {
    const body = await req.json();
    embedUrl = body?.embedUrl;
    if (!embedUrl || typeof embedUrl !== "string") throw new Error();
    new URL(embedUrl); // valida formato
  } catch {
    return NextResponse.json({ error: "embedUrl inválida" }, { status: 400 });
  }

  const playToken = createPlayToken(userId, embedUrl);
  return NextResponse.json({ playToken });
}
