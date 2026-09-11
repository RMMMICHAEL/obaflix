"use client";

import { useCallback, useEffect, useRef, useState } from "react";
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
 * A URL upstream, o provider, o host do CDN, o Referer. Ele recebe do `/play`
 * uma URL de manifesto no domínio de mídia do Obaflix e é só o que existe no
 * estado. Nada é guardado em `localStorage`: a concessão é curta e uma URL
 * persistida seria uma cópia sobrevivendo à sessão que a autorizou.
 *
 * ## A renovação, e por que ela é o ponto
 *
 * A concessão vale poucos minutos. Este componente volta ao `/play` bem antes
 * de vencer, mandando o `sessionId`, e o servidor **reautoriza de verdade**:
 * reconfere sessão, entitlement e rate limit, e rotaciona o nonce — o que
 * derruba na hora toda URL emitida antes, inclusive uma que alguém tivesse
 * capturado dentro da validade.
 *
 * A URL nova **não** é empurrada para o `<video>` em curso. Trocar o `src` de um
 * HLS ao vivo reinicia o buffer e dá um solavanco visível a cada poucos
 * minutos. Ela fica guardada e só entra em uso quando o player precisa de fato
 * recarregar — numa falha, ou na próxima abertura. Quem mantém a reprodução viva
 * é a sessão no Redis, que o edge revalida a cada manifesto.
 */

interface Concessao {
  sessionId: string;
  manifestUrl: string;
  expiraEm: number;
  validoPorSegundos: number;
}

type Estado =
  | { fase: "pedindo" }
  | { fase: "tocando"; concessao: Concessao }
  | { fase: "erro"; mensagem: string; podeTentarDeNovo: boolean };

class ErroDeCanal extends Error {
  constructor(mensagem: string, readonly podeTentarDeNovo: boolean) {
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
async function pedirConcessao(canalId: string, sessionId?: string): Promise<Concessao> {
  const r = await fetch(`/api/canais/${encodeURIComponent(canalId)}/play`, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify(sessionId ? { sessionId } : {}),
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

export function PlayerDeCanal({ canal, onFechar }: { canal: ItemDeCanal; onFechar: () => void }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [estado, setEstado] = useState<Estado>({ fase: "pedindo" });
  const [tentativa, setTentativa] = useState(0);

  /**
   * A concessão mais recente, fora do estado de render.
   *
   * A renovação atualiza esta referência sem recompor: o `useEffect` do HLS
   * depende de `estado`, e mudá-lo a cada renovação recriaria a instância do
   * player e cortaria o vídeo.
   */
  const concessaoRef = useRef<Concessao | null>(null);

  const aplicar = useCallback((c: Concessao) => {
    concessaoRef.current = c;
  }, []);

  // ── Primeira concessão ─────────────────────────────────────────────────────
  useEffect(() => {
    let vivo = true;
    setEstado({ fase: "pedindo" });
    pedirConcessao(canal.id)
      .then((concessao) => {
        if (!vivo) return;
        aplicar(concessao);
        setEstado({ fase: "tocando", concessao });
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
  }, [canal.id, tentativa, aplicar]);

  // ── Reautorização periódica ────────────────────────────────────────────────
  useEffect(() => {
    if (estado.fase !== "tocando") return;
    let vivo = true;
    let timer: ReturnType<typeof setTimeout>;

    const agendar = (validoPorSegundos: number) => {
      // 60% da validade: cedo o bastante para uma falha ainda caber numa
      // segunda tentativa antes de a atual vencer.
      const emMs = Math.max(30, Math.floor(validoPorSegundos * 0.6)) * 1000;
      timer = setTimeout(async () => {
        if (!vivo) return;
        const atual = concessaoRef.current;
        try {
          const nova = await pedirConcessao(canal.id, atual?.sessionId);
          if (!vivo) return;
          aplicar(nova);
          agendar(nova.validoPorSegundos);
        } catch (e) {
          if (!vivo) return;
          // Recusa definitiva (plano caiu, canal saiu do ar) para a reprodução
          // na hora; falha temporária deixa o vídeo seguir com a concessão
          // atual até ela vencer, e aí o erro do HLS assume.
          const erro = e instanceof ErroDeCanal ? e : null;
          if (erro && !erro.podeTentarDeNovo) {
            setEstado({ fase: "erro", mensagem: erro.message, podeTentarDeNovo: false });
          } else {
            agendar(60);
          }
        }
      }, emMs);
    };

    agendar(estado.concessao.validoPorSegundos);
    return () => {
      vivo = false;
      clearTimeout(timer);
    };
  }, [estado, canal.id, aplicar]);

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
          // Erro fatal num canal ao vivo costuma ser a concessão vencida ou a
          // fonte caindo. Vira estado de erro com ação manual, e não repetição
          // automática: insistir sozinho contra um canal fora do ar vira
          // tempestade no edge.
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
    // `estado.concessao.manifestUrl` de propósito, e não `estado`: a renovação
    // não passa por aqui, então o player não é recriado a cada poucos minutos.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [estado.fase, estado.fase === "tocando" ? estado.concessao.manifestUrl : null]);

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
