import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/authSession";
import { prisma } from "@/lib/prisma";
import { checkRateLimit, readJsonBody } from "@/lib/requestSecurity";

export const dynamic = "force-dynamic";

const CONTENT_TYPES = new Set(["filme", "serie", "anime", "desenho"]);

function validContentId(id: unknown): id is string {
  return typeof id === "string" && id.length > 0 && id.length <= 128;
}

function validContentType(type: unknown): type is string {
  return typeof type === "string" && CONTENT_TYPES.has(type);
}

export async function GET(req: NextRequest) {
  const usuario = await getUserFromRequest(req);
  if (!usuario) return NextResponse.json({ error: "Não autenticado" }, { status: 401 });
  const userId = usuario.userId;
  if (!(await checkRateLimit(`like:${userId}`, 60, 60)).allowed) {
    return NextResponse.json({ error: "Muitas solicitações" }, { status: 429 });
  }
  const { searchParams } = req.nextUrl;
  const conteudoId = searchParams.get("conteudoId");
  const conteudoTipo = searchParams.get("conteudoTipo");
  if (!validContentId(conteudoId) || !validContentType(conteudoTipo)) return NextResponse.json({ valor: 0 });

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
  const usuario = await getUserFromRequest(req);
  if (!usuario) return NextResponse.json({ error: "Não autenticado" }, { status: 401 });
  const userId = usuario.userId;
  if (!(await checkRateLimit(`like-write:${userId}`, 60, 60)).allowed) {
    return NextResponse.json({ error: "Muitas solicitações" }, { status: 429 });
  }
  let body: Record<string, unknown>;
  try { body = await readJsonBody(req, 4096); }
  catch { return NextResponse.json({ error: "Dados inválidos" }, { status: 400 }); }
  const { conteudoId, conteudoTipo, valor } = body;
  if (!validContentId(conteudoId) || !validContentType(conteudoTipo) || typeof valor !== "number" || ![-1, 0, 1].includes(valor)) {
    return NextResponse.json({ error: "Dados inválidos" }, { status: 400 });
  }
  const contentExists = conteudoTipo === "filme"
    ? await prisma.filme.findUnique({ where: { id: conteudoId }, select: { id: true } })
    : await prisma.serie.findFirst({ where: { id: conteudoId, tipo: conteudoTipo === "serie" ? undefined : conteudoTipo }, select: { id: true } });
  if (!contentExists) return NextResponse.json({ error: "Conteúdo inválido" }, { status: 400 });

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
