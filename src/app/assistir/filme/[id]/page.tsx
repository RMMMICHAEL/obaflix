import { notFound, redirect } from "next/navigation";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { CustomPlayer } from "@/components/player/CustomPlayer";
import { imgUrl, getMovieImages, pickLogo, logoUrl as buildLogoUrl } from "@/lib/tmdb";

/**
 * A página não conhece mais nenhuma fonte.
 *
 * Até aqui ela buscava o warez2 e passava `urlDub`/`urlLeg` como props do
 * CustomPlayer — que é Client Component, então cada URL real de provedor era
 * serializada no payload RSC e saía legível no "ver código-fonte". Agora quem
 * monta a lista é /api/player/fontes, e o navegador recebe só ids opacos.
 */
export default async function AssistirFilmePage({ params }: { params: { id: string } }) {
  const session = await getServerSession(authOptions);
  const userId = (session?.user as any)?.id;
  if (!userId) redirect(`/login?callbackUrl=${encodeURIComponent(`/assistir/filme/${params.id}`)}`);

  const filme = await prisma.filme.findUnique({
    where: { id: params.id },
    // Sem urlDub/urlLeg: nada que identifique provedor entra no render.
    select: {
      id: true, titulo: true, sinopse: true, tmdbId: true,
      poster: true, background: true, duracao: true,
    },
  });
  if (!filme) notFound();

  const [historico, images] = await Promise.all([
    prisma.watchHistory.findFirst({
      where: { userId, conteudoId: params.id, episodioId: null },
      orderBy: { updatedAt: "desc" },
    }),
    filme.tmdbId ? getMovieImages(filme.tmdbId) : null,
  ]);

  return (
    <CustomPlayer
      titulo={filme.titulo}
      thumbUrl={imgUrl(filme.background || filme.poster || null, "original")}
      logoUrl={buildLogoUrl(pickLogo(images))}
      sinopse={filme.sinopse ?? null}
      conteudoId={filme.id}
      conteudoTipo="filme"
      tmdbId={filme.tmdbId}
      duracaoSeg={filme.duracao ? filme.duracao * 60 : undefined}
      initialProgressoSeg={historico?.progressoSeg ?? 0}
    />
  );
}
