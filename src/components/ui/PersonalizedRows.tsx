"use client";

import { useEffect, useState } from "react";
import { useSession } from "next-auth/react";
import { LandscapeRow } from "@/components/ui/LandscapeRow";
import type { RecommendationRow } from "@/lib/recommendations";

export function PersonalizedRows() {
  const [rows, setRows] = useState<RecommendationRow[] | null>(null);
  // A Navbar já monta `useSession` no layout, então o estado vem do contexto do
  // SessionProvider: ler daqui não dispara requisição nova. Antes o componente
  // chamava /api/recommendations em toda visita, inclusive deslogada, só para
  // receber 401 — uma invocação de função na Vercel por visitante anônimo.
  const { status } = useSession();

  useEffect(() => {
    if (status === "unauthenticated") {
      setRows([]);
      return;
    }
    if (status !== "authenticated") return;

    const controller = new AbortController();
    // Sem `cache: "no-store"`: é ele que faria o navegador ignorar o
    // `private, max-age=60` da rota e refazer a chamada a cada remontagem.
    fetch("/api/recommendations", { signal: controller.signal })
      .then(async (response) => response.ok ? response.json() : null)
      .then((data) => setRows(data?.rows ?? []))
      .catch((error) => {
        if (error?.name !== "AbortError") setRows([]);
      });
    return () => controller.abort();
  }, [status]);

  if (rows === null) {
    return (
      <div className="px-4 pt-6 pb-4 md:px-14 md:pt-10 md:pb-6" aria-label="Carregando recomendações">
        <div className="h-5 w-48 animate-pulse rounded bg-zinc-800" />
        <div className="mt-3 flex gap-3 overflow-hidden">
          {Array.from({ length: 7 }).map((_, index) => (
            <div key={index} className="aspect-video w-[200px] flex-none animate-pulse rounded-lg bg-zinc-900 md:w-[280px]" />
          ))}
        </div>
      </div>
    );
  }

  if (!rows.length) return null;

  return (
    <div aria-label="Recomendações personalizadas">
      {rows.map((row) => <LandscapeRow key={row.id} titulo={row.titulo} items={row.items} />)}
    </div>
  );
}
