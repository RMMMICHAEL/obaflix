import { notFound } from "next/navigation";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { CustomPlayer } from "@/components/player/CustomPlayer";
import { imgUrl } from "@/lib/tmdb";

async function getWarez2Filme(
  filmeId: string
): Promise<{ br: string[]; eng: string[] }> {
  try {
    const r = await fetch(
      `https://megafrixapi.com/iptv/warez2.php?item_id=${encodeURIComponent(filmeId)}`,
      { headers: { "User-Agent": "okhttp/4.9.3" }, next: { revalidate: 0 } }
    );
    if (!r.ok) return { br: [], eng: [] };
    const data = await r.json().catch(() => null);
    return { br: data?.br ?? [], eng: data?.eng ?? [] };
  } catch {
    return { br: [], eng: [] };
  }
}

function mergeFilmeUrls(warezUrls: string[], dbUrl: string | null): string | null {
  const all = [...warezUrls];
  if (dbUrl) {
    dbUrl.split(",").map((u) => u.trim()).filter(Boolean).forEach((u) => {
      if (!all.includes(u)) all.push(u);
    });
  }
  return all.length > 0 ? all.join(",") : null;
}

export default async function AssistirFilmePage({ params }: { params: { id: string } }) {
  const session = await getServerSession(authOptions);
  const userId = (session?.user as any)?.id;

  const [filme, historico, warez] = await Promise.all([
    prisma.filme.findUnique({ where: { id: params.id } }),
    userId
      ? prisma.watchHistory.findFirst({
          where: { userId, conteudoId: params.id, episodioId: null },
          orderBy: { updatedAt: "desc" },
        })
      : null,
    getWarez2Filme(params.id),
  ]);

  if (!filme) notFound();

  // Voltz (e outros players do warez2) ficam em primeiro na lista
  const urlDub = mergeFilmeUrls(warez.br, filme.urlDub);
  const urlLeg = mergeFilmeUrls(warez.eng, filme.urlLeg);

  return (
    <CustomPlayer
      urlDub={urlDub}
      urlLeg={urlLeg}
      titulo={filme.titulo}
      thumbUrl={imgUrl(filme.background || filme.poster || null, "original")}
      conteudoId={filme.id}
      conteudoTipo="filme"
      duracaoSeg={filme.duracao ? filme.duracao * 60 : undefined}
      initialProgressoSeg={historico?.progressoSeg ?? 0}
    />
  );
}
