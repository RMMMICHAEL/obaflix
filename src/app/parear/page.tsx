"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import { useSession } from "next-auth/react";
import { useRouter, useSearchParams } from "next/navigation";

/**
 * O lado do celular no pareamento da TV.
 *
 * A pessoa chega aqui de duas formas: lendo o QR Code da televisão, que já traz
 * o código na URL, ou digitando os oito caracteres quando a câmera não ajuda.
 * Os dois caminhos terminam na mesma confirmação — não há um segundo fluxo.
 *
 * A confirmação mostra qual aparelho está pedindo e de onde. É essa tela que
 * torna o QR seguro: se alguém fotografou o código da TV de outra pessoa, quem
 * autoriza vê um aparelho que não reconhece e para.
 */

type Aparelho = { modelo: string; rede: string; criadoEm: number };
type Fase = "carregando" | "codigo" | "confirmar" | "pronto";

function ehCodigoCompleto(valor: string): boolean {
  return valor.replace(/[^0-9A-Za-z]/g, "").length === 8;
}

function ConteudoParear() {
  const router = useRouter();
  const { status } = useSession();
  const params = useSearchParams();

  const [codigo, setCodigo] = useState(() => (params.get("c") ?? "").toUpperCase());
  const [fase, setFase] = useState<Fase>("carregando");
  const [aparelho, setAparelho] = useState<Aparelho | null>(null);
  const [erro, setErro] = useState("");
  const [enviando, setEnviando] = useState(false);

  // Sem sessão não há o que aprovar. Volta para cá depois do login, com o
  // código preservado, para a pessoa não ter de ler o QR de novo.
  useEffect(() => {
    if (status !== "unauthenticated") return;
    const destino = codigo ? `/parear?c=${encodeURIComponent(codigo)}` : "/parear";
    router.replace(`/login?callbackUrl=${encodeURIComponent(destino)}`);
  }, [codigo, router, status]);

  const buscarAparelho = useCallback(async (valor: string) => {
    setErro("");
    const limpo = valor.replace(/[^0-9A-Za-z]/g, "").toUpperCase();
    const resposta = await fetch(`/api/tv/pair/approve?c=${encodeURIComponent(limpo)}`, {
      cache: "no-store",
    });
    if (!resposta.ok) {
      setFase("codigo");
      setErro(
        resposta.status === 404
          ? "Esse código expirou ou não existe. Gere um novo na televisão."
          : "Não foi possível verificar o código agora.",
      );
      return;
    }
    setAparelho((await resposta.json()) as Aparelho);
    setFase("confirmar");
  }, []);

  useEffect(() => {
    if (status !== "authenticated") return;
    if (fase !== "carregando") return;
    if (ehCodigoCompleto(codigo)) void buscarAparelho(codigo);
    else setFase("codigo");
  }, [buscarAparelho, codigo, fase, status]);

  async function autorizar() {
    setEnviando(true);
    setErro("");
    const resposta = await fetch("/api/tv/pair/approve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userCode: codigo.replace(/[^0-9A-Za-z]/g, "") }),
    });
    setEnviando(false);

    if (resposta.ok) {
      setFase("pronto");
      return;
    }
    const { erro: motivo } = (await resposta.json().catch(() => ({ erro: "" }))) as { erro?: string };
    setFase("codigo");
    setErro(
      motivo === "ja_usado"
        ? "Esse código já foi usado. Gere um novo na televisão."
        : motivo === "rate_limited" || motivo === "bloqueado"
          ? "Muitas tentativas. Espere alguns minutos e tente de novo."
          : "Esse código expirou. Gere um novo na televisão.",
    );
  }

  if (status === "loading" || status === "unauthenticated") {
    return <div className="min-h-screen bg-zinc-950" aria-label="Verificando sessão" />;
  }

  return (
    <div className="min-h-screen flex items-center justify-center px-4">
      <div className="w-full max-w-sm bg-zinc-900 rounded-xl p-8 shadow-2xl">
        <h1 className="text-2xl font-bold text-white mb-1 text-center">Conectar TV</h1>
        <p className="text-zinc-400 text-sm text-center mb-6">
          {fase === "pronto"
            ? "Tudo certo por aqui."
            : "Confirme o aparelho que está pedindo acesso."}
        </p>

        {fase === "carregando" && (
          <p className="text-zinc-500 text-sm text-center">Verificando…</p>
        )}

        {fase === "codigo" && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (ehCodigoCompleto(codigo)) void buscarAparelho(codigo);
            }}
            className="flex flex-col gap-3"
          >
            <label htmlFor="codigo" className="text-zinc-300 text-sm">
              Digite o código que aparece na televisão
            </label>
            <input
              id="codigo"
              value={codigo}
              onChange={(e) => setCodigo(e.target.value.toUpperCase())}
              placeholder="ABCD-EFGH"
              autoComplete="off"
              autoCapitalize="characters"
              spellCheck={false}
              className="bg-zinc-800 text-white text-center text-lg tracking-[0.3em] px-4 py-3 rounded outline-none focus:ring-2 focus:ring-red-600"
            />
            {erro && <p className="text-red-400 text-xs">{erro}</p>}
            <button
              type="submit"
              disabled={!ehCodigoCompleto(codigo)}
              className="bg-red-600 text-white font-bold py-2.5 rounded hover:bg-red-700 transition disabled:opacity-50"
            >
              Continuar
            </button>
          </form>
        )}

        {fase === "confirmar" && aparelho && (
          <div className="flex flex-col gap-4">
            {/* O que permite reconhecer o aparelho — ou perceber que não é o seu. */}
            <div className="bg-zinc-800 rounded-lg p-4 flex flex-col gap-1">
              <span className="text-white font-semibold">{aparelho.modelo}</span>
              <span className="text-zinc-400 text-xs">Rede {aparelho.rede}</span>
              <span className="text-zinc-400 text-xs">
                Pedido às{" "}
                {new Date(aparelho.criadoEm).toLocaleTimeString("pt-BR", {
                  hour: "2-digit",
                  minute: "2-digit",
                })}
              </span>
            </div>

            <p className="text-zinc-500 text-xs">
              Só autorize se esta for a sua televisão. Ao autorizar, ela entra na sua conta.
            </p>

            {erro && <p className="text-red-400 text-xs">{erro}</p>}

            <button
              onClick={() => void autorizar()}
              disabled={enviando}
              className="bg-red-600 text-white font-bold py-2.5 rounded hover:bg-red-700 transition disabled:opacity-50"
            >
              {enviando ? "Autorizando…" : "Autorizar esta TV"}
            </button>
            <button
              onClick={() => {
                setFase("codigo");
                setAparelho(null);
              }}
              className="text-zinc-400 text-sm hover:text-zinc-200 transition"
            >
              Não é a minha TV
            </button>
          </div>
        )}

        {fase === "pronto" && (
          <div className="flex flex-col gap-4 text-center">
            <p className="text-zinc-300 text-sm">
              A televisão já entrou na sua conta. Pode largar o celular.
            </p>
            <p className="text-zinc-500 text-xs">
              Para desconectar depois, use <span className="text-zinc-300">Minha conta → Dispositivos</span>.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

export default function PaginaParear() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-zinc-950" aria-hidden="true" />}>
      <ConteudoParear />
    </Suspense>
  );
}
