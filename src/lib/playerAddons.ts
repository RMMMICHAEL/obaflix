import type { ConteudoAutorizavel, ResultadoDeCatalogo } from "./playbackAuthorization";

export interface AlvoDeAddon {
  finalidade: "reproducao" | "download" | "transmissao";
  conteudoTipo: ConteudoAutorizavel;
  imdbId: string | null;
  tmdbId: string | null;
  temporada: number | null;
  numeroEp: number | null;
}

/** Uma sessão legada ou de outra finalidade nunca vira autorização para addons. */
export async function autorizarAddon(
  alvo: AlvoDeAddon | null,
  autorizarCatalogo: (tipo: ConteudoAutorizavel) => Promise<ResultadoDeCatalogo>,
  resolverImdb: (tmdb: string, tipo: ConteudoAutorizavel) => Promise<string | null>,
): Promise<{ type: "movie" | "series"; id: string }> {
  if (!alvo || alvo.finalidade !== "reproducao" || !["filme", "serie"].includes(alvo.conteudoTipo)) {
    throw new Error("Sessão inválida para addons");
  }
  const direito = await autorizarCatalogo(alvo.conteudoTipo);
  if (direito.situacao !== "permitido") throw new Error("Reprodução não autorizada");
  const imdb = alvo.imdbId || (alvo.tmdbId ? await resolverImdb(alvo.tmdbId, alvo.conteudoTipo) : null);
  if (!imdb || !/^tt\d{1,12}$/.test(imdb)) throw new Error("Conteúdo sem identificador compatível");
  if (alvo.conteudoTipo === "filme") return { type: "movie", id: imdb };
  if (!Number.isInteger(alvo.temporada) || !Number.isInteger(alvo.numeroEp) ||
    alvo.temporada! < 0 || alvo.numeroEp! < 1 || alvo.temporada! > 1000 || alvo.numeroEp! > 1000) {
    throw new Error("Episódio inválido");
  }
  return { type: "series", id: `${imdb}:${alvo.temporada}:${alvo.numeroEp}` };
}
