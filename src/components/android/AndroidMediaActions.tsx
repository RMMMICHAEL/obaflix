"use client";

import { useCallback, useEffect, useState } from "react";
import { Cast, Check, Download, Loader2, X } from "lucide-react";
import { DownloadQualityModal, type Qualidade } from "./DownloadQualityModal";
import { mensagemDeFalha, pontesDeMidia } from "@/lib/androidMedia";

/**
 * Botões de Baixar e Transmitir do aplicativo Android.
 *
 * ## Por que isto vive no site, e não no Android
 *
 * O aplicativo móvel é uma casca de WebView: `MainActivity` faz
 * `loadUrl(OBAFLIX_URL + "/android")` e toda a interface — hero, grade de
 * episódios, player — é este projeto React. Não existe adapter nativo onde
 * encaixar um botão ao lado do episódio.
 *
 * ## Por que não afeta os outros ambientes
 *
 * Tudo depende de `window.obaflixDesktop.mediaActions`, que só é `true` quando
 * a `MainActivity` do módulo `:app` registra a interface `_obaflixMedia`. No
 * navegador, no Electron e na TV o campo não existe, o componente devolve
 * `null` e nada é desenhado nem requisitado.
 *
 * ## O fluxo tem duas etapas
 *
 * 1. `inspectDownloadSource` — o lado nativo classifica a fonte e, se ela
 *    servir, lê o master HLS e devolve as resoluções reais.
 * 2. `requestDownload` — só depois que a pessoa escolheu no modal.
 *
 * A ordem importa: o modal só aparece para uma fonte que de fato dá para
 * baixar. Uma fonte presa à sessão do navegador é recusada na etapa 1 e o
 * componente tenta a próxima, sem nunca ter mostrado uma tela de escolha que
 * ia falhar no fim.
 */

/** O que um resolvedor devolve: só a mídia, sem identidade do conteúdo. */
export type FonteResolvida = {
  /** Caminho que resolveu a mídia. "superflix" é recusado pelo Android. */
  origem?: string;
  stream?: string;
  tipo?: string;
  referer?: string | null;
  userAgent?: string | null;
  expiresAt?: number | null;
  error?: string;
};

type Resposta = {
  ok: boolean;
  motivo?: string;
  tentarOutraFonte?: boolean;
  podeInstalar?: boolean;
  jaNaFila?: boolean;
  sondagemId?: string;
  qualidades?: Qualidade[];
};

type Ponte = {
  mediaActions?: boolean;
  inspectDownloadSource?: (p: Record<string, unknown>) => Promise<Resposta>;
  requestDownload?: (p: Record<string, unknown>) => Promise<Resposta>;
  discardDownloadSource?: () => void;
  requestCast?: (p: Record<string, unknown>) => Promise<Resposta>;
  installCastApp?: () => void;
};

function ponte(): Ponte | null {
  if (typeof window === "undefined") return null;
  return pontesDeMidia((window as unknown as { obaflixDesktop?: Ponte }).obaflixDesktop);
}

/** Só é verdadeiro dentro do APK móvel. */
export function useAcoesDeMidiaDisponiveis(): boolean {
  const [ativo, setAtivo] = useState(false);
  useEffect(() => {
    // O shim completo é instalado em onPageFinished, que pode acontecer depois
    // do primeiro render. Uma checagem só, na montagem, perderia a janela.
    if (ponte()) {
      setAtivo(true);
      return;
    }
    const t = setInterval(() => {
      if (ponte()) {
        setAtivo(true);
        clearInterval(t);
      }
    }, 400);
    const parar = setTimeout(() => clearInterval(t), 8000);
    return () => {
      clearInterval(t);
      clearTimeout(parar);
    };
  }, []);
  return ativo;
}

export type Estado = "ocioso" | "trabalhando" | "ok" | "erro";

/**
 * `hero` — ao lado de Assistir, na página do filme/série/anime.
 * `episodio` — na linha de cada episódio.
 * `player` — dentro da barra de controles.
 */
export type VarianteVisual = "hero" | "episodio" | "player";

