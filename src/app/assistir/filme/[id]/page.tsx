import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { CustomPlayer } from "@/components/player/CustomPlayer";

export default async function AssistirFilmePage({ params }: { params: { id: string } }) {
  const filme = await prisma.filme.findUnique({ where: { id: params.id } });
  if (!filme) notFound();

  return (
    <CustomPlayer
      urlDub={filme.urlDub}
      urlLeg={filme.urlLeg}
      titulo={filme.titulo}
      conteudoId={filme.id}
      conteudoTipo="filme"
      duracaoSeg={filme.duracao ? filme.duracao * 60 : undefined}
    />
  );
}
