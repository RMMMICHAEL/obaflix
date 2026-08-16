"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ContentCard } from "./ContentCard";

type Studio = {
  id: string;
  name: string;
  accent: string;
};

type StudioItem = {
  id: string;
  tipo: "filme" | "anime" | "desenho";
  titulo: string;
  poster: string | null;
  ano: number | null;
  nota: number | null;
};

type Props = {
  studios: Studio[];
  initialStudioId: string;
};

export function KidsStudioBrowser({ studios, initialStudioId }: Props) {
  const sectionRef = useRef<HTMLElement>(null);
  const cacheRef = useRef(new Map<string, StudioItem[]>());
  const [selectedId, setSelectedId] = useState(initialStudioId);
  const [shouldLoad, setShouldLoad] = useState(false);
  const [items, setItems] = useState<StudioItem[] | null>(null);
  const [failed, setFailed] = useState(false);
  const selectedStudio = useMemo(
    () => studios.find((studio) => studio.id === selectedId) ?? studios[0],
    [selectedId, studios],
  );

  useEffect(() => {
    const section = sectionRef.current;
    if (!section) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setShouldLoad(true);
          observer.disconnect();
        }
      },
      { rootMargin: "600px 0px" },
    );
    observer.observe(section);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!shouldLoad || !selectedStudio) return;
    const cached = cacheRef.current.get(selectedStudio.id);
    if (cached) {
      setItems(cached);
      setFailed(false);
      return;
    }

    const controller = new AbortController();
    setItems(null);
    setFailed(false);
    fetch(`/api/desenhos/studio?studio=${encodeURIComponent(selectedStudio.id)}`, { signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error("Falha ao carregar estúdio");
        return response.json() as Promise<{ items: StudioItem[] }>;
      })
      .then((data) => {
        cacheRef.current.set(selectedStudio.id, data.items);
        setItems(data.items);
      })
      .catch((error) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setFailed(true);
        setItems([]);
      });
    return () => controller.abort();
  }, [selectedStudio, shouldLoad]);

  function selectStudio(id: string) {
    setSelectedId(id);
    setShouldLoad(true);
    const url = new URL(window.location.href);
    url.searchParams.set("studio", id);
    window.history.replaceState(null, "", `${url.pathname}${url.search}#estudios`);
  }

  return (
    <section ref={sectionRef} id="estudios" className="scroll-mt-24 px-6 py-8 md:px-12">
      <div className="grid gap-7 lg:grid-cols-[210px_minmax(0,1fr)]">
        <div>
          <p className="mb-3 text-xs font-bold uppercase tracking-[0.14em] text-[oklch(0.82_0.10_96)]">Estúdios</p>
          <nav className="flex gap-2 overflow-x-auto pb-2 scrollbar-hide lg:max-h-[520px] lg:flex-col lg:overflow-y-auto lg:pr-2" aria-label="Estúdios de animação">
            {studios.map((studio) => {
              const active = studio.id === selectedStudio.id;
              return (
                <button
                  type="button"
                  key={studio.id}
                  aria-pressed={active}
                  onClick={() => selectStudio(studio.id)}
                  className={`inline-flex min-h-11 shrink-0 items-center rounded-xl px-4 text-left text-sm font-bold transition-colors duration-200 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[oklch(0.92_0.12_96)] ${active ? "bg-[oklch(0.87_0.16_96)] text-[oklch(0.24_0.06_205)]" : "bg-[oklch(0.24_0.07_190)] text-[oklch(0.92_0.025_190)] hover:bg-[oklch(0.29_0.08_190)]"}`}
                >
                  <span className="mr-2 h-2 w-2 rounded-full" style={{ backgroundColor: studio.accent }} aria-hidden="true" />
                  {studio.name}
                </button>
              );
            })}
          </nav>
        </div>

        <div className="min-w-0" aria-live="polite">
          <p className="text-xs font-semibold uppercase tracking-[0.14em] text-[oklch(0.70_0.055_205)]">Infantil / {selectedStudio.name}</p>
          <h2 className="mt-1 text-2xl font-black tracking-tight">{selectedStudio.name}</h2>

          {!shouldLoad || items === null ? (
            <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-5" aria-hidden="true">
              {Array.from({ length: 10 }).map((_, index) => (
                <div key={index} className="aspect-[2/3] animate-pulse rounded-lg bg-[oklch(0.21_0.045_205)]" />
              ))}
            </div>
          ) : items.length > 0 ? (
            <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-5">
              {items.map((item) => <ContentCard key={`${item.tipo}-${item.id}`} {...item} />)}
            </div>
          ) : (
            <p className="mt-8 rounded-xl bg-[oklch(0.21_0.045_205)] p-6 text-sm text-[oklch(0.76_0.035_205)]">
              {failed ? "Não foi possível carregar este estúdio agora." : "Nenhum título disponível deste estúdio no catálogo atual."}
            </p>
          )}
        </div>
      </div>
    </section>
  );
}
