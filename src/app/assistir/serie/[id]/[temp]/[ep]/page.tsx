import { notFound } from "next/navigation";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { CustomPlayer } from "@/components/player/CustomPlayer";

export default async function AssistirEpPage({
  params,
}: {
  params: { id: string; temp: string; ep: string };
}) {
  const session = await getServerSession(authOptions);
  const userId = (session?.user as any)?.id;

  const temporada = Number(params.temp.replace("t", ""));
  const numeroEp = Number(params.ep.replace("ep", ""));

  const [serie, episodio] = await Promise.all([
    prisma.serie.findUnique({ where: { id: params.id } }),
    prisma.episodio.findFirst({
      where: { serieId: params.id, temporada, numeroEp },
    }),
  ]);

  if (!serie || !episodio) notFound();

  const [prevEp, nextEp, historico] = await Promise.all([
    prisma.episodio.findFirst({
      where: {
        serieId: params.id,
        OR: [
          { temporada, numeroEp: { lt: numeroEp } },
          { temporada: { lt: temporada } },
        ],
      },
      orderBy: [{ temporada: "desc" }, { numeroEp: "desc" }],
    }),
    prisma.episodio.findFirst({
      where: {
        serieId: params.id,
        OR: [
          { temporada, numeroEp: { gt: numeroEp } },
          { temporada: { gt: temporada } },
        ],
      },
      orderBy: [{ temporada: "asc" }, { numeroEp: "asc" }],
    }),
    userId
      ? prisma.watchHistory.findUnique({
          where: { userId_conteudoId_episodioId: { userId, conteudoId: serie.id, episodioId: episodio.id } },
        })
      : null,
  ]);

  const prevUrl = prevEp
    ? `/assistir/serie/${params.id}/t${prevEp.temporada}/ep${prevEp.numeroEp}`
    : undefined;
  const nextUrl = nextEp
    ? `/assistir/serie/${params.id}/t${nextEp.temporada}/ep${nextEp.numeroEp}`
    : undefined;

  return (
    <CustomPlayer
      key={episodio.id}
      urlDub={episodio.urlDub}
      urlLeg={episodio.urlLeg}
      titulo={serie.titulo}
      conteudoId={serie.id}
      conteudoTipo="serie"
      episodioId={episodio.id}
      temporada={temporada}
      numeroEp={numeroEp}
      prevUrl={prevUrl}
      nextUrl={nextUrl}
      initialProgressoSeg={historico?.progressoSeg ?? 0}
    />
  );
}
