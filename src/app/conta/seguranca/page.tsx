"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { getCsrfToken, signIn, useSession } from "next-auth/react";
import { useRouter } from "next/navigation";

export default function AccountSecurityPage() {
  const { data: session, status } = useSession();
  const router = useRouter();
  const [linked, setLinked] = useState<boolean | null>(null);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  useEffect(() => {
    if (status === "unauthenticated") router.replace("/login?callbackUrl=/conta/seguranca");
    if (status !== "authenticated") return;
    let active = true;
    fetch("/api/account/google", { cache: "no-store" }).then(async response => {
      if (!active) return;
      if (!response.ok) { setMessage("Confirme sua senha para gerenciar o vínculo."); return; }
      const result = await response.json();
      if (active) setLinked(result.linked === true);
    }).catch(() => { if (active) setMessage("Não foi possível verificar o vínculo."); });
    const result = new URLSearchParams(window.location.search).get("google");
    if (result) {
      setMessage(result === "linked" ? "Google vinculado à sua conta." : "Não foi possível vincular o Google. Tente novamente.");
      window.history.replaceState(null, "", "/conta/seguranca");
    }
    return () => { active = false; };
  }, [status, router]);

  async function manage(operation: "link" | "unlink") {
    if (!password || !session?.user?.email || busy) return;
    setBusy(true);
    setMessage("");
    try {
      // Fresh credentials login assigns a server-generated private session sid,
      // including for old JWTs. The mutation also verifies the current password.
      const login = await signIn("credentials", { email: session.user.email, senha: password, redirect: false });
      if (!login?.ok) throw new Error();
      const stateResponse = await fetch("/api/account/google", { cache: "no-store" });
      if (!stateResponse.ok) throw new Error();
      const state = await stateResponse.json();
      setLinked(state.linked === true);
      if (linked === null) { setMessage("Conta confirmada. Escolha a ação desejada."); return; }
      const response = await fetch(`/api/account/google/${operation === "link" ? "link-intents" : "unlink"}`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ senha: password, csrfToken: await getCsrfToken() }),
      });
      if (!response.ok) throw new Error();
      if (operation === "link") await signIn("google-link", { callbackUrl: "/conta/seguranca" });
      else {
        window.location.replace("/login");
      }
    } catch { setMessage("Não foi possível concluir. Confira sua senha e tente novamente."); }
    finally { setPassword(""); setBusy(false); }
  }

  if (status !== "authenticated") return <div className="pt-24 px-4" role="status">Verificando sessão…</div>;
  return (
    <main className="pt-24 px-4 pb-12 max-w-lg mx-auto">
      <Link href="/conta" className="text-sm text-zinc-400 hover:text-white">Voltar à conta</Link>
      <section className="mt-5 rounded-xl bg-zinc-900 p-6">
        <h1 className="text-xl font-bold text-white">Segurança da conta</h1>
        <p className="mt-4 text-zinc-300">{linked === null ? "Confirme a conta para verificar o vínculo." : linked ? "Google vinculado" : "Google não vinculado"}</p>
        <p className="mt-2 text-sm text-zinc-400">Confirme sua senha Obaflix para gerenciar o Google. Seus dados e assinatura permanecem nesta conta.</p>
        {linked && <p className="mt-2 text-sm text-zinc-400">Ao desvincular, suas sessões serão encerradas. Você poderá entrar novamente com email e senha.</p>}
        <form className="mt-5 flex flex-col gap-3" onSubmit={event => { event.preventDefault(); void manage(linked ? "unlink" : "link"); }}>
          <label htmlFor="current-password" className="text-sm text-zinc-300">Senha atual</label>
          <input id="current-password" type="password" autoComplete="current-password" required maxLength={128}
            value={password} onChange={event => setPassword(event.target.value)} disabled={busy}
            className="rounded bg-zinc-800 px-3 py-2 text-white focus:outline-none focus:ring-2 focus:ring-red-600" />
          <button disabled={busy || !password} className="rounded bg-red-600 px-4 py-2.5 font-semibold text-white hover:bg-red-700 disabled:opacity-50">
            {busy ? "Confirmando…" : linked === null ? "Confirmar conta" : linked ? "Desvincular Google" : "Vincular Google"}
          </button>
        </form>
        {message && <p role="status" aria-live="polite" className="mt-4 text-sm text-zinc-300">{message}</p>}
      </section>
    </main>
  );
}
