"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import { signIn } from "next-auth/react";
import { useSearchParams } from "next/navigation";
import { callbackDesktopSeguro, validarDesafioPkce, validarEstadoDesktop } from "@/lib/desktopAuth";

function DesktopAuthConteudo() {
  const query = useSearchParams();
  const iniciou = useRef(false);
  const [erro, setErro] = useState("");

  useEffect(() => {
    if (iniciou.current) return;
    iniciou.current = true;

    const challenge = query.get("challenge");
    const state = query.get("state");
    const callbackUrl = callbackDesktopSeguro(query.get("callbackUrl"));

    if (!validarDesafioPkce(challenge) || !validarEstadoDesktop(state)) {
      setErro("Solicitação de login inválida. Volte ao aplicativo e tente novamente.");
      return;
    }

    const complete = new URLSearchParams({ challenge, state, callbackUrl });
    signIn("google", { callbackUrl: `/api/desktop-auth/complete?${complete.toString()}` })
      .catch(() => setErro("Não foi possível iniciar o login com Google."));
  }, [query]);

  return (
    <main className="min-h-screen bg-zinc-950 px-5 text-white grid place-items-center">
      <div className="w-full max-w-md rounded-2xl border border-white/10 bg-zinc-900 p-8 text-center shadow-2xl">
        <h1 className="text-2xl font-black">Entrar no Obaflix</h1>
        {erro ? (
          <p className="mt-4 text-sm text-red-300">{erro}</p>
        ) : (
          <>
            <p className="mt-4 text-sm text-zinc-300">Abrindo o Google para confirmar sua conta…</p>
            <p className="mt-2 text-xs text-zinc-500">
              Ao concluir, o Windows volta automaticamente ao aplicativo Obaflix.
            </p>
          </>
        )}
      </div>
    </main>
  );
}

export default function DesktopAuthPage() {
  return (
    <Suspense fallback={<main className="min-h-screen bg-zinc-950" aria-hidden="true" />}>
      <DesktopAuthConteudo />
    </Suspense>
  );
}
