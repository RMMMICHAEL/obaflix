"use client";

import { useCallback, useEffect, useState } from "react";
import { Cast, Check, Download, Loader2, X } from "lucide-react";
import { DownloadQualityModal, type Qualidade } from "./DownloadQualityModal";
import { CastAppModal } from "./CastAppModal";
import { ModalDeAnuncio, useAnuncio } from "@/components/player/useAnuncio";
import { AcaoInterrompida, liberarAcao } from "@/lib/ads/acaoPatrocinada";
import {
  alvoDoPid,
  linhaDiagDownload,
  mensagemDeFalha,
  pontesDeMidia,
  procurarFonteDeDownload,
} from "@/lib/androidMedia";
import {
  corridaComPrazo,
  PRAZO_CAST_MS,
  transmitirComCast,
  type RespostaDeCast,
} from "@/lib/androidCast";

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
 * ## Ações patrocinadas
 *
 * Baixar e transmitir passam pelo mesmo fluxo de anúncio da reprodução, com a
 * finalidade explícita. Quem decide é o servidor: assinante segue direto; conta
 * sujeita a anúncio vê o convite e, concluído o anúncio, a ação continua sozinha
 * — sem clique extra. A concessão é consumida no servidor, pela rota que entrega
 * a fonte, antes de qualquer mídia sair. Fechar o convite no X ou ir assinar um
 * plano volta o botão ao estado anterior, sem mensagem de erro.
 *
 * ## O download tem duas etapas
 *
 * 1. `inspectDownloadSource` — o lado nativo classifica a fonte e, se ela
 *    servir, devolve as qualidades reais.
 * 2. `requestDownload` — só depois que a pessoa escolheu no modal.
 *
 * A ordem importa: o modal de qualidade só aparece para uma fonte que de fato dá
 * para baixar. Assistir ao anúncio não transforma HLS em arquivo único: sem fonte
 * direta, a resposta continua "Download indisponível para este título".
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

/** Para que a fonte vai servir. A reprodução não passa por este componente. */
export type FinalidadeDeMidia = "download" | "transmissao";

/**
 * Pede ao servidor a liberação de uma ação — e o anúncio, se a conta estiver
 * sujeita. Devolve o id que a rota da ação consome, ou `null` para quem não
 * precisa. Lança `AcaoCancelada` ou `AcaoInterrompida`.
 */
export type LiberarAcao = (finalidade: FinalidadeDeMidia) => Promise<string | null>;

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
  /**
   * O Web Video Cast está instalado? Consulta barata, feita antes de pedir
   * anúncio ou resolver fonte. Pode ser síncrona ou Promise, conforme a ponte;
   * ausente nas versões antigas — aí o fluxo normal (que rechecа no nativo) cobre.
   */
  isCastAppInstalled?: () => boolean | Promise<boolean>;
  /** Abre a ficha na loja. Devolve `{ ok }` (loja abriu ou não). */
  installCastApp?: () => void | Promise<RespostaDeCast | void>;
};

/**
 * O app externo de transmissão está instalado?
 *
 * Sem a ponte de checagem (versão antiga do app, ou falha na consulta) devolve
 * `true`: não bloqueia a transmissão — o próprio `requestCast` recheca no nativo
 * e ainda oferece a instalação. Bloquear por não conseguir perguntar seria pior
 * que o comportamento anterior.
 */
