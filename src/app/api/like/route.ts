import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user) return NextResponse.json({ error: "Não autenticado" }, { status: 401 });
  const userId = (session.user as { id: string }).id;
  const { searchParams } = req.nextUrl;
  const conteudoId = searchParams.get("conteudoId");
  const conteudoTipo = searchParams.get("conteudoTipo");
  if (!conteudoId || !conteudoTipo) return NextResponse.json({ valor: 0 });

  try {
    const like = await (prisma as any).like.findUnique({
      where: { userId_conteudoId_conteudoTipo: { userId, conteudoId, conteudoTipo } },
    });
    return NextResponse.json({ valor: like?.valor ?? 0 });
  } catch {
    return NextResponse.json({ valor: 0 });
  }
}

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user) return NextResponse.json({ error: "Não autenticado" }, { status: 401 });
  const userId = (session.user as { id: string }).id;
  const { conteudoId, conteudoTipo, valor } = await req.json();
  if (!conteudoId || !conteudoTipo) return NextResponse.json({ error: "Dados inválidos" }, { status: 400 });

  try {
    if (valor === 0) {
      await (prisma as any).like.deleteMany({ where: { userId, conteudoId, conteudoTipo } });
    } else {
      await (prisma as any).like.upsert({
        where: { userId_conteudoId_conteudoTipo: { userId, conteudoId, conteudoTipo } },
        update: { valor },
        create: { userId, conteudoId, conteudoTipo, valor },
      });
    }
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: "Erro ao salvar" }, { status: 500 });
  }
}
