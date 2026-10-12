"use client";

import { signIn, useSession } from "next-auth/react";
import { ExcluirConta } from "@/components/conta/ExcluirConta";

/**
 * Página pública de exclusão de conta.
 *
 * Existe porque a loja exige um caminho para excluir a conta alcançável fora do
 * aplicativo — sem precisar ter o app instalado. Funciona igual para navegador,
 * APK direto e Play.
 *
 * Sem sessão: explica e manda entrar, voltando para esta mesma página (o
 * `callbackUrl` só aceita caminho relativo em `/login`). Com sessão: usa o
 * mesmo fluxo real de `/conta` — não há formulário de suporte, pedido de e-mail
 * nem exigência de ter o app. O DELETE verdadeiro continua sendo o servidor.
 */
export default function ExcluirContaPage() {
  const { status } = useSession();

  return (
    <div className="pt-20 px-4 md:px-8 pb-16 min-h-screen flex justify-center">
      <div className="w-full max-w-lg">
        <p className="text-red-500 text-xs font-bold uppercase tracking-[0.18em] mb-2">Obaflix</p>
        <h1 className="text-2xl font-bold text-white mb-2">Excluir conta</h1>
        <p className="text-sm text-zinc-400 mb-8">
          Esta página encerra sua conta Obaflix e remove os dados pessoais
          associados a ela. A ação é permanente e não pode ser desfeita.
        </p>

        {status === "loading" && (
          <div className="h-24 rounded-xl border border-zinc-800 bg-zinc-900/50" aria-label="Verificando sessão" />
        )}

        {status === "unauthenticated" && (
          <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-5">
            <p className="text-sm text-zinc-300">
              Para excluir sua conta, entre com ela primeiro. Depois de entrar,
              você volta para esta página e conclui a exclusão.
            </p>
            <button
              type="button"
              onClick={() => signIn(undefined, { callbackUrl: "/excluir-conta" })}
              className="mt-4 rounded-lg bg-red-600 px-4 py-2 text-sm font-semibold text-white hover:bg-red-700"
            >
              Entrar para excluir minha conta
            </button>
          </div>
        )}

        {status === "authenticated" && <ExcluirConta />}
      </div>
    </div>
  );
}
