import type { TmdbCast, TmdbTV } from "@/lib/tmdb";

/** Pessoa exibida no PeopleRow — só campos públicos de apresentação. */
export interface PessoaPublica {
  id: number;
  name: string;
  profile_path: string | null;
  role: string | null;
}

/**
 * Monta as pessoas da ficha de série a partir dos créditos do TMDB: criação
 * (created_by) + direção (crew com job Director), e o elenco principal. Função
 * pura — devolve apenas id, nome, profile_path e papel/personagem; nunca fonte
 * de mídia, provider, token ou dado de usuário.
 */
export function extrairPessoasSerie(
  credits: { cast?: TmdbCast[]; crew?: TmdbCast[] } | null | undefined,
  details: TmdbTV | null | undefined,
): { criacaoDirecao: PessoaPublica[]; elenco: PessoaPublica[] } {
  const criacaoDirecao = new Map<number, PessoaPublica>();

  for (const person of details?.created_by ?? []) {
    criacaoDirecao.set(person.id, {
      id: person.id,
      name: person.name,
      profile_path: person.profile_path ?? null,
      role: "Criação",
    });
  }
  for (const person of credits?.crew ?? []) {
    const directed = person.job === "Director" || person.jobs?.some((job) => job.job === "Director");
    if (!directed) continue;
    const current = criacaoDirecao.get(person.id);
    criacaoDirecao.set(person.id, {
      id: person.id,
      name: person.name,
      profile_path: person.profile_path ?? null,
      role: current ? "Criação e direção" : "Direção",
    });
  }

  const elenco = (credits?.cast ?? []).slice(0, 16).map((person) => ({
    id: person.id,
    name: person.name,
    profile_path: person.profile_path ?? null,
    role: person.character ?? person.roles?.[0]?.character ?? null,
  }));

  return { criacaoDirecao: [...criacaoDirecao.values()], elenco };
}
