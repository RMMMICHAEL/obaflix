"use client";

import { useState } from "react";
import { signIn } from "next-auth/react";

const MENSAGENS: Record<string, string> = {
  senha_incorreta: "Senha incorreta.",
  ja_vinculada: "Esta conta já tem um Google vinculado.",
  sem_senha: "Esta conta entra pelo Google e não tem senha para confirmar.",
};

/** Vincula um Google à conta atual depois de confirmar a senha atual (fecha o pré-sequestro por igualdade de e-mail). */
export function VincularGoogle() {
  const [senha, setSenha] = useState("");
  const [erro, setErro] = useState("");
  const [enviando, setEnviando] = useState(false);

  async function vincular(e: React.FormEvent) {
    e.preventDefault();
    setErro("");
    setEnviando(true);
    try {
      const res = await fetch("/api/auth/google-link", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ senha }),
      });
      if (!res.ok) {
        const corpo = await res.json().catch(() => ({}));
        setErro(MENSAGENS[corpo?.codigo] ?? corpo?.error ?? "Não foi possível iniciar o vínculo.");
        setEnviando(false);
        return;
      }
      setSenha("");
      await signIn("google", { callbackUrl: "/conta" });
    } catch {
      setErro("Não foi possível iniciar o vínculo. Tente novamente.");
      setEnviando(false);
    }
  }

  return (
    <section className="mb-10 rounded-xl border border-zinc-800 bg-zinc-900 p-5">
      <h2 className="text-lg font-semibold text-white">Vincular conta Google</h2>
      <p className="mt-1 text-sm text-zinc-400">Confirme sua senha atual para entrar também com o Google, mantendo esta mesma conta.</p>
      <form onSubmit={vincular} className="mt-3 flex flex-col gap-2 sm:flex-row">
        <input
          type="password"
          value={senha}
          onChange={(e) => setSenha(e.target.value)}
          autoComplete="current-password"
          placeholder="Senha atual"
          required
          maxLength={128}
          className="flex-1 rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-white"
        />
        <button
          type="submit"
          disabled={enviando || senha.length === 0}
          className="rounded-lg bg-red-600 px-4 py-2 text-sm font-semibold text-white hover:bg-red-700 disabled:opacity-50"
        >
          {enviando ? "Abrindo…" : "Vincular Google"}
        </button>
      </form>
      {erro && <p role="alert" className="mt-2 text-sm text-red-400">{erro}</p>}
    </section>
  );
}
