"use client";

import { useCallback, useEffect, useState } from "react";
import { Download, Cast, Loader2, Check, X } from "lucide-react";

/**
 * Botões de Baixar e Transmitir do aplicativo Android.
 *
 * ## Por que isto vive no site, e não no Android
 *
 * O aplicativo móvel é uma casca de WebView: `MainActivity` faz
 * `loadUrl(OBAFLIX_URL + "/android")` e toda a interface — grade de episódios,
 * player, listas — é este projeto React. Não existe adapter nativo onde
 * encaixar um botão ao lado do episódio.
 *
 * A alternativa seria o Android injetar os botões no DOM por JavaScript, o que
 * amarraria o APK aos nomes de classe desta página e quebraria em silêncio a
 * cada deploy — além de o React remover os nós injetados na reconciliação.
 *
 * ## Por que não afeta os outros ambientes
 *
 * Tudo aqui depende de `window.obaflixDesktop.mediaActions`, que só é `true`
 * quando a `MainActivity` do módulo `:app` registra a interface
 * `_obaflixMedia`. No navegador, no Electron e na TV o objeto não tem esse
 * campo, o componente devolve `null` e nada é desenhado. É o mesmo mecanismo
 * que o `DesktopUpdateBanner` já usa.
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

/** O que atravessa a ponte: a mídia mais quem ela é. */
type Payload = FonteResolvida & {
  pid: string;
  titulo: string;
  poster?: string | null;
};

type Resposta = { ok: boolean; motivo?: string; tentarOutraFonte?: boolean; podeInstalar?: boolean };

type Ponte = {
  mediaActions?: boolean;
  requestDownload?: (p: Payload) => Promise<Resposta>;
  requestCast?: (p: Payload) => Promise<Resposta>;
  installCastApp?: () => void;
};

function ponte(): Ponte | null {
  if (typeof window === "undefined") return null;
  const d = (window as unknown as { obaflixDesktop?: Ponte }).obaflixDesktop;
  return d?.mediaActions ? d : null;
}

/** Só é verdadeiro dentro do APK móvel. */
export function useAcoesDeMidiaDisponiveis(): boolean {
  const [ativo, setAtivo] = useState(false);
  useEffect(() => {
    // O shim completo é instalado em onPageFinished, que pode acontecer depois
    // do primeiro render. Uma checagem só, na montagem, perderia a janela.
    if (ponte()) { setAtivo(true); return; }
    const t = setInterval(() => { if (ponte()) { setAtivo(true); clearInterval(t); } }, 400);
    const parar = setTimeout(() => clearInterval(t), 8000);
    return () => { clearInterval(t); clearTimeout(parar); };
  }, []);
  return ativo;
}

type Estado = "ocioso" | "trabalhando" | "ok" | "erro";

/**
 * Mensagem para o usuário comum.
 *
 * Genérica de propósito: o motivo técnico (`sessao_do_navegador`, `expirada`)
 * fica no log nativo mascarado. Nome de provedor, host e token não aparecem na
 * tela — é a mesma regra que o resto do player já segue.
 */
function mensagem(motivo?: string): string {
  switch (motivo) {
    case "app_ausente": return "Instale o app de transmissão para continuar";
    case "sem_pasta": return "Nenhuma pasta escolhida";
    case "pasta_invalida": return "A pasta escolhida não está mais disponível";
    case "sessao_do_navegador": return "Este servidor não permite baixar";
    case "expirada": return "O link deste servidor expirou. Tente de novo";
    case "indisponivel": return "Indisponível neste aparelho";
    default: return "Não foi possível concluir";
  }
}

export function AndroidMediaActions({
  pid,
  titulo,
  poster,
  resolverFonte,
  compacto = false,
}: {
  pid: string;
  titulo: string;
  poster?: string | null;
  /**
   * Devolve a próxima fonte já resolvida, ou `null` quando acabaram.
   *
   * Recebe a tentativa (0, 1, 2…) para poder oferecer outro servidor quando o
   * Android recusa o anterior. Quem resolve é sempre quem já tem a sessão
   * autenticada — este componente nunca fala com provedor.
   */
  resolverFonte: (tentativa: number) => Promise<FonteResolvida | null>;
  compacto?: boolean;
}) {
  const disponivel = useAcoesDeMidiaDisponiveis();
  const [download, setDownload] = useState<Estado>("ocioso");
  const [cast, setCast] = useState<Estado>("ocioso");
  const [aviso, setAviso] = useState<string | null>(null);

  const executar = useCallback(async (
    acao: "download" | "cast",
    setEstado: (e: Estado) => void,
  ) => {
    const p = ponte();
    if (!p) return;
    setEstado("trabalhando");
    setAviso(null);

    // Até três servidores. Além disso a espera passa a incomodar mais do que a
    // chance de sucesso ajuda — e cada tentativa custa uma extração.
    const MAX = 3;
    let ultimo: Resposta | null = null;

    for (let tentativa = 0; tentativa < MAX; tentativa++) {
      let fonte: FonteResolvida | null = null;
      try {
        fonte = await resolverFonte(tentativa);
      } catch {
        fonte = null;
      }
      if (!fonte) break;

      const payload: Payload = { ...fonte, pid, titulo, poster: poster ?? null };
      const chamada = acao === "download" ? p.requestDownload : p.requestCast;
      if (!chamada) break;

      const r = await chamada(payload).catch(() => ({ ok: false } as Resposta));
      ultimo = r;
      if (r.ok) {
        setEstado("ok");
        setTimeout(() => setEstado("ocioso"), 2500);
        return;
      }
      // Só insiste quando o Android disse que outra fonte pode servir. Recusa
      // por pasta ou por app ausente não melhora tentando outro servidor.
      if (!r.tentarOutraFonte) break;
    }

    setEstado("erro");
    setAviso(mensagem(ultimo?.motivo));
    if (ultimo?.podeInstalar) p.installCastApp?.();
    setTimeout(() => setEstado("ocioso"), 3500);
  }, [pid, titulo, poster, resolverFonte]);

  if (!disponivel) return null;

  const tamanho = compacto ? 16 : 18;
  const base = compacto
    ? "p-1.5 rounded-md text-white/70 hover:text-white hover:bg-white/10 transition-colors"
    : "p-2 rounded-lg text-white/80 hover:text-white hover:bg-white/10 transition-colors";

  const icone = (estado: Estado, Padrao: typeof Download) => {
    if (estado === "trabalhando") return <Loader2 size={tamanho} className="animate-spin" />;
    if (estado === "ok") return <Check size={tamanho} className="text-emerald-400" />;
    if (estado === "erro") return <X size={tamanho} className="text-red-400" />;
    return <Padrao size={tamanho} />;
  };

  return (
    <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
      <button
        type="button"
        className={base}
        aria-label={`Baixar ${titulo}`}
        title="Baixar"
        disabled={download === "trabalhando"}
        onClick={(e) => {
          // O botão vive dentro de um link para a página de reprodução. Sem
          // isto, baixar também navegaria — e navegar é intenção de assistir,
          // que é justamente o que baixar não pode significar.
          e.preventDefault();
          e.stopPropagation();
          void executar("download", setDownload);
        }}
      >
        {icone(download, Download)}
      </button>

      <button
        type="button"
        className={base}
        aria-label={`Transmitir ${titulo}`}
        title="Transmitir"
        disabled={cast === "trabalhando"}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          void executar("cast", setCast);
        }}
      >
        {icone(cast, Cast)}
      </button>

      {aviso && (
        <span className="text-[11px] text-white/60 max-w-[160px] leading-tight">{aviso}</span>
      )}
    </div>
  );
}
