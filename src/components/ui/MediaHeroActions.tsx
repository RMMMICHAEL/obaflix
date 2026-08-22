"use client";

import { useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { Check, Loader2, Plus, Share2, ThumbsUp } from "lucide-react";

interface Props {
  conteudoId: string;
  tipo: "filme" | "serie" | "anime" | "desenho";
  shareUrl: string;
  titulo: string;
}

/**
 * Botoes redondos do hero: Minha Lista, Gostei e Compartilhar.
 *
 * Diferente do antigo LikeButtons, este bloco nunca some quando o visitante
 * esta deslogado — ele so redireciona pro login. Sumir mudava a largura da
 * linha de acoes depois da hidratacao e fazia o hero "pular".
 */
export function MediaHeroActions({ conteudoId, tipo, shareUrl, titulo }: Props) {
  const router = useRouter();
  const pathname = usePathname();
  const [liked, setLiked] = useState(false);
  const [inWatchlist, setInWatchlist] = useState(false);
  const [authenticated, setAuthenticated] = useState(false);
  const [ready, setReady] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const watchlistTipo = tipo === "filme" ? "filme" : "serie";

  useEffect(() => {
    let alive = true;
    Promise.all([
      fetch(`/api/like?conteudoId=${conteudoId}&conteudoTipo=${tipo}`),
      fetch(`/api/user/watchlist/check?conteudoId=${conteudoId}&conteudoTipo=${watchlistTipo}`),
    ])
      .then(async ([likeRes, wlRes]) => {
        if (!alive || likeRes.status === 401) return;
        const likeData = await likeRes.json().catch(() => ({}));
        const wlData = await wlRes.json().catch(() => ({}));
        setAuthenticated(true);
        setLiked(likeData.valor === 1);
        setInWatchlist(!!wlData.inWatchlist);
      })
      .catch(() => {})
      .finally(() => alive && setReady(true));
    return () => {
      alive = false;
    };
  }, [conteudoId, tipo, watchlistTipo]);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 2400);
    return () => clearTimeout(timer);
  }, [toast]);

  // O /login so aceita callbackUrl relativo, por isso mandamos o pathname.
  const requireLogin = () => {
    router.push(`/login?callbackUrl=${encodeURIComponent(pathname || "/")}`);
  };

  const toggleWatchlist = async () => {
    if (!authenticated) return requireLogin();
    const next = !inWatchlist;
    setInWatchlist(next);
    setToast(next ? "Adicionado à Minha Lista" : "Removido da Minha Lista");
    await fetch("/api/user/watchlist", {
      method: next ? "POST" : "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ conteudoId, conteudoTipo: watchlistTipo }),
    }).catch(() => setInWatchlist(!next));
  };

  const toggleLike = async () => {
    if (!authenticated) return requireLogin();
    const next = !liked;
    setLiked(next);
    await fetch("/api/like", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ conteudoId, conteudoTipo: tipo, valor: next ? 1 : 0 }),
    }).catch(() => setLiked(!next));
  };

  const share = async () => {
    const url = typeof window !== "undefined" ? window.location.href : shareUrl;
    if (navigator.share) {
      try {
        await navigator.share({ title: titulo, url });
        return;
      } catch {
        // usuario cancelou o menu nativo: cai pro copiar sem avisar erro
      }
    }
    try {
      await navigator.clipboard.writeText(url);
      setToast("Link copiado");
    } catch {
      setToast("Não foi possível copiar o link");
    }
  };

  return (
    <div className="relative flex items-center gap-2.5">
      <HeroIconButton
        onClick={toggleWatchlist}
        active={inWatchlist}
        label={inWatchlist ? "Remover da Minha Lista" : "Adicionar à Minha Lista"}
        busy={!ready}
      >
        {inWatchlist ? <Check size={20} strokeWidth={2.4} /> : <Plus size={20} strokeWidth={2.2} />}
      </HeroIconButton>

      <HeroIconButton onClick={toggleLike} active={liked} label="Gostei" busy={!ready}>
        <ThumbsUp size={18} fill={liked ? "currentColor" : "none"} strokeWidth={2} />
      </HeroIconButton>

      <HeroIconButton onClick={share} label="Compartilhar">
        <Share2 size={18} strokeWidth={2} />
      </HeroIconButton>

      {toast && (
        <span
          role="status"
          className="pointer-events-none absolute -top-11 left-0 whitespace-nowrap rounded-lg bg-zinc-900/95 px-3 py-1.5 text-xs font-medium text-zinc-100 shadow-lg ring-1 ring-white/10"
        >
          {toast}
        </span>
      )}
    </div>
  );
}

function HeroIconButton({
  children,
  onClick,
  label,
  active = false,
  busy = false,
}: {
  children: React.ReactNode;
  onClick: () => void;
  label: string;
  active?: boolean;
  busy?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      aria-pressed={active}
      className={`grid h-12 w-12 shrink-0 place-items-center rounded-full border backdrop-blur-sm transition-colors duration-200 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white/70 md:h-[3.25rem] md:w-[3.25rem] ${
        active
          ? "border-white/70 bg-white text-black"
          : "border-white/15 bg-white/10 text-white hover:border-white/40 hover:bg-white/20"
      }`}
    >
      {busy ? <Loader2 size={18} className="animate-spin opacity-60" /> : children}
    </button>
  );
}
