export type ContentType = "filme" | "serie" | "anime" | "desenho";

export interface FilmeCard {
  id: string;
  titulo: string;
  poster: string | null;
  background: string | null;
  ano: number | null;
  nota: number | null;
  duracao: number | null;
  urlDub: string | null;
  urlLeg: string | null;
  generos: { id: number; nome: string }[];
  progresso?: { progressoSeg: number; duracaoSeg: number | null; concluido: boolean } | null;
}

export interface SerieCard {
  id: string;
  titulo: string;
  poster: string | null;
  background: string | null;
  ano: number | null;
  nota: number | null;
  tipo: string;
  temporadas: number | null;
  generos: { id: number; nome: string }[];
}

export interface EpisodioCard {
  id: string;
  numeroEp: number;
  temporada: number;
  titulo: string | null;
  thumbnail: string | null;
  urlDub: string | null;
  urlLeg: string | null;
  createdAt: Date;
  progresso?: { progressoSeg: number; duracaoSeg: number | null; concluido: boolean } | null;
}

export interface ProgressoPayload {
  conteudoId: string;
  conteudoTipo: "filme" | "serie";
  episodioId?: string;
  temporada?: number;
  numeroEp?: number;
  progressoSeg: number;
  duracaoSeg?: number;
}
