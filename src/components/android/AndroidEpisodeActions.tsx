"use client";

import { AndroidMediaActions, useAcoesDeMidiaDisponiveis } from "./AndroidMediaActions";
import { useFonteParaMidia } from "./useFonteParaMidia";

/**
 * Baixar e Transmitir ao lado de um episódio.
 *
 * Componente próprio porque `useFonteParaMidia` é um hook e não pode ser
 * chamado dentro do `map` da lista: cada episódio precisa da própria sessão de
 * fontes, então cada linha precisa da própria instância.
 *
 * Fora do aplicativo Android devolve `null` antes de qualquer trabalho — nem a
 * sessão de fontes é aberta, então o site normal não ganha nenhuma requisição.
 */
export function AndroidEpisodeActions({
  serieId,
  temporada,
  numeroEp,
  titulo,
  poster,
}: {
  serieId: string;
  temporada: number;
  numeroEp: number;
  titulo: string;
  poster?: string | null;
}) {
  const disponivel = useAcoesDeMidiaDisponiveis();
  const resolverFonte = useFonteParaMidia({
    conteudoId: serieId,
    conteudoTipo: "serie",
    temporada,
    numeroEp,
  });

  if (!disponivel) return null;

  return (
    <div className="flex items-center gap-1 pl-[9.5rem] pt-1 sm:pl-[13rem] md:pl-[15rem]">
      <AndroidMediaActions
        // Id público e estável: identifica o episódio para a fila de downloads
        // sem carregar nada da fonte.
        pid={`serie:${serieId}:t${temporada}:e${numeroEp}`}
        titulo={titulo}
        poster={poster}
        resolverFonte={resolverFonte}
        compacto
      />
    </div>
  );
}
