"use client";

import { createContext, useContext, useEffect, useState } from "react";

export type ProgressoEpisodio = {
  progressoSeg: number;
  duracaoSeg: number | null;
  concluido: boolean;
};

export type EstadoPessoal = {
  /** Enquanto true, quem depende do estado mostra skeleton em vez de valor errado. */
  carregando: boolean;
  continuar: { temporada: number | null; numeroEp: number | null; progressoSeg: number } | null;
  progressoEpisodios: Record<string, ProgressoEpisodio>;
};

const NEUTRO: EstadoPessoal = { carregando: false, continuar: null, progressoEpisodios: {} };

/**
 * O default e neutro e nao-carregando de proposito: um componente usado fora do
 * provider (ou numa pagina sem estado pessoal) renderiza a versao publica em vez
 * de ficar preso num skeleton.
 */
const EstadoPessoalContext = createContext<EstadoPessoal>(NEUTRO);

export function useEstadoPessoal() {
  return useContext(EstadoPessoalContext);
}

/**
 * Busca, depois da hidratacao, o que pertence ao usuario nesta pagina.
 *
 * A pagina de detalhe e HTML cacheado e igual para todo mundo; nada de sessao
 * pode entrar no render do servidor. Progresso, continuar assistindo e rotulo do
 * botao chegam por esta chamada, que e autenticada e no-store. Deslogado recebe
 * o objeto vazio e a pagina continua exatamente como veio do cache.
 */
export function EstadoPessoalProvider({
  conteudoId,
  tipo,
  children,
}: {
  conteudoId: string;
  tipo: "filme" | "serie";
  children: React.ReactNode;
}) {
  const [estado, setEstado] = useState<EstadoPessoal>({ ...NEUTRO, carregando: true });

  useEffect(() => {
    let vivo = true;
    setEstado({ ...NEUTRO, carregando: true });

    fetch(`/api/user/continue?conteudoId=${encodeURIComponent(conteudoId)}&tipo=${tipo}`, {
      cache: "no-store",
    })
      .then((res) => (res.ok ? res.json() : null))
      .then((dados) => {
        if (!vivo) return;
        setEstado({
          carregando: false,
          continuar: dados?.continuar ?? null,
          progressoEpisodios: dados?.progressoEpisodios ?? {},
        });
      })
      .catch(() => {
        // Falhou: a pagina fica na versao publica, que ja esta na tela.
        if (vivo) setEstado(NEUTRO);
      });

    return () => {
      vivo = false;
    };
  }, [conteudoId, tipo]);

  return <EstadoPessoalContext.Provider value={estado}>{children}</EstadoPessoalContext.Provider>;
}
