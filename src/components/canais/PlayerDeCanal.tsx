"use client";

import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import type { ItemDeCanal } from "@/lib/canais/catalogo";

/**
 * Player de canal ao vivo.
 *
 * Próprio, e não o `CustomPlayer` de filmes/séries, de propósito. Aquele é a
 * área mais sensível do repositório — carrega failover de fontes, extração,
 * legendas, retomada e anúncios — e canal ao vivo não precisa de nada disso:
 * precisa de uma URL de manifesto, sem linha do tempo e sem retomada. Encaixar
 * canais lá dentro significaria mexer no caminho de filmes para servir um caso
 * que não compartilha nenhuma das regras dele.
 *
 * ## O que este componente nunca vê
 *
 * A URL upstream, o provider, o host do CDN, o Referer. Ele recebe do
 * `/play` uma URL de manifesto no domínio de mídia do Obaflix e é só o que
 * existe no estado. Nada é guardado em `localStorage`: a concessão é curta e
 * uma URL persistida seria uma cópia sobrevivendo à sessão que a autorizou.
 */

interface Concessao {
  manifestUrl: string;
  expiraEm: number;
}

type Estado =
  | { fase: "pedindo" }
  | { fase: "tocando"; concessao: Concessao }
  | { fase: "erro"; mensagem: string; podeTentarDeNovo: boolean };

async function pedirConcessao(canalId: string): Promise<Concessao> {
  const r = await fetch(`/api/canais/${encodeURIComponent(canalId)}/play`, {
    method: "POST",
    headers: { Accept: "application/json" },
  });

  if (!r.ok) {
    const corpo = (await r.json().catch(() => ({}))) as { erro?: string; nivelExigido?: string };
    // Mensagens genéricas, por decisão de exposição: o usuário comum não
    // recebe motivo técnico, host, provider nem status do provedor.
    if (r.status === 401) throw new ErroDeCanal("Faça login para assistir.", false);
    if (r.status === 403) {
      throw new ErroDeCanal(
        corpo.nivelExigido
          ? `Este canal faz parte do plano ${corpo.nivelExigido}.`
          : "Seu plano não inclui este canal.",
        false,
      );
    }
    if (r.status === 404) throw new ErroDeCanal("Canal indisponível no momento.", false);
    if (r.status === 429) throw new ErroDeCanal("Muitas tentativas. Aguarde um instante.", true);
    throw new ErroDeCanal("Não foi possível iniciar o canal agora.", true);
  }

  return (await r.json()) as Concessao;
}

class ErroDeCanal extends Error {
  constructor(mensagem: string, readonly podeTentarDeNovo: boolean) {
    super(mensagem);
  }
}

export function PlayerDeCanal({ canal, onFechar }: { canal: ItemDeCanal; onFechar: () => void }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [estado, setEstado] = useState<Estado>({ fase: "pedindo" });
  const [tentativa, setTentativa] = useState(0);

  // ── Concessão ──────────────────────────────────────────────────────────────
  useEffect(() => {
    let vivo = true;
    setEstado({ fase: "pedindo" });
    pedirConcessao(canal.id)
      .then((concessao) => {
        if (vivo) setEstado({ fase: "tocando", concessao });
      })
      .catch((e: unknown) => {
        if (!vivo) return;
        const erro = e instanceof ErroDeCanal ? e : null;
        setEstado({
          fase: "erro",
          mensagem: erro?.message ?? "Não foi possível iniciar o canal agora.",
          podeTentarDeNovo: erro?.podeTentarDeNovo ?? true,
        });
      });
    return () => {
      vivo = false;
    };
  }, [canal.id, tentativa]);

  // ── HLS ────────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (estado.fase !== "tocando") return;
    const video = videoRef.current;
    if (!video) return;

    const url = estado.concessao.manifestUrl;
    let destruir = () => {};
    let cancelado = false;

    // Safari e a WebView do Android tocam HLS nativamente; aí o hls.js só
    // acrescentaria uma camada de buffer sobre algo que já funciona.
    if (video.canPlayType("application/vnd.apple.mpegurl") !== "") {
      video.src = url;
      video.play().catch(() => {});
    } else {
      import("hls.js").then(({ default: Hls }) => {
        if (cancelado || !Hls.isSupported()) return;
        const hls = new Hls({
          // Live: começar perto da borda, e não no início do buffer disponível.
          liveSyncDurationCount: 3,
          enableWorker: true,
        });
        hls.loadSource(url);
        hls.attachMedia(video);
        hls.on(Hls.Events.MANIFEST_PARSED, () => void video.play().catch(() => {}));
        hls.on(Hls.Events.ERROR, (_e, dados) => {
          if (!dados.fatal) return;
          // Erro fatal de rede num canal ao vivo costuma ser a concessão
          // vencida ou a fonte caindo. Pede outra — uma vez, pelo incremento
          // de `tentativa`, e não em laço: quem falha duas vezes não vai
          // passar na terceira, e insistir vira tempestade contra o edge.
          setEstado({
            fase: "erro",
            mensagem: "A transmissão foi interrompida.",
            podeTentarDeNovo: true,
          });
        });
        destruir = () => hls.destroy();
      });
    }

    return () => {
      cancelado = true;
      destruir();
      video.removeAttribute("src");
      video.load();
    };
  }, [estado]);

  // ── BACK / ESC fecham ──────────────────────────────────────────────────────
  useEffect(() => {
    const aoTeclar = (e: KeyboardEvent) => {
      if (e.key === "Escape" || e.key === "Backspace") onFechar();
    };
    window.addEventListener("keydown", aoTeclar);
    return () => window.removeEventListener("keydown", aoTeclar);
  }, [onFechar]);

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-black">
      <div className="flex items-center gap-3 px-4 py-3">
        <button
          type="button"
          onClick={onFechar}
          className="rounded-lg p-2 text-zinc-300 transition hover:bg-zinc-800 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-red-500"
          aria-label="Fechar"
        >
          <X className="h-5 w-5" aria-hidden />
        </button>
        <span className="truncate text-sm font-semibold text-white">{canal.nome}</span>
        <span className="rounded bg-red-600 px-1.5 py-0.5 text-[10px] font-bold leading-none text-white">
          AO VIVO
        </span>
      </div>

      <div className="relative flex-1">
        <video
          ref={videoRef}
          className="h-full w-full bg-black"
          playsInline
          autoPlay
          controls
          // Canal ao vivo não tem pôster próprio e não retoma de lugar nenhum.
          preload="none"
        />

        {estado.fase === "pedindo" && (
          <div className="absolute inset-0 grid place-items-center bg-black/80">
            <div className="flex flex-col items-center gap-3">
              <span className="h-8 w-8 animate-spin rounded-full border-2 border-zinc-700 border-t-red-600" />
              <span className="text-sm text-zinc-400">Conectando…</span>
            </div>
          </div>
        )}

        {estado.fase === "erro" && (
          <div className="absolute inset-0 grid place-items-center bg-black/90 px-6">
            <div className="flex max-w-sm flex-col items-center gap-4 text-center">
              <p className="text-sm text-zinc-300">{estado.mensagem}</p>
              <div className="flex gap-2">
                {estado.podeTentarDeNovo && (
                  <button
                    type="button"
                    onClick={() => setTentativa((n) => n + 1)}
                    className="rounded-lg bg-red-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-red-700"
                  >
                    Tentar de novo
                  </button>
                )}
                <button
                  type="button"
                  onClick={onFechar}
                  className="rounded-lg border border-zinc-700 px-4 py-2 text-sm font-semibold text-zinc-300 transition hover:bg-zinc-800"
                >
                  Voltar
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
