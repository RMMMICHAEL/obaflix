export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { checkRateLimit, readJsonBody } from "@/lib/requestSecurity";

const CONTENT_TYPES = new Set(["filme", "serie"]);

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user) return NextResponse.json({ error: "Não autenticado" }, { status: 401 });

  const userId = (session.user as { id: string }).id;
  if (!(await checkRateLimit(`progress:${userId}`, 120, 60)).allowed) {
    return NextResponse.json({ error: "Muitas solicitações" }, { status: 429 });
  }
  let body: Record<string, any>;
  try { body = await readJsonBody(req, 8192); }
  catch { return NextResponse.json({ error: "Dados inválidos" }, { status: 400 }); }
  const { conteudoId, conteudoTipo, episodioId, temporada, numeroEp } = body;
  const progressoSeg = Math.round(Number(body.progressoSeg) || 0);
  const duracaoSeg = body.duracaoSeg != null ? Math.round(Number(body.duracaoSeg)) : null;

  if (
    typeof conteudoId !== "string" || conteudoId.length === 0 || conteudoId.length > 128 ||
    typeof conteudoTipo !== "string" || !CONTENT_TYPES.has(conteudoTipo) ||
    !Number.isFinite(progressoSeg) || progressoSeg < 0 || progressoSeg > 7 * 24 * 3600 ||
    (duracaoSeg !== null && (!Number.isFinite(duracaoSeg) || duracaoSeg <= 0 || duracaoSeg > 7 * 24 * 3600)) ||
    (episodioId != null && (typeof episodioId !== "string" || episodioId.length > 128)) ||
    (temporada != null && (!Number.isInteger(temporada) || temporada < 0 || temporada > 1000)) ||
    (numeroEp != null && (!Number.isInteger(numeroEp) || numeroEp <= 0 || numeroEp > 100000))
  ) {
    return NextResponse.json({ error: "conteudoId e conteudoTipo são obrigatórios" }, { status: 400 });
  }

  const concluido = duracaoSeg ? progressoSeg > duracaoSeg * 0.9 : false;
  const epId: string | null = episodioId ?? null;

  const contentExists = conteudoTipo === "filme"
    ? await prisma.filme.findUnique({ where: { id: conteudoId }, select: { id: true } })
    : epId
      ? await prisma.episodio.findFirst({ where: { id: epId, serieId: conteudoId }, select: { id: true } })
      : await prisma.serie.findUnique({ where: { id: conteudoId }, select: { id: true } });
  if (!contentExists) return NextResponse.json({ error: "Conteúdo inválido" }, { status: 400 });

  const updateData = {
    progressoSeg, duracaoSeg, concluido, temporada, numeroEp, queued: false,
    conteudoTipo,
    filmeId: conteudoTipo === "filme" ? conteudoId : undefined,
    serieId: conteudoTipo === "serie" ? conteudoId : undefined,
  };
  const createData = {
    userId, conteudoId, conteudoTipo,
    episodioId: epId,
    temporada, numeroEp,
    progressoSeg, duracaoSeg, concluido,
    queued: false,
    filmeId: conteudoTipo === "filme" ? conteudoId : undefined,
    serieId: conteudoTipo === "serie" ? conteudoId : undefined,
  };

  try {
    if (epId === null) {
      // filmes: episodioId=null — PostgreSQL não detecta conflito em unique com NULL,
      // então upsert sempre faria INSERT duplicado. Usamos findFirst+update/create.
      const existing = await prisma.watchHistory.findFirst({
        where: { userId, conteudoId, episodioId: null },
        select: { id: true },
      });
      if (existing) {
        await prisma.watchHistory.update({ where: { id: existing.id }, data: updateData });
      } else {
        await prisma.watchHistory.create({ data: createData });
      }
    } else {
      await prisma.watchHistory.upsert({
        where: { userId_conteudoId_episodioId: { userId, conteudoId, episodioId: epId } },
        update: updateData,
        create: createData,
      });
    }

    // Quando um episódio é concluído, pré-enfileira o próximo na lista "Continuar Assistindo"
    if (concluido && conteudoTipo === "serie" && epId && temporada != null && numeroEp != null) {
      const nextEp = await prisma.episodio.findFirst({
        where: {
          serieId: conteudoId,
          OR: [
            { temporada, numeroEp: { gt: numeroEp } },
            { temporada: { gt: temporada } },
          ],
        },
        orderBy: [{ temporada: "asc" }, { numeroEp: "asc" }],
      });

      if (nextEp) {
        await prisma.watchHistory.upsert({
          where: { userId_conteudoId_episodioId: { userId, conteudoId, episodioId: nextEp.id } },
          create: {
            userId,
            conteudoId,
            conteudoTipo: "serie",
            episodioId: nextEp.id,
            temporada: nextEp.temporada,
            numeroEp: nextEp.numeroEp,
            progressoSeg: 0,
            concluido: false,
            queued: true,
            serieId: conteudoId,
          },
          update: { queued: true },
        });
      }
    }

    return NextResponse.json({ ok: true });
  } catch (err: any) {
    console.error("[api/progress POST]", err?.message ?? err);
    return NextResponse.json({ error: "Erro ao salvar progresso" }, { status: 500 });
  }
}

export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user) return NextResponse.json({ error: "Não autenticado" }, { status: 401 });

  const userId = (session.user as { id: string }).id;
  const conteudoId = req.nextUrl.searchParams.get("conteudoId");
  const episodioId = req.nextUrl.searchParams.get("episodioId");

  if (!conteudoId) return NextResponse.json({ error: "conteudoId obrigatório" }, { status: 400 });

  try {
    const progresso = await prisma.watchHistory.findFirst({
      where: { userId, conteudoId, episodioId: episodioId ?? null },
    });
    return NextResponse.json(progresso ?? { progressoSeg: 0, concluido: false });
  } catch (err: any) {
    console.error("[api/progress GET]", err?.message ?? err);
    return NextResponse.json({ progressoSeg: 0, concluido: false });
  }
}
