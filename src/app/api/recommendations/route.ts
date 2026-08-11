import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { getRecommendationsForUser } from "@/lib/recommendations";

export const dynamic = "force-dynamic";

export async function GET() {
  const session = await getServerSession(authOptions);
  const userId = (session?.user as { id?: string } | undefined)?.id;
  if (!userId) return NextResponse.json({ error: "Não autenticado" }, { status: 401 });

  const result = await getRecommendationsForUser(userId);
  return NextResponse.json(result, {
    headers: { "Cache-Control": "private, no-store" },
  });
}
