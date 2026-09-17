"use client";

import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import type { ItemDeCanal } from "@/lib/canais/catalogo";
import {
  criarHandoff,
  type ConcessaoDeCanal,
  type ResultadoDePedido,
} from "@/lib/canais/handoff";

/**
 * Player de canal ao vivo.
 *
 * Próprio, e não o `CustomPlayer` de filmes/séries, de propósito. Aquele é a
 * área mais sensível do repositório — carrega failover de fontes, extração,
 * legendas, retomada e anúncios — e canal ao vivo não precisa de nada disso:
 * precisa de uma URL de manifesto, sem linha do tempo e sem retomada.
 *
 * ## O que este componente nunca vê
 *
 * A URL upstream, o provider, o host do CDN, o Referer. Ele recebe do `/play`
 * uma URL de manifesto no domínio de mídia do Obaflix e é só o que existe no
 * estado. Nada é guardado em `localStorage`: a concessão é curta e uma URL
 * persistida seria uma cópia sobrevivendo à sessão que a autorizou.
 *
 * ## A migração entre concessões é real
 *
 * O protocolo vive em `@/lib/canais/handoff`, testado à parte. Aqui está a
 * única coisa que ele não pode fazer sozinho: `trocarFonte` chama
 * `hls.loadSource(url)` — ou troca o `video.src` no HLS nativo — para o player
 * **passar a buscar** pela concessão nova.
 *
 * Guardar a URL numa referência não é migrar. Era o que a versão anterior
 * fazia, e o resultado é 403 no meio da reprodução assim que a janela de grace
 * do servidor fecha.
 *
 * ## O custo medido da troca
 *
 * `loadSource` **reposiciona**: medido contra uma live local, trocar a fonte com
 * o vídeo em 7,98 s devolveu 6,01 s. Por isso a posição é restaurada à mão, pelo
 * buffer — ver o comentário no efeito do HLS. O que sobra é um corte curto a
 * cada ~3 min, que é o preço de a concessão ser curta.
 *
 * Se esse corte incomodar em produção, a saída **não** é alongar a concessão: é
 * manter a URL do manifesto estável na sessão e rotacionar só os segmentos.
 * Está descrito em `docs/canais-fase-a.md`, e é decisão de produto, não de
 * implementação.
 */

type Estado =
  | { fase: "pedindo" }
  | { fase: "tocando"; primeiraUrl: string }
  | { fase: "erro"; mensagem: string; podeTentarDeNovo: boolean };

class ErroDeCanal extends Error {
  constructor(mensagem: string, readonly definitivo: boolean) {
    super(mensagem);
  }
}

/**
 * Pede — ou renova — a concessão.
 *
 * `sessionId` presente é renovação: o servidor reaproveita o upstream já
 * resolvido em vez de voltar ao provider. Ausente, ou recusado, é o caminho
 * completo.
 */
async function pedirConcessao(canalId: string, sessionId?: string, concessaoAnuncio?: string | null): Promise<ResultadoDePedido> {
  let r: Response;
  try {
    r = await fetch(`/api/canais/${encodeURIComponent(canalId)}/play`, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify(sessionId ? { sessionId } : concessaoAnuncio ? { concessao: concessaoAnuncio } : {}),
    });
  } catch {
    return { ok: false, definitivo: false };
  }

  if (!r.ok) {
    const corpo = (await r.json().catch(() => ({}))) as { erro?: string; nivelExigido?: string };
    // Mensagens genéricas, por decisão de exposição: o usuário comum não
    // recebe motivo técnico, host, provider nem status do provedor.
    if (r.status === 401) {
      return { ok: false, definitivo: true, mensagem: "Faça login para assistir." };
    }
    if (r.status === 403) {
      return {
        ok: false,
        definitivo: true,
        mensagem: corpo.nivelExigido
          ? `Este canal faz parte do plano ${corpo.nivelExigido}.`
          : "Seu plano não inclui este canal.",
      };
    }
    if (r.status === 404) {
      return { ok: false, definitivo: true, mensagem: "Canal indisponível no momento." };
    }
    // 429 e 5xx: passageiros. O vídeo segue pela concessão atual e tenta de novo.
    return { ok: false, definitivo: false };
  }

  const corpo = (await r.json()) as ConcessaoDeCanal;
  return { ok: true, concessao: corpo };
}