export function AndroidMediaActions({
  pid,
  titulo,
  tituloCurto,
  poster,
  resolverFonte,
  variante = "hero",
}: {
  pid: string;
  titulo: string;
  /** Título mostrado no modal. Cai para `titulo` quando ausente. */
  tituloCurto?: string;
  poster?: string | null;
  /**
   * Devolve a próxima fonte já resolvida, ou `null` quando acabaram.
   *
   * Recebe a tentativa (0, 1, 2…) para oferecer outro servidor quando o Android
   * recusa o anterior. Quem resolve é sempre quem já tem a sessão autenticada —
   * este componente nunca fala com provedor.
   */
  resolverFonte: (tentativa: number) => Promise<FonteResolvida | null>;
  variante?: VarianteVisual;
}) {
  const disponivel = useAcoesDeMidiaDisponiveis();
  const [download, setDownload] = useState<Estado>("ocioso");
  const [cast, setCast] = useState<Estado>("ocioso");
  const [aviso, setAviso] = useState<string | null>(null);
  const [modal, setModal] = useState<{ sondagemId: string; qualidades: Qualidade[] } | null>(null);
  const [enviando, setEnviando] = useState(false);

  const falhar = useCallback((setEstado: (e: Estado) => void, motivo?: string) => {
    setEstado("erro");
    setAviso(mensagemDeFalha(motivo));
    setTimeout(() => setEstado("ocioso"), 3500);
  }, []);

  const concluir = useCallback((setEstado: (e: Estado) => void) => {
    setEstado("ok");
    setAviso(null);
    setTimeout(() => setEstado("ocioso"), 2500);
  }, []);

  // -- Baixar: etapa 1, sondagem -------------------------------------------

  const abrirEscolha = useCallback(async () => {
    const p = ponte();
    if (!p?.inspectDownloadSource) return;
    setDownload("trabalhando");
    setAviso(null);

    // Até três servidores. Além disso a espera incomoda mais do que a chance de
    // sucesso ajuda — e cada tentativa custa uma extração.
    let ultimo: Resposta | null = null;
    for (let tentativa = 0; tentativa < 3; tentativa++) {
      let fonte: FonteResolvida | null = null;
      try {
        fonte = await resolverFonte(tentativa);
      } catch {
        fonte = null;
      }
      if (!fonte) break;

      const r = await p
        .inspectDownloadSource({ ...fonte, pid, titulo })
        .catch(() => ({ ok: false }) as Resposta);
      ultimo = r;

      if (r.ok) {
        if (r.jaNaFila) {
          setAviso("Já está na fila");
          concluir(setDownload);
          return;
        }
        if (r.sondagemId && r.qualidades?.length) {
          setModal({ sondagemId: r.sondagemId, qualidades: r.qualidades });
          setDownload("ocioso");
          return;
        }
        break;
      }
      // Só insiste quando o Android disse que outra fonte pode servir.
      if (!r.tentarOutraFonte) break;
    }
    falhar(setDownload, ultimo?.motivo);
  }, [pid, titulo, resolverFonte, concluir, falhar]);

  // -- Baixar: etapa 2, escolha ---------------------------------------------

  const escolherQualidade = useCallback(
    async (q: Qualidade) => {
      const p = ponte();
      if (!p?.requestDownload || !modal) return;
      setEnviando(true);
      const r = await p
        .requestDownload({ sondagemId: modal.sondagemId, qualidadeId: q.id })
        .catch(() => ({ ok: false }) as Resposta);
      setEnviando(false);
      setModal(null);
      if (r.ok) concluir(setDownload);
      else falhar(setDownload, r.motivo);
    },
    [modal, concluir, falhar],
  );

  /** Fechar o modal não inicia nada e solta a fonte da memória do lado nativo. */
  const fecharModal = useCallback(() => {
    ponte()?.discardDownloadSource?.();
    setModal(null);
    setEnviando(false);
    setDownload("ocioso");
  }, []);

  // -- Transmitir ------------------------------------------------------------

  const transmitir = useCallback(async () => {
    const p = ponte();
    if (!p?.requestCast) return;
    setCast("trabalhando");
    setAviso(null);

    let ultimo: Resposta | null = null;
    for (let tentativa = 0; tentativa < 3; tentativa++) {
      let fonte: FonteResolvida | null = null;
      try {
        fonte = await resolverFonte(tentativa);
      } catch {
        fonte = null;
      }
      if (!fonte) break;

      const r = await p
        .requestCast({ ...fonte, pid, titulo, poster: poster ?? null })
        .catch(() => ({ ok: false }) as Resposta);
      ultimo = r;
      if (r.ok) {
        concluir(setCast);
        return;
      }
      if (!r.tentarOutraFonte) break;
    }
    if (ultimo?.podeInstalar) ponte()?.installCastApp?.();
    falhar(setCast, ultimo?.motivo);
  }, [pid, titulo, poster, resolverFonte, concluir, falhar]);

  if (!disponivel) return null;

  return (
    <>
      <div className={grupoClasse(variante)}>
        <AcaoBotao
          variante={variante}
          estado={download}
          Icone={Download}
          rotulo="Baixar"
          onClick={abrirEscolha}
        />
        <AcaoBotao
          variante={variante}
          estado={cast}
          Icone={Cast}
          rotulo="Transmitir"
          onClick={transmitir}
        />
        {aviso && (
          <span
            role="status"
            className={
              variante === "player"
                ? "hidden max-w-[180px] text-[11px] leading-tight text-white/70 md:inline"
                : "text-xs leading-tight text-zinc-400"
            }
          >
            {aviso}
          </span>
        )}
      </div>

      {modal && (
        <DownloadQualityModal
          titulo={tituloCurto || titulo}
          qualidades={modal.qualidades}
          ocupado={enviando}
          onEscolher={escolherQualidade}
          onFechar={fecharModal}
        />
      )}
    </>
  );
}

