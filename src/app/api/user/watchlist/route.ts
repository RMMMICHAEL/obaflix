export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/authSession";
import { prisma } from "@/lib/prisma";
import { publicMedia } from "@/lib/publicMedia";
import { checkRateLimit, readJsonBody } from "@/lib/requestSecurity";

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
  if (!(await checkRateLimit(`watchlist:${userId}`, 60, 60)).allowed) {
    return NextResponse.json({ error: "Muitas solicitações" }, { status: 429 });
  }

  const watchlist = await prisma.watchlist.findMany({
    where: { userId },
    include: {
      filme: { include: { generos: { include: { genero: true } } } },
      serie: { include: { generos: { include: { genero: true } } } },
    },
    orderBy: { addedAt: "desc" },
  });

  return NextResponse.json(watchlist.map((item) => ({
    ...item,
    filme: item.filme ? publicMedia(item.filme) : null,
  })));
}

export async function POST(req: NextRequest) {
  const usuario = await getUserFromRequest(req);
  if (!usuario) return NextResponse.json({ error: "Não autenticado" }, { status: 401 });
  const userId = usuario.userId;
  if (!(await checkRateLimit(`watchlist:${userId}`, 60, 60)).allowed) {
    return NextResponse.json({ error: "Muitas solicitações" }, { status: 429 });
  }
  let body: Record<string, unknown>;
  try { body = await readJsonBody(req, 4096); }
  catch { return NextResponse.json({ error: "Dados inválidos" }, { status: 400 }); }
  const { conteudoId, conteudoTipo } = body;
  if (!validContentId(conteudoId) || !validContentType(conteudoTipo)) {
    return NextResponse.json({ error: "Dados inválidos" }, { status: 400 });
  }
  const isFilm = conteudoTipo === "filme";
  const contentExists = isFilm
    ? await prisma.filme.findUnique({ where: { id: conteudoId }, select: { id: true } })
    : await prisma.serie.findFirst({ where: { id: conteudoId, tipo: conteudoTipo === "serie" ? undefined : conteudoTipo }, select: { id: true } });
  if (!contentExists) return NextResponse.json({ error: "Conteúdo inválido" }, { status: 400 });

  await prisma.watchlist.upsert({
    where: { userId_conteudoId_conteudoTipo: { userId, conteudoId, conteudoTipo } },
    update: {},
    create: {
      userId,
      conteudoId,
      conteudoTipo,
      filmeId: isFilm ? conteudoId : undefined,
      serieId: !isFilm ? conteudoId : undefined,
    },
  });

  return NextResponse.json({ ok: true });
}

export async function DELETE(req: NextRequest) {
  const usuario = await getUserFromRequest(req);
  if (!usuario) return NextResponse.json({ error: "Não autenticado" }, { status: 401 });
  const userId = usuario.userId;
  if (!(await checkRateLimit(`watchlist:${userId}`, 60, 60)).allowed) {
    return NextResponse.json({ error: "Muitas solicitações" }, { status: 429 });
  }
  let body: Record<string, unknown>;
  try { body = await readJsonBody(req, 4096); }
  catch { return NextResponse.json({ error: "Dados inválidos" }, { status: 400 }); }
  const { conteudoId, conteudoTipo } = body;
  if (!validContentId(conteudoId) || !validContentType(conteudoTipo)) {
    return NextResponse.json({ error: "Dados inválidos" }, { status: 400 });
  }

  await prisma.watchlist.deleteMany({ where: { userId, conteudoId, conteudoTipo } });
  return NextResponse.json({ ok: true });
}