export function PlayerDeCanal({ canal, onFechar, concessaoAnuncio }: { canal: ItemDeCanal; onFechar: () => void; concessaoAnuncio?: string | null }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [estado, setEstado] = useState<Estado>({ fase: "pedindo" });
  const [tentativa, setTentativa] = useState(0);

  /**
   * Como trocar a fonte, publicado pelo efeito do HLS.
   *
   * Vive numa referência porque o handoff é criado uma vez e precisa alcançar a
   * instância de `hls.js` que o outro efeito criou. Enquanto ela não existe, a
   * primeira URL fica em `pendente` e é aplicada assim que o player nasce.
   */
  const trocarRef = useRef<((url: string) => void) | null>(null);
  const pendenteRef = useRef<string | null>(null);

  function aplicar(url: string) {
    if (trocarRef.current) trocarRef.current(url);
    else pendenteRef.current = url;
  }

  // ── Protocolo de concessão e renovação ─────────────────────────────────────
  useEffect(() => {
    setEstado({ fase: "pedindo" });
    trocarRef.current = null;
    pendenteRef.current = null;

    const handoff = criarHandoff({
      canalId: canal.id,
      pedir: (canalId, sessionId) => pedirConcessao(canalId, sessionId, sessionId ? null : concessaoAnuncio),
      trocarFonte: (url) => {
        aplicar(url);
        setEstado((anterior) =>
          anterior.fase === "tocando" ? anterior : { fase: "tocando", primeiraUrl: url },
        );
      },
      aoPerder: (mensagem) => setEstado({ fase: "erro", mensagem, podeTentarDeNovo: false }),
      agenda: {
        agendar: (fn, ms) => window.setTimeout(fn, ms),
        cancelar: (id) => window.clearTimeout(id),
      },
    });

    void handoff.iniciar();
    return () => handoff.parar();
    // `tentativa` recria o handoff inteiro — é o botão "tentar de novo".
  }, [canal.id, concessaoAnuncio, tentativa]);

  // ── HLS ────────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (estado.fase !== "tocando") return;
    const video = videoRef.current;
    if (!video) return;

    let cancelado = false;
    let destruir = () => {};

    // Safari e a WebView do Android tocam HLS nativamente; aí o hls.js só
    // acrescentaria uma camada de buffer sobre algo que já funciona.
    if (video.canPlayType("application/vnd.apple.mpegurl") !== "") {
      trocarRef.current = (url) => {
        video.src = url;
        void video.play().catch(() => {});
      };
      trocarRef.current(pendenteRef.current ?? estado.primeiraUrl);
      pendenteRef.current = null;
    } else {
      void import("hls.js").then(({ default: Hls }) => {
        if (cancelado || !Hls.isSupported()) return;
        const hls = new Hls({
          // Live: começar perto da borda, e não no início do buffer disponível.
          liveSyncDurationCount: 3,
          enableWorker: true,
        });
        hls.attachMedia(video);
        hls.on(Hls.Events.MANIFEST_PARSED, () => void video.play().catch(() => {}));
        hls.on(Hls.Events.ERROR, (_e, dados) => {
          if (!dados.fatal) return;
          // Erro fatal num canal ao vivo costuma ser a fonte caindo. Vira estado
          // de erro com ação manual, e não repetição automática: insistir
          // sozinho contra um canal fora do ar vira tempestade no edge.
          setEstado({
            fase: "erro",
            mensagem: "A transmissão foi interrompida.",
            podeTentarDeNovo: true,
          });
        });

        // **Aqui** o player migra de verdade.
        //
        // `loadSource` **não preserva a posição** — medido, não suposto: numa
        // live local, trocar a fonte com o vídeo em 7,98 s devolveu 6,01 s. O
        // `hls.js` reposiciona pela playlist nova, e o `duration` de uma live é
        // `Infinity`, então nenhuma checagem baseada em `duration` protege.
        //
        // Por isso a posição é restaurada à mão, e a condição é o **buffer**:
        // se o ponto anterior ainda está bufferizado na fonte nova, volta-se a
        // ele; se não está (a janela da live já passou por cima), fica onde o
        // `hls.js` colocou, que é a borda — o certo para uma transmissão.
        trocarRef.current = (url) => {
          const antes = video.currentTime;
          const tocava = !video.paused;

          const restaurar = () => {
            for (let i = 0; i < video.buffered.length; i++) {
              if (antes >= video.buffered.start(i) && antes <= video.buffered.end(i)) {
                if (Math.abs(video.currentTime - antes) > 0.1) video.currentTime = antes;
                break;
              }
            }
            if (tocava) void video.play().catch(() => {});
          };

          hls.loadSource(url);
          // `FRAG_BUFFERED` é quando já há o que restaurar. `MANIFEST_PARSED`
          // cobre o caso de o fragmento já estar em buffer e o evento não vir.
          hls.once(Hls.Events.FRAG_BUFFERED, restaurar);
          hls.once(Hls.Events.MANIFEST_PARSED, () => setTimeout(restaurar, 0));
        };
        trocarRef.current(pendenteRef.current ?? estado.primeiraUrl);
        pendenteRef.current = null;

        destruir = () => hls.destroy();
      });
    }

    return () => {
      cancelado = true;
      trocarRef.current = null;
      destruir();
      video.removeAttribute("src");
      video.load();
    };
    // Só a entrada em "tocando" recria o player. As renovações seguintes passam
    // por `trocarRef`, sem remontar a instância — remontar a cada 3 min seria um
    // corte muito maior do que um `loadSource`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [estado.fase]);

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
