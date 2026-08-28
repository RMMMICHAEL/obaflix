export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/authSession";
import { prisma } from "@/lib/prisma";

const NO_STORE = { "Cache-Control": "no-store, no-cache, must-revalidate, private" };

/**
 * Estado pessoal de uma pagina de detalhe, numa chamada so.
 *
 * Existe porque /filme/:id e /serie/:id viraram HTML cacheado e neutro: nenhuma
 * sessao entra no render, entao o que pertence ao usuario chega por aqui, fora
 * do cache e autenticado. A resposta carrega o minimo para desenhar o botao e as
 * barras de progresso — nunca URL de fonte, token, userId ou campo de admin.
 *
 * A autenticacao e a unificada (cookie ou Bearer), entao o app de TV consegue
 * usar o mesmo endpoint.
 */
export async function GET(req: NextRequest) {
  const vazio = { continuar: null, progressoEpisodios: {} };

  const usuario = await getUserFromRequest(req);
  if (!usuario) return NextResponse.json(vazio, { headers: NO_STORE });

  const userId = usuario.userId;
  const conteudoId = req.nextUrl.searchParams.get("conteudoId");
  const tipo = req.nextUrl.searchParams.get("tipo");

  if (!conteudoId || (tipo !== "filme" && tipo !== "serie")) {
    return NextResponse.json(vazio, { headers: NO_STORE });
  }

  if (tipo === "filme") {
    const ultimo = await prisma.watchHistory.findFirst({
      where: { userId, conteudoId, episodioId: null, concluido: false, progressoSeg: { gt: 30 } },
      orderBy: { updatedAt: "desc" },
      select: { progressoSeg: true },
    });

    return NextResponse.json(
      {
        continuar: ultimo ? { temporada: null, numeroEp: null, progressoSeg: ultimo.progressoSeg } : null,
        progressoEpisodios: {},
      },
      { headers: NO_STORE },
    );
  }

  const [progresso, continuar] = await Promise.all([
    prisma.watchHistory.findMany({
      where: { userId, serieId: conteudoId, episodioId: { not: null } },
      select: { episodioId: true, progressoSeg: true, duracaoSeg: true, concluido: true },
    }),
    prisma.watchHistory.findFirst({
      where: { userId, serieId: conteudoId, concluido: false, progressoSeg: { gt: 30 } },
      orderBy: { updatedAt: "desc" },
      select: { temporada: true, numeroEp: true, progressoSeg: true },
    }),
  ]);

  return NextResponse.json(
    {
      continuar: continuar
        ? {
            temporada: continuar.temporada,
            numeroEp: continuar.numeroEp,
            progressoSeg: continuar.progressoSeg,
          }
        : null,
      progressoEpisodios: Object.fromEntries(
        progresso.map((item) => [
          item.episodioId!,
          {
            progressoSeg: item.progressoSeg,
            duracaoSeg: item.duracaoSeg ?? null,
            concluido: item.concluido,
          },
        ]),
      ),
    },
    { headers: NO_STORE },
  );
}
