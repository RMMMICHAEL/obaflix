export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

function isAdmin(req: NextRequest) {
  return req.headers.get("x-admin-token") === process.env.ADMIN_SECRET_TOKEN;
}

export async function GET(req: NextRequest) {
  if (!isAdmin(req)) return NextResponse.json({ error: "Não autorizado" }, { status: 403 });

  const serieId = req.nextUrl.searchParams.get("serieId");
  if (!serieId) return NextResponse.json({ error: "serieId obrigatório" }, { status: 400 });

  const episodios = await prisma.episodio.findMany({
    where: { serieId },
    orderBy: [{ temporada: "asc" }, { numeroEp: "asc" }],
  });

  return NextResponse.json(episodios);
}

export async function POST(req: NextRequest) {
  if (!isAdmin(req)) return NextResponse.json({ error: "Não autorizado" }, { status: 403 });

  const body = await req.json();
  const { id, serieId, numeroEp, temporada, titulo, thumbnail, urlDub, urlLeg } = body;

  if (!serieId || !numeroEp || !temporada) {
    return NextResponse.json({ error: "serieId, numeroEp e temporada obrigatórios" }, { status: 400 });
  }

  const epId = id || `${serieId}-t${temporada}e${numeroEp}`;

  const ep = await prisma.episodio.upsert({
    where: { id: epId },
    update: { titulo, thumbnail, urlDub: urlDub || null, urlLeg: urlLeg || null },
    create: {
      id: epId,
      serieId,
      numeroEp: Number(numeroEp),
      temporada: Number(temporada),
      titulo,
      thumbnail,
      urlDub: urlDub || null,
      urlLeg: urlLeg || null,
    },
  });

  return NextResponse.json({ ok: true, id: ep.id });
}

export async function DELETE(req: NextRequest) {
  if (!isAdmin(req)) return NextResponse.json({ error: "Não autorizado" }, { status: 403 });

  const { id } = await req.json();
  await prisma.watchHistory.deleteMany({ where: { episodioId: id } });
  await prisma.episodio.delete({ where: { id } });

  return NextResponse.json({ ok: true });
}
