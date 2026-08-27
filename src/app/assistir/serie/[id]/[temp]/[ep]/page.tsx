import { notFound, redirect } from "next/navigation";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { CustomPlayer } from "@/components/player/CustomPlayer";
import { imgUrl, getTVImages, pickLogo, logoUrl as buildLogoUrl } from "@/lib/tmdb";

export default async function AssistirEpPage({
  params,
}: {
  params: { id: string; temp: string; ep: string };
}) {
  const session = await getServerSession(authOptions);
  const userId = (session?.user as any)?.id;
  if (!userId) {
    const path = `/assistir/serie/${params.id}/${params.temp}/${params.ep}`;
    redirect(`/login?callbackUrl=${encodeURIComponent(path)}`);
  }

  const temporada = Number(params.temp.replace("t", ""));
  const numeroEp = Number(params.ep.replace("ep", ""));

  const [serie, episodio] = await Promise.all([
    prisma.serie.findUnique({
      where: { id: params.id },
      select: { id: true, titulo: true, sinopse: true, tmdbId: true, poster: true, background: true },
    }),
    // Sem urlDub/urlLeg: nada que identifique provedor entra no render.
    prisma.episodio.findFirst({
      where: { serieId: params.id, temporada, numeroEp },
      select: { id: true, titulo: true, thumbnail: true, temporada: true, numeroEp: true },
    }),
  ]);

  if (!serie || !episodio) notFound();

  const [prevEp, nextEp, historico, images] = await Promise.all([
    prisma.episodio.findFirst({
      where: {
        serieId: params.id,
        OR: [
          { temporada, numeroEp: { lt: numeroEp } },
          { temporada: { lt: temporada } },
        ],
      },
      orderBy: [{ temporada: "desc" }, { numeroEp: "desc" }],
      select: { temporada: true, numeroEp: true },
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
      select: { temporada: true, numeroEp: true },
    }),
    userId
      ? prisma.watchHistory.findUnique({
          where: { userId_conteudoId_episodioId: { userId, conteudoId: serie.id, episodioId: episodio.id } },
        })
      : null,
    serie.tmdbId ? getTVImages(serie.tmdbId) : null,
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
      titulo={serie.titulo}
      nomeEpisodio={episodio.titulo ?? undefined}
      thumbUrl={imgUrl(episodio.thumbnail || serie.background || serie.poster || null, "original")}
      logoUrl={buildLogoUrl(pickLogo(images))}
      sinopse={serie.sinopse ?? null}
      conteudoId={serie.id}
      conteudoTipo="serie"
      tmdbId={serie.tmdbId}
      episodioId={episodio.id}
      temporada={temporada}
      numeroEp={numeroEp}
      prevUrl={prevUrl}
      nextUrl={nextUrl}
      initialProgressoSeg={historico?.progressoSeg ?? 0}
    />
  );
}
