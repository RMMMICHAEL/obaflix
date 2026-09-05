"use client";

import { useCallback, useState } from "react";
import { Cast, Download } from "lucide-react";
import {
  AcaoBotao,
  AndroidMediaActions,
  grupoClasse,
  useAcoesDeMidiaDisponiveis,
} from "./AndroidMediaActions";
import { useFonteParaMidia } from "./useFonteParaMidia";
import {
  decidirAcaoDoHero,
  pidDoAlvo,
  rotuloDoAlvo,
  type EpisodioRef,
  type TipoDeConteudo,
} from "@/lib/androidMedia";

/**
 * Baixar e Transmitir ao lado do botão Assistir, no hero.
 *
 * ## Por que um componente e não um botão por página
 *
 * `MediaHero` é usado pela página de filme e pela de série — e anime e desenho
 * também caem em `/serie/[id]`, porque no catálogo são séries. Colocando as
 * ações aqui, os quatro tipos de conteúdo ganham Baixar e Transmitir de uma vez,
 * sem repetir botão em quatro lugares que depois divergem.
 *
 * ## Os três caminhos
 *
 * Quem decide é [decidirAcaoDoHero], que é puro e testável. Aqui só se desenha
 * o resultado:
 *
 * - **direto** — filme, episódio de retomada, ou série com exatamente um
 *   episódio. Segue para o fluxo normal, com modal de qualidade.
 * - **escolher** — duas ou mais opções. O botão não decide: leva até a lista de
 *   episódios, onde cada linha tem as ações diretas. Escolher lá é explícito, e
 *   evita construir um segundo seletor de temporada/episódio que divergiria do
 *   que o `EpisodeGrid` já faz.
 * - **indisponível** — não há mídia publicada. Os botões aparecem desabilitados
 *   com uma nota curta, em vez de sumirem ou de fingirem que há o que baixar.
 */
export function AndroidHeroActions({
  tipo,
  conteudoId,
  titulo,
  watchHref,
  poster,
  retomada = null,
  totalEpisodios,
  episodioUnico = null,
}: {
  tipo: TipoDeConteudo;
  conteudoId: string;
  titulo: string;
  /** Href do botão Assistir. Só é lido quando o conteúdo é um filme. */
  watchHref?: string | null;
  poster?: string | null;
  /**
   * Episódio de retomada.
   *
   * Chega nulo no primeiro render e preenchido quando o estado pessoal carrega
   * — os botões trocam de comportamento junto com o rótulo do botão Assistir,
   * que muda pelo mesmo motivo.
   */
  retomada?: EpisodioRef | null;
  /** Total de episódios, da mesma coleção que alimenta o EpisodeGrid. */
  totalEpisodios?: number;
  /** Identificação do único episódio, quando o total é 1. */
  episodioUnico?: EpisodioRef | null;
}) {
  const disponivel = useAcoesDeMidiaDisponiveis();
  const [dica, setDica] = useState<string | null>(null);

  const decisao = decidirAcaoDoHero({
    tipo,
    conteudoId,
    watchHref,
    retomada,
    totalEpisodios,
    episodioUnico,
  });

  const alvo = decisao.modo === "direto" ? decisao.alvo : null;

  // Hooks antes de qualquer return: `useFonteParaMidia` precisa ser chamado
  // sempre, mesmo quando não há alvo, senão a ordem dos hooks muda entre
  // renders quando o estado pessoal chega e a decisão troca. Ele só cria o
  // callback — nada é requisitado até alguém invocá-lo.
  const resolverFonte = useFonteParaMidia({
    conteudoId: alvo?.conteudoId ?? "",
    conteudoTipo: alvo?.tipo ?? "filme",
    temporada: alvo?.tipo === "serie" ? alvo.temporada : null,
    numeroEp: alvo?.tipo === "serie" ? alvo.numeroEp : null,
  });

  /**
   * Leva até a lista de episódios em vez de escolher um.
   *
   * Só rola a página: nenhuma navegação, nenhuma troca de rota e nenhum clique
   * em âncora — então isto não é intenção de reprodução para o gate de
   * anúncios, do mesmo jeito que os botões de ação não são.
   */
  const escolherEpisodio = useCallback((acao: "baixar" | "transmitir") => {
    const lista = typeof document !== "undefined" ? document.getElementById("episodios") : null;
    lista?.scrollIntoView({ behavior: "smooth", block: "start" });
    setDica(
      acao === "baixar"
        ? "Escolha o episódio que deseja baixar"
        : "Escolha o episódio que deseja transmitir",
    );
    setTimeout(() => setDica(null), 4000);
  }, []);

  if (!disponivel) return null;

  if (decisao.modo === "indisponivel") {
    return (
      <div className={grupoClasse("hero")}>
        <AcaoBotao variante="hero" estado="ocioso" Icone={Download} rotulo="Baixar" desabilitado onClick={() => {}} />
        <AcaoBotao variante="hero" estado="ocioso" Icone={Cast} rotulo="Transmitir" desabilitado onClick={() => {}} />
        <span role="status" className="text-xs leading-tight text-zinc-400">
          {tipo === "filme" ? "Indisponível para download" : "Nenhum episódio disponível"}
        </span>
      </div>
    );
  }

  if (decisao.modo === "escolher") {
    return (
      <div className={grupoClasse("hero")}>
        <AcaoBotao
          variante="hero"
          estado="ocioso"
          Icone={Download}
          rotulo="Baixar"
          onClick={() => escolherEpisodio("baixar")}
        />
        <AcaoBotao
          variante="hero"
          estado="ocioso"
          Icone={Cast}
          rotulo="Transmitir"
          onClick={() => escolherEpisodio("transmitir")}
        />
        {dica && (
          <span role="status" className="text-xs leading-tight text-zinc-300">
            {dica}
          </span>
        )}
      </div>
    );
  }

  return (
    <AndroidMediaActions
      pid={pidDoAlvo(decisao.alvo)}
      titulo={titulo}
      tituloCurto={rotuloDoAlvo(titulo, decisao.alvo)}
      poster={poster}
      resolverFonte={resolverFonte}
      variante="hero"
    />
  );
}