async function castAppInstalado(p: Ponte): Promise<boolean> {
  if (!p.isCastAppInstalled) return true;
  try {
    return !!(await Promise.resolve(p.isCastAppInstalled()));
  } catch {
    return true;
  }
}

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
   * Devolve a próxima fonte já resolvida para esta ação, ou `null` quando
   * acabaram.
   *
   * Recebe a tentativa (0, 1, 2…) para oferecer outro servidor quando o Android
   * recusa o anterior, a finalidade, e a porta de liberação — quem resolve é quem
   * abre a sessão, e é lá que a liberação é consumida pelo servidor. Este
   * componente nunca fala com provedor.
   */
  resolverFonte: (
    tentativa: number,
    finalidade: FinalidadeDeMidia,
    liberar: LiberarAcao,
  ) => Promise<FonteResolvida | null>;
  variante?: VarianteVisual;
}) {
  const disponivel = useAcoesDeMidiaDisponiveis();
  const anuncio = useAnuncio();
  const portasDeAnuncio = anuncio.portas;
  const [download, setDownload] = useState<Estado>("ocioso");
  const [cast, setCast] = useState<Estado>("ocioso");
  const [aviso, setAviso] = useState<string | null>(null);
  const [modal, setModal] = useState<{ sondagemId: string; qualidades: Qualidade[] } | null>(null);
  const [enviando, setEnviando] = useState(false);
  /** Modal "Aplicativo necessário". `null` fechado; `erro`/`ocupado` são o estado dele. */
  const [castModal, setCastModal] = useState<{ erro?: string | null; ocupado?: boolean } | null>(null);

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

  /**
   * A liberação desta ação, pelo mesmo fluxo da reprodução.
   *
   * O conteúdo sai do `pid`, que já identifica filme ou episódio sem carregar
   * nada da fonte. O cliente não decide nada: pergunta com a finalidade, mostra
   * o convite se o servidor exigir e devolve o id que o servidor emitiu.
   */
  const liberar = useCallback<LiberarAcao>(
    async (finalidade) => {
      const alvo = alvoDoPid(pid);
      if (!alvo) throw new AcaoInterrompida("acao_nao_liberada");
      return liberarAcao(
        {
          conteudoId: alvo.conteudoId,
          conteudoTipo: alvo.tipo,
          temporada: alvo.tipo === "serie" ? alvo.temporada : null,
          numeroEp: alvo.tipo === "serie" ? alvo.numeroEp : null,
          plataforma: "android",
          finalidade,
        },
        portasDeAnuncio,
      );
    },
    [pid, portasDeAnuncio],
  );

  // -- Baixar: etapa 1, sondagem -------------------------------------------

  const abrirEscolha = useCallback(async () => {
    const p = ponte();
    if (!p?.inspectDownloadSource) return;
    setDownload("trabalhando");
    setAviso(null);

    // Arquivo direto primeiro: um HLS atual não vence um MP4 disponível em
    // outro servidor, e HLS não vira download enquanto não houver remux seguro
    // para um arquivo único. A regra e os testes vivem em procurarFonteDeDownload.
    const inspecionar = p.inspectDownloadSource;
    const resultado = await procurarFonteDeDownload<FonteResolvida, Resposta>({
      resolverFonte: (tentativa) => resolverFonte(tentativa, "download", liberar),
      sondar: (fonte) => inspecionar({ ...fonte, pid, titulo }),
      // Diagnóstico por tentativa (mídia, caminho, servidor genérico, motivo)
      // no canal [diag/etapa], que chega ao logcat do APK. Sem URL nem token.
      registrar: (evento) => console.warn(linhaDiagDownload(evento)),
    });

    if (!resultado.ok) {
      // Fechar o convite ou ir assinar não é erro: o botão só volta ao estado anterior.
      if (resultado.motivo === "cancelado") {
        setDownload("ocioso");
        return;
      }
      falhar(setDownload, resultado.motivo);
      return;
    }
    const r = resultado.resposta;
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
    falhar(setDownload, r.motivo);
  }, [pid, titulo, resolverFonte, liberar, concluir, falhar]);

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

  /**
   * A transmissão em si, uma vez que o app externo já foi confirmado.
   *
   * A decisão inteira vive em `transmitirComCast` (pura, testável): verifica o
   * app antes de qualquer anúncio, tenta até três servidores sem reabrir o
   * anúncio, e estoura o prazo de cada etapa em vez de girar para sempre. Aqui
   * só se traduz o resultado para a interface.
   */
  const executarTransmissao = useCallback(async () => {
    const p = ponte();
    if (!p?.requestCast) return;
    const requestCast = p.requestCast;
    setCast("trabalhando");
    setAviso(null);

    const resultado = await transmitirComCast({
      appInstalado: () => castAppInstalado(p),
      resolverFonte: (tentativa) => resolverFonte(tentativa, "transmissao", liberar),
      // Prazo do cast: uma entrega presa (nativo sem responder) não segura o botão.
      requestCast: (fonte) =>
        corridaComPrazo(
          requestCast({ ...fonte, pid, titulo, poster: poster ?? null }),
          PRAZO_CAST_MS,
          "cast",
        ) as Promise<RespostaDeCast>,
    });

    switch (resultado.tipo) {
      case "precisa_app":
        // Nenhum anúncio foi pedido nem fonte resolvida: só o convite ao app.
        setCast("ocioso");
        setCastModal({});
        return;
      case "ok":
        concluir(setCast);
        return;
      case "cancelado":
        // Fechar o convite ou ir assinar: volta ao estado anterior, sem mensagem.
        setCast("ocioso");
        return;
      case "erro":
        // Caso raro: o app sumiu entre a checagem e a entrega. Oferece instalar.
        if (resultado.podeInstalar) {
          setCast("ocioso");
          setCastModal({});
          return;
        }
        falhar(setCast, resultado.motivo);
        return;
    }
  }, [pid, titulo, poster, resolverFonte, liberar, concluir, falhar]);

  /** O toque no botão "Transmitir" — o mesmo em hero, episódio e player. */
  const transmitir = executarTransmissao;

  // -- Modal "Aplicativo necessário" ----------------------------------------

  /** "Baixar aplicativo": leva à loja e mantém o modal aberto para o retorno. */
  const baixarAppDeCast = useCallback(async () => {
    const p = ponte();
    if (!p?.installCastApp) return;
    setCastModal((m) => (m ? { ...m, erro: undefined, ocupado: true } : m));
    let abriu = true;
    try {
      const r = await Promise.resolve(p.installCastApp());
      // Ponte antiga devolvia void; só um `ok:false` explícito conta como falha.
      abriu = !(r && typeof r === "object" && (r as RespostaDeCast).ok === false);
    } catch {
      abriu = false;
    }
    setCastModal((m) =>
      m
        ? {
            ocupado: false,
            erro: abriu
              ? undefined
              : "Não foi possível abrir a loja. Procure por Web Video Cast na Play Store.",
          }
        : m,
    );
  }, []);

  /** "Transmitir" dentro do modal: recheca e, se instalado, segue o fluxo. */
  const transmitirDoModal = useCallback(async () => {
    const p = ponte();
    if (!p) return;
    if (!(await castAppInstalado(p))) {
      setCastModal({
        erro: "Ainda não encontramos o app. Conclua a instalação e toque em Transmitir.",
      });
      return;
    }
    setCastModal(null);
    await executarTransmissao();
  }, [executarTransmissao]);

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

      <ModalDeAnuncio
        estado={anuncio.modal}
        aoConfirmar={anuncio.aoConfirmar}
        aoFechar={anuncio.aoFechar}
        aoAssinar={anuncio.aoAssinar}
      />

      {modal && (
        <DownloadQualityModal
          titulo={tituloCurto || titulo}
          qualidades={modal.qualidades}
          ocupado={enviando}
          onEscolher={escolherQualidade}
          onFechar={fecharModal}
        />
      )}

      {castModal && (
        <CastAppModal
          erro={castModal.erro}
          ocupado={castModal.ocupado}
          onBaixar={baixarAppDeCast}
          onTransmitir={transmitirDoModal}
          onFechar={() => setCastModal(null)}
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
