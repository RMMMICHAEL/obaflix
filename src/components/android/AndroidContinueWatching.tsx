"use client";

import Image from "next/image";
import Link from "next/link";
import { Play, X } from "lucide-react";
import { useState } from "react";
import { imgUrl } from "@/lib/tmdb";
import type { ContinueWatchingItem as ContinueItem } from "@/lib/continue-watching";

function watchUrl(item: ContinueItem) {
  if (item.tipo === "filme") return `/assistir/filme/${item.id}`;
  if (item.temporada && item.numeroEp) {
    return `/assistir/serie/${item.id}/t${item.temporada}/ep${item.numeroEp}`;
  }
  return `/serie/${item.id}`;
}

function progress(item: ContinueItem) {
  if (!item.duracaoSeg || item.duracaoSeg <= 0) return 0;
  return Math.min(100, Math.max(0, (item.progressoSeg / item.duracaoSeg) * 100));
}

export function AndroidContinueWatching({ initialItems }: { initialItems: ContinueItem[] }) {
  const [items, setItems] = useState<ContinueItem[]>(initialItems);

  async function remove(historyId: string) {
    setItems((current) => current.filter((item) => item.historyId !== historyId));
    await fetch("/api/continuar-assistindo", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ historyId }),
    }).catch(() => {});
  }

  if (!items.length) return null;

  return (
    <section className="android-rail" aria-labelledby="android-continue-title">
      <div className="android-section-heading">
        <h2 id="android-continue-title">Continuar assistindo</h2>
      </div>
      <div className="android-wide-track">
        {items.map((item) => {
          const value = progress(item);
          const image = item.background
            ? imgUrl(item.background, "w780")
            : item.poster
              ? imgUrl(item.poster, "w342")
              : "/placeholder-bg.jpg";
          const episode = item.temporada && item.numeroEp ? `T${item.temporada} E${item.numeroEp}` : null;

          return (
            <article className="android-progress-card" key={item.historyId}>
              <Link href={watchUrl(item)} aria-label={`Continuar ${item.titulo}`}>
                <div className="android-progress-art">
                  <Image src={image} alt="" fill sizes="(max-width: 480px) 70vw, 310px" />
                  <span className="android-progress-play"><Play size={18} fill="currentColor" /></span>
                  {episode && <span className="android-episode-index">{episode}</span>}
                  {item.queued && item.progressoSeg === 0 && <span className="android-next-badge">Próximo</span>}
                  <span className="android-progress-line" aria-hidden="true">
                    <span style={{ width: `${value}%` }} />
                  </span>
                </div>
                <strong>{item.titulo}</strong>
                <span>{value > 0 ? `${Math.round(value)}% assistido` : "Pronto para começar"}</span>
              </Link>
              <button type="button" onClick={() => remove(item.historyId)} aria-label={`Remover ${item.titulo} do histórico`}>
                <X size={16} />
              </button>
            </article>
          );
        })}
      </div>
    </section>
  );
}
