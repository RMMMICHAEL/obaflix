import { notFound } from "next/navigation";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { CustomPlayer } from "@/components/player/CustomPlayer";
import { imgUrl } from "@/lib/tmdb";

// Busca URLs extras do warez2 para o episódio (voltz como player 1)
async function getWarez2Ep(
  serieId: string,
  temporada: number,
  ep: number
): Promise<{ br: string[]; eng: string[] }> {
  try {
    const params = new URLSearchParams({
      item_id: serieId,
      season_num: String(temporada),
      episode_num: String(ep),
    });
    const r = await fetch(
      `https://megafrixapi.com/iptv/warez2.php?${params}`,
      { headers: { "User-Agent": "okhttp/4.9.3" }, next: { revalidate: 0 } }
    );
    if (!r.ok) return { br: [], eng: [] };
    const data = await r.json().catch(() => null);
    return { br: data?.br ?? [], eng: data?.eng ?? [] };
  } catch {
    return { br: [], eng: [] };
  }
}

// Mescla URLs do warez2 (prioridade) com as do banco
function mergeEpUrls(warezUrls: string[], dbUrl: string | null): string | null {
  const all = [...warezUrls];
  if (dbUrl) {
    dbUrl.split(",").map((u) => u.trim()).filter(Boolean).forEach((u) => {
      if (!all.includes(u)) all.push(u);
    });
  }
  return all.length > 0 ? all.join(",") : null;
}

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

  const [prevEp, nextEp, historico, warez] = await Promise.all([
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
    // Busca voltz e outros players extras via warez2 (em paralelo com o resto)
    getWarez2Ep(params.id, temporada, numeroEp),
  ]);

  const prevUrl = prevEp
    ? `/assistir/serie/${params.id}/t${prevEp.temporada}/ep${prevEp.numeroEp}`
    : undefined;
  const nextUrl = nextEp
    ? `/assistir/serie/${params.id}/t${nextEp.temporada}/ep${nextEp.numeroEp}`
    : undefined;

  // Voltz (e outros players do warez2) ficam em primeiro na lista
  const urlDub = mergeEpUrls(warez.br, episodio.urlDub);
  const urlLeg = mergeEpUrls(warez.eng, episodio.urlLeg);

  return (
    <CustomPlayer
      key={episodio.id}
      urlDub={urlDub}
      urlLeg={urlLeg}
      titulo={serie.titulo}
      thumbUrl={imgUrl(episodio.thumbnail || serie.background || serie.poster || null, "original")}
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