export function grupoClasse(variante: VarianteVisual): string {
  if (variante === "player") return "flex items-center gap-1.5";
  if (variante === "episodio") return "flex flex-wrap items-center gap-2";
  return "flex flex-wrap items-center gap-2.5";
}

/**
 * Um botão de ação.
 *
 * As três variantes usam o vocabulário visual que já existe em cada lugar: o
 * `hero` copia as proporções do botão de trailer (`h-12`/`rounded-xl`), o
 * `player` copia o botão "Servidor" da barra de controles (`rounded-full`,
 * inverte para branco no hover) e o `episodio` é a versão compacta, ainda com
 * 40px de altura para não ficar abaixo do alvo de toque confortável.
 *
 * No `player` o rótulo some abaixo de `md`: a barra superior é estreita no
 * celular e três rótulos brigariam com o seletor de servidor. O `aria-label`
 * continua completo, então o leitor de tela nunca vê só um ícone.
 */
export function AcaoBotao({
  variante,
  estado,
  Icone,
  rotulo,
  onClick,
  desabilitado = false,
}: {
  variante: VarianteVisual;
  estado: Estado;
  Icone: typeof Download;
  rotulo: string;
  onClick: () => void;
  /** Não há mídia para agir. Distinto de "ocupado": não vira clicável depois. */
  desabilitado?: boolean;
}) {
  const ocupado = estado === "trabalhando";
  const inerte = ocupado || desabilitado;

  const base =
    "inline-flex shrink-0 items-center justify-center gap-2 font-semibold transition-colors duration-200 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white/70 active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-60";

  const porVariante: Record<VarianteVisual, string> = {
    hero:
      "h-12 rounded-xl border border-white/15 bg-white/10 px-6 text-[15px] text-white backdrop-blur-sm hover:border-white/30 hover:bg-white/20 md:h-[3.25rem]",
    episodio:
      "h-10 rounded-lg border border-white/10 bg-white/[0.06] px-3.5 text-[13px] text-zinc-200 hover:border-white/25 hover:bg-white/[0.14]",
    player:
      "h-10 rounded-full bg-white/10 px-3 text-xs text-white hover:bg-white hover:text-black md:h-12 md:px-4 md:text-sm",
  };

  const tamanhoIcone = variante === "episodio" ? 17 : 19;

  return (
    <button
      type="button"
      onClick={(e) => {
        // O botão pode estar dentro de um cartão clicável. Baixar e transmitir
        // nunca podem navegar: navegar é intenção de assistir, que é
        // exatamente o que estas ações não significam.
        e.preventDefault();
        e.stopPropagation();
        if (inerte) return;
        onClick();
      }}
      disabled={inerte}
      aria-busy={ocupado}
      aria-label={rotulo}
      title={rotulo}
      className={`${base} ${porVariante[variante]}`}
    >
      {estado === "trabalhando" ? (
        <Loader2 size={tamanhoIcone} className="animate-spin" />
      ) : estado === "ok" ? (
        <Check size={tamanhoIcone} className="text-emerald-400" strokeWidth={2.4} />
      ) : estado === "erro" ? (
        <X size={tamanhoIcone} className="text-red-400" strokeWidth={2.4} />
      ) : (
        <Icone size={tamanhoIcone} strokeWidth={2} />
      )}
      <span className={variante === "player" ? "hidden md:inline" : undefined}>{rotulo}</span>
    </button>
  );
}
