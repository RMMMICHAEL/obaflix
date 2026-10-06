"use client";

import { createContext, useContext, useEffect, useMemo, useState } from "react";
import { usePathname } from "next/navigation";
import { ehNavegadorComum } from "@/config/client-surface";
import { CatalogAppModal, type AquisicaoPayload } from "./CatalogAppModal";

/**
 * Ponto único da conversão da ficha para navegador comum.
 *
 * As ações de assistir (botão do hero, "continuar assistindo", episódios) são a
 * MESMA marcação para os três públicos — a página é cacheada e idêntica. Quem
 * decide o que o clique faz é este provider, depois da hidratação:
 *
 *   - navegador comum, streaming web fechado → `deveInterceptar` é `true`: o
 *     clique abre o modal de download em vez de ir ao player (que, para o
 *     navegador, só redirecionaria para a landing);
 *   - Electron, Android, ou streaming web reaberto → `deveInterceptar` é
 *     `false`: o `<Link>` navega normalmente, e o comportamento homologado dos
 *     aplicativos não muda.
 *
 * O padrão fora do provider é inerte (`deveInterceptar: false`, `abrir` no-op),
 * então consumir o contexto nunca quebra uma árvore que não o tenha.
 */

type Contexto = {
  deveInterceptar: boolean;
  abrir: (payload: AquisicaoPayload) => void;
};

const AcquisitionContext = createContext<Contexto>({
  deveInterceptar: false,
  abrir: () => {},
});

export const useAquisicaoApp = () => useContext(AcquisitionContext);

export function AcquisitionProvider({
  streamingAberto,
  children,
}: {
  /** `WEB_STREAMING_ENABLED`: aberto, ninguém é interceptado. */
  streamingAberto: boolean;
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const [navegador, setNavegador] = useState(false);
  const [payload, setPayload] = useState<AquisicaoPayload | null>(null);

  // Só no cliente: no primeiro render do servidor não há ambiente a detectar, e
  // cliques só acontecem depois da hidratação de qualquer forma.
  useEffect(() => {
    setNavegador(ehNavegadorComum(pathname));
  }, [pathname]);

  const deveInterceptar = navegador && !streamingAberto;

  const value = useMemo<Contexto>(
    () => ({
      deveInterceptar,
      abrir: (p) => {
        if (deveInterceptar) setPayload(p);
      },
    }),
    [deveInterceptar],
  );

  return (
    <AcquisitionContext.Provider value={value}>
      {children}
      {payload && <CatalogAppModal payload={payload} onFechar={() => setPayload(null)} />}
    </AcquisitionContext.Provider>
  );
}
