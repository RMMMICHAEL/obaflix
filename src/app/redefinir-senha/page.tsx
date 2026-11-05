"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

const CAMPO = "bg-zinc-800 text-white text-sm px-4 py-2.5 rounded outline-none focus:ring-2 focus:ring-red-600";

export default function RedefinirSenhaPage() {
  const [token, setToken] = useState("");
  const [email, setEmail] = useState("");
  const [senha, setSenha] = useState("");
  const [confirmacao, setConfirmacao] = useState("");
  const [erro, setErro] = useState("");
  const [estado, setEstado] = useState<"form" | "feito" | "enviado">("form");
  const [loading, setLoading] = useState(false);

  // O token vem no fragmento (#t=...): não vai ao servidor nem ao Referer. Sai da barra de endereço logo.
  useEffect(() => {
    const t = new URLSearchParams(window.location.hash.slice(1)).get("t") ?? "";
    if (!t) return;
    setToken(t);
    window.history.replaceState(null, "", window.location.pathname);
  }, []);

  const redefinir = async (e: React.FormEvent) => {
    e.preventDefault();
    setErro("");
    if (senha !== confirmacao) { setErro("As senhas não conferem."); return; }
    setLoading(true);
    const res = await fetch("/api/auth/redefinir", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token, senha }),
    }).catch(() => null);
    if (res?.ok) setEstado("feito");
    else {
      const msg: string = (await res?.json().catch(() => null))?.error ?? "Não foi possível redefinir. Tente novamente.";
      setErro(msg);
      if (res?.status === 400 && msg.startsWith("Link")) setToken(""); // link morto: oferece um novo
    }
    setLoading(false);
  };

  const pedir = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    await fetch("/api/auth/recuperar", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email }),
    }).catch(() => null);
    setEstado("enviado");
    setLoading(false);
  };

  return (
    <div className="min-h-screen flex items-center justify-center px-4">
      <div className="w-full max-w-sm bg-zinc-900 rounded-xl p-8 shadow-2xl">
        <h1 className="text-2xl font-bold text-white mb-3 text-center">Redefinir senha</h1>
        {estado === "feito" ? (
          <div className="space-y-4 text-center">
            <p className="text-green-400 font-semibold">Senha alterada.</p>
            <p className="text-zinc-300 text-sm">Entre no site ou no aplicativo com o seu e-mail e a nova senha.</p>
            <Link href="/login" className="block bg-red-600 text-white font-bold py-3 rounded-lg hover:bg-red-700">Entrar</Link>
          </div>
        ) : estado === "enviado" ? (
          <p className="text-zinc-300 text-sm text-center">Se houver uma conta com este e-mail, enviamos um link para criar a nova senha. Ele vale 30 minutos.</p>
        ) : token ? (
          <form onSubmit={redefinir} className="flex flex-col gap-3">
            <p className="text-zinc-400 text-sm text-center mb-2">Crie uma nova senha para a sua conta.</p>
            <label className="sr-only" htmlFor="senha">Nova senha</label>
            <input id="senha" type="password" autoComplete="new-password" placeholder="Nova senha (8+ caracteres, letras e números)"
              value={senha} onChange={(e) => setSenha(e.target.value)} minLength={8} maxLength={128} className={CAMPO} required />
            <label className="sr-only" htmlFor="confirmacao">Confirmar senha</label>
            <input id="confirmacao" type="password" autoComplete="new-password" placeholder="Confirmar senha"
              value={confirmacao} onChange={(e) => setConfirmacao(e.target.value)} className={CAMPO} required />
            {erro && <p role="alert" className="text-red-400 text-xs">{erro}</p>}
            <button type="submit" disabled={loading}
              className="bg-red-600 text-white font-bold py-2.5 rounded hover:bg-red-700 transition disabled:opacity-50 mt-1">
              {loading ? "Salvando..." : "Salvar nova senha"}
            </button>
          </form>
        ) : (
          <form onSubmit={pedir} className="flex flex-col gap-3">
            <p className="text-zinc-400 text-sm text-center mb-2">Informe o e-mail da conta para receber um link de redefinição.</p>
            {erro && <p role="alert" className="text-red-400 text-xs">{erro}</p>}
            <label className="sr-only" htmlFor="email">E-mail</label>
            <input id="email" type="email" autoComplete="email" placeholder="E-mail"
              value={email} onChange={(e) => setEmail(e.target.value)} className={CAMPO} required />
            <button type="submit" disabled={loading}
              className="bg-red-600 text-white font-bold py-2.5 rounded hover:bg-red-700 transition disabled:opacity-50 mt-1">
              Enviar link
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
