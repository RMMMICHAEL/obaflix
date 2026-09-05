"use client";

import { AndroidMediaActions, useAcoesDeMidiaDisponiveis } from "./AndroidMediaActions";
import { useFonteParaMidia } from "./useFonteParaMidia";
import { pidDeEpisodio, rotuloDeEpisodio } from "@/lib/androidMedia";

/**
 * Baixar e Transmitir na linha de um episódio.
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
  serieTitulo,
  temporada,
  numeroEp,
  tituloEpisodio,
  poster,
}: {
  serieId: string;
  /** Nome da série, para o título do modal ficar "Série - 1x3". */
  serieTitulo: string;
  temporada: number;
  numeroEp: number;
  tituloEpisodio: string;
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
    // Alinhado com o texto do episódio, não com a miniatura: a linha de ações
    // pertence ao bloco de informação, e recuá-la até a borda da imagem a
    // deixaria órfã embaixo do card.
    <div className="mt-1 pl-[9.5rem] pb-3 sm:pl-[14rem] md:pl-[16rem]">
      <AndroidMediaActions
        // Id público e estável: identifica o episódio para a fila de downloads
        // sem carregar nada da fonte.
        pid={pidDeEpisodio(serieId, temporada, numeroEp)}
        titulo={tituloEpisodio}
        tituloCurto={rotuloDeEpisodio(serieTitulo, temporada, numeroEp)}
        poster={poster}
        resolverFonte={resolverFonte}
        variante="episodio"
      />
    </div>
  );
}
