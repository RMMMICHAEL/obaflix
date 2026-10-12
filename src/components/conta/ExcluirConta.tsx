"use client";

import { signOut } from "next-auth/react";
import { useState } from "react";
import { CONFIRMACAO_ESPERADA } from "@/lib/account/deletion";

/**
 * O fluxo de exclusão de conta, em dois passos e reutilizável.
 *
 * O mesmo componente serve `/conta` (usuário já logado) e a página pública
 * `/excluir-conta` (depois de entrar). O primeiro clique revela o passo de
 * confirmação; o botão final só liga quando a pessoa digita a palavra exata.
 * Em caso de sucesso, encerra a sessão e volta para `/login` — o JWT antigo não
 * tem mais conta por trás. O erro é neutro: nunca expõe FK, tabela ou motivo.
 *
 * Chama o mesmo `DELETE /api/user/account` do resto do projeto; a requisição é
 * de mesma origem, então leva o cookie e um `Origin` que casa com o `Host`.
 */
export function ExcluirConta() {
  const [etapa, setEtapa] = useState<"inicio" | "confirmar">("inicio");
  const [valor, setValor] = useState("");
  const [enviando, setEnviando] = useState(false);
  const [erro, setErro] = useState("");

  const pronto = valor === CONFIRMACAO_ESPERADA;

  async function excluir() {
    if (!pronto || enviando) return;
    setEnviando(true);
    setErro("");
    try {
      const res = await fetch("/api/user/account", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirmacao: CONFIRMACAO_ESPERADA }),
      });
      if (res.ok) {
        await signOut({ callbackUrl: "/login" });
        return;
      }
      setErro("Não foi possível excluir a conta agora. Tente novamente mais tarde.");
    } catch {
      setErro("Não foi possível excluir a conta agora. Tente novamente mais tarde.");
    } finally {
      setEnviando(false);
    }
  }

  return (
    <div className="rounded-xl border border-red-900/60 bg-red-950/20 p-5">
      <h2 className="text-lg font-semibold text-white">Excluir conta</h2>
      <p className="mt-1 text-sm text-zinc-400">
        A exclusão remove sua conta e os dados pessoais associados — histórico,
        minha lista, curtidas, dispositivos de TV e assinatura. Esta ação é
        permanente e não pode ser desfeita.
      </p>

      {etapa === "inicio" ? (
        <button
          type="button"
          onClick={() => {
            setErro("");
            setEtapa("confirmar");
          }}
          className="mt-4 rounded-lg border border-red-700 px-4 py-2 text-sm font-semibold text-red-300 hover:bg-red-900/30"
        >
          Excluir minha conta
        </button>
      ) : (
        <div className="mt-4">
          <label htmlFor="confirmar-exclusao" className="block text-sm text-zinc-300">
            Para confirmar, digite <span className="font-bold text-white">{CONFIRMACAO_ESPERADA}</span>:
          </label>
          <input
            id="confirmar-exclusao"
            type="text"
            value={valor}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="characters"
            spellCheck={false}
            onChange={(e) => setValor(e.target.value)}
            className="mt-2 w-full max-w-xs rounded bg-zinc-800 px-3 py-2 text-sm text-white outline-none focus:ring-2 focus:ring-red-600"
          />
          {erro && <p className="mt-3 text-sm text-red-400">{erro}</p>}
          <div className="mt-4 flex gap-3">
            <button
              type="button"
              disabled={!pronto || enviando}
              onClick={excluir}
              className="rounded-lg bg-red-600 px-4 py-2 text-sm font-bold text-white hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {enviando ? "Excluindo..." : "Excluir definitivamente"}
            </button>
            <button
              type="button"
              disabled={enviando}
              onClick={() => {
                setValor("");
                setErro("");
                setEtapa("inicio");
              }}
              className="rounded-lg border border-zinc-700 px-4 py-2 text-sm font-semibold text-zinc-200 hover:bg-zinc-800 disabled:opacity-50"
            >
              Cancelar
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
