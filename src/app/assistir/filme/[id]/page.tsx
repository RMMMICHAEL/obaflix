import { notFound } from "next/navigation";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { CustomPlayer } from "@/components/player/CustomPlayer";

export default async function AssistirFilmePage({ params }: { params: { id: string } }) {
  const session = await getServerSession(authOptions);
  const userId = (session?.user as any)?.id;

  const [filme, historico] = await Promise.all([
    prisma.filme.findUnique({ where: { id: params.id } }),
    userId
      ? prisma.watchHistory.findUnique({
          where: { userId_conteudoId_episodioId: { userId, conteudoId: params.id, episodioId: null } },
        })
      : null,
  ]);

  if (!filme) notFound();

  return (
    <CustomPlayer
      urlDub={filme.urlDub}
      urlLeg={filme.urlLeg}
      titulo={filme.titulo}
      conteudoId={filme.id}
      conteudoTipo="filme"
      duracaoSeg={filme.duracao ? filme.duracao * 60 : undefined}
      initialProgressoSeg={historico?.progressoSeg ?? 0}
    />
  );
}
