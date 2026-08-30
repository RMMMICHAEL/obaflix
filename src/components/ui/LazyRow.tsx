"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

/**
 * Adia a montagem dos filhos até que o contêiner esteja a 500px do viewport.
 * Impede que imagens de rows abaixo do fold carreguem antes de serem necessárias.
 * 500px de antecedência garante scroll suave sem flickering.
 */
export function LazyRow({ children, height = 280 }: { children: ReactNode; height?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setVisible(true);
          io.disconnect();
        }
      },
      { rootMargin: "500px 0px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  return (
    <div ref={ref}>
      {visible ? children : (
        <div className="px-6 py-3 md:px-12" style={{ minHeight: height }} aria-hidden="true">
          <div className="mb-3 h-6 w-40 animate-pulse rounded bg-zinc-800/70" />
          <div className="flex gap-3 overflow-hidden">
            {Array.from({ length: 6 }).map((_, index) => (
              <div
                key={index}
                className="aspect-video w-[220px] shrink-0 animate-pulse rounded-xl bg-zinc-900 md:w-[280px]"
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
