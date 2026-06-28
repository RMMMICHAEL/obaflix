"use client";

import { useState, useEffect } from "react";
import { ThumbsUp, ThumbsDown, Heart, Loader2 } from "lucide-react";

interface Props {
  conteudoId: string;
  tipo: "filme" | "serie" | "anime" | "desenho";
}

type LikeValor = 1 | -1 | 0;

export function LikeButtons({ conteudoId, tipo }: Props) {
  const [like, setLike] = useState<LikeValor>(0);
  const [inWatchlist, setInWatchlist] = useState(false);
  const [ready, setReady] = useState(false);
  const [authenticated, setAuthenticated] = useState(false);

  const watchlistTipo = tipo === "filme" ? "filme" : "serie";

  useEffect(() => {
    Promise.all([
      fetch(`/api/like?conteudoId=${conteudoId}&conteudoTipo=${tipo}`),
      fetch(`/api/user/watchlist/check?conteudoId=${conteudoId}&conteudoTipo=${watchlistTipo}`),
    ])
      .then(async ([likeRes, wlRes]) => {
        if (likeRes.status === 401) return;
        setAuthenticated(true);
        const likeData = await likeRes.json().catch(() => ({}));
        const wlData = await wlRes.json().catch(() => ({}));
        setLike((likeData.valor ?? 0) as LikeValor);
        setInWatchlist(!!wlData.inWatchlist);
      })
      .finally(() => setReady(true));
  }, [conteudoId, tipo, watchlistTipo]);

  const handleLike = async (valor: 1 | -1) => {
    const newValor: LikeValor = like === valor ? 0 : valor;
    setLike(newValor);
    await fetch("/api/like", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ conteudoId, conteudoTipo: tipo, valor: newValor }),
    });
  };

  const toggleWatchlist = async () => {
    const next = !inWatchlist;
    setInWatchlist(next);
    await fetch("/api/user/watchlist", {
      method: next ? "POST" : "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ conteudoId, conteudoTipo: watchlistTipo }),
    });
  };

  if (!ready) {
    return (
      <div className="flex items-center gap-2">
        <Loader2 size={16} className="text-zinc-600 animate-spin" />
      </div>
    );
  }

  if (!authenticated) return null;

  return (
    <div className="flex items-center gap-2 flex-wrap">
      <button
        onClick={toggleWatchlist}
        className={`flex items-center gap-2 px-4 py-2.5 rounded-lg border font-semibold text-sm transition ${
          inWatchlist
            ? "bg-red-600 border-red-600 text-white"
            : "border-zinc-600 text-zinc-300 hover:border-white hover:text-white bg-transparent"
        }`}
      >
        <Heart size={15} fill={inWatchlist ? "currentColor" : "none"} />
        {inWatchlist ? "Na Lista" : "Minha Lista"}
      </button>

      <button
        onClick={() => handleLike(1)}
        title="Gostei"
        className={`flex items-center gap-1.5 px-3 py-2.5 rounded-lg border text-sm font-semibold transition ${
          like === 1
            ? "bg-green-600 border-green-600 text-white"
            : "border-zinc-600 text-zinc-400 hover:border-white hover:text-white bg-transparent"
        }`}
      >
        <ThumbsUp size={15} />
        {like === 1 ? "Gostei" : "Gostei"}
      </button>

      <button
        onClick={() => handleLike(-1)}
        title="Não Gostei"
        className={`flex items-center gap-1.5 px-3 py-2.5 rounded-lg border text-sm transition ${
          like === -1
            ? "bg-zinc-500 border-zinc-400 text-white"
            : "border-zinc-600 text-zinc-500 hover:border-white hover:text-zinc-300 bg-transparent"
        }`}
      >
        <ThumbsDown size={15} />
      </button>
    </div>
  );
}
