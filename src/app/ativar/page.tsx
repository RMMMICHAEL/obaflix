"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { INSTALADORES } from "@/config/downloads";

const CAMPO = "bg-zinc-800 text-white text-sm px-4 py-2.5 rounded outline-none focus:ring-2 focus:ring-red-600";

export default function AtivarPage() {
  const [token, setToken] = useState("");
  const [senha, setSenha] = useState("");
  const [confirmacao, setConfirmacao] = useState("");
  const [email, setEmail] = useState("");
  const [erro, setErro] = useState("");
  const [estado, setEstado] = useState<"form" | "ativada" | "reenviado">("form");
  const [loading, setLoading] = useState(false);

  // O token vem no fragmento (#t=...): não vai ao servidor nem ao Referer. Sai da barra de endereço logo.
  useEffect(() => {
    // Só grava quando há token: uma segunda execução (efeito repetido) já lê o fragmento limpo.
    const t = new URLSearchParams(window.location.hash.slice(1)).get("t") ?? "";
    if (!t) return;
    setToken(t);
    window.history.replaceState(null, "", window.location.pathname);
  }, []);

  const ativar = async (e: React.FormEvent) => {
    e.preventDefault();
    setErro("");
    if (senha !== confirmacao) { setErro("As senhas não conferem."); return; }
    setLoading(true);
    const res = await fetch("/api/auth/ativacao", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token, senha }),
    }).catch(() => null);
    if (res?.ok) setEstado("ativada");
    else {
      const msg: string = (await res?.json().catch(() => null))?.error ?? "Não foi possível ativar. Tente novamente.";
      setErro(msg);
      if (res?.status === 400 && msg.startsWith("Link")) setToken(""); // link morto: oferece reenvio
    }
    setLoading(false);
  };

  const reenviar = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    await fetch("/api/auth/ativacao/reenviar", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email }),
    }).catch(() => null);
    setEstado("reenviado");
    setLoading(false);
  };

  return (
    <div className="min-h-screen flex items-center justify-center px-4">
      <div className="w-full max-w-sm bg-zinc-900 rounded-xl p-8 shadow-2xl">
        <p className="text-red-400 text-xs font-bold uppercase tracking-wider text-center mb-2">Obaflix Cortes</p>
        <h1 className="text-2xl font-bold text-white mb-3 text-center">Ativar seu acesso</h1>
        <p className="text-zinc-400 text-sm text-center mb-6">Confirme seu e-mail da compra criando uma senha. Depois, baixe o aplicativo para Windows.</p>
        {estado === "ativada" ? (
          <div className="space-y-4 text-center">
            <p className="text-green-400 font-semibold">Conta ativada! Sua senha foi criada.</p>
            <p className="text-zinc-300 text-sm">O seu acesso ja esta pronto. Se estiver no computador, baixe o aplicativo Windows:</p>
            <a href={INSTALADORES.windowsCortes.url} target="_blank" rel="noopener noreferrer" className="block bg-red-600 text-white font-bold py-3 rounded-lg hover:bg-red-700">Baixar Obaflix para Windows</a>
            <Link href="/login" className="block rounded-lg border border-zinc-600 p-3 text-sm text-white hover:bg-zinc-800">Ja tenho o aplicativo: entrar</Link>
            <p className="text-zinc-400 text-xs leading-relaxed">Se ja instalou no PC, abra o Obaflix e entre com o e-mail da compra e a senha que acabou de criar.</p>
          </div>
        ) : estado === "reenviado" ? (
          <p className="text-zinc-300 text-sm text-center">Se houver uma conta aguardando ativação para este e-mail, enviamos um novo link.</p>
        ) : token ? (
          <form onSubmit={ativar} className="flex flex-col gap-3">
            <label className="sr-only" htmlFor="senha">Nova senha</label>
            <input id="senha" type="password" autoComplete="new-password" placeholder="Nova senha (8+ caracteres, letras e números)"
              value={senha} onChange={(e) => setSenha(e.target.value)} minLength={8} maxLength={128} className={CAMPO} required />
            <label className="sr-only" htmlFor="confirmacao">Confirmar senha</label>
            <input id="confirmacao" type="password" autoComplete="new-password" placeholder="Confirmar senha"
              value={confirmacao} onChange={(e) => setConfirmacao(e.target.value)} className={CAMPO} required />
            {erro && <p role="alert" className="text-red-400 text-xs">{erro}</p>}
            <button type="submit" disabled={loading}
              className="bg-red-600 text-white font-bold py-2.5 rounded hover:bg-red-700 transition disabled:opacity-50 mt-1">
              {loading ? "Ativando..." : "Criar senha"}
            </button>
          </form>
        ) : (
          <form onSubmit={reenviar} className="flex flex-col gap-3">
            <p className="text-zinc-400 text-sm">Link ausente ou expirado. Informe o e-mail da compra para receber um novo.</p>
            {erro && <p role="alert" className="text-red-400 text-xs">{erro}</p>}
            <label className="sr-only" htmlFor="email">E-mail</label>
            <input id="email" type="email" autoComplete="email" placeholder="E-mail da compra"
              value={email} onChange={(e) => setEmail(e.target.value)} className={CAMPO} required />
            <button type="submit" disabled={loading}
              className="bg-red-600 text-white font-bold py-2.5 rounded hover:bg-red-700 transition disabled:opacity-50 mt-1">
              Enviar novo link
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
