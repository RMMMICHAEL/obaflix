"use client";

import { useEffect, useState } from "react";
import { LandscapeRow } from "@/components/ui/LandscapeRow";
import type { RecommendationRow } from "@/lib/recommendations";

export function PersonalizedRows() {
  const [rows, setRows] = useState<RecommendationRow[] | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/recommendations", { signal: controller.signal, cache: "no-store" })
      .then(async (response) => response.ok ? response.json() : null)
      .then((data) => setRows(data?.rows ?? []))
      .catch((error) => {
        if (error?.name !== "AbortError") setRows([]);
      });
    return () => controller.abort();
  }, []);

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
