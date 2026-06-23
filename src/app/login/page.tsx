"use client";

import { useState } from "react";
import { signIn } from "next-auth/react";
import { useRouter } from "next/navigation";
import Link from "next/link";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [senha, setSenha] = useState("");
  const [erro, setErro] = useState("");
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setErro("");
    const res = await signIn("credentials", { email, senha: senha, redirect: false });
    if (res?.ok) {
      router.push("/");
    } else {
      setErro("Email ou senha incorretos.");
    }
    setLoading(false);
  };

  return (
    <div className="min-h-screen flex items-center justify-center px-4">
      <div className="w-full max-w-sm bg-zinc-900 rounded-xl p-8 shadow-2xl">
        <h1 className="text-2xl font-bold text-white mb-6 text-center">Entrar</h1>

        <button
          onClick={() => signIn("google", { callbackUrl: "/" })}
          className="w-full flex items-center justify-center gap-2 bg-white text-zinc-800 font-semibold py-2.5 rounded mb-4 hover:bg-zinc-100 transition text-sm"
        >
          <svg className="w-4 h-4" viewBox="0 0 24 24"><path fill="#4285F4" d="M23.745 12.27c0-.79-.07-1.54-.19-2.27h-11.3v4.51h6.47c-.29 1.48-1.14 2.73-2.4 3.58v3h3.86c2.26-2.09 3.56-5.17 3.56-8.82z"/><path fill="#34A853" d="M12.255 24c3.24 0 5.95-1.08 7.93-2.91l-3.86-3c-1.08.72-2.45 1.16-4.07 1.16-3.13 0-5.78-2.11-6.73-4.96h-3.98v3.09C3.515 21.3 7.615 24 12.255 24z"/><path fill="#FBBC05" d="M5.525 14.29c-.25-.72-.38-1.49-.38-2.29s.14-1.57.38-2.29V6.62h-3.98a11.86 11.86 0 0 0 0 10.76l3.98-3.09z"/><path fill="#EA4335" d="M12.255 4.75c1.77 0 3.35.61 4.6 1.8l3.42-3.42C18.205 1.19 15.495 0 12.255 0c-4.64 0-8.74 2.7-10.71 6.62l3.98 3.09c.95-2.85 3.6-4.96 6.73-4.96z"/></svg>
          Entrar com Google
        </button>

        <div className="flex items-center gap-3 mb-4">
          <div className="flex-1 h-px bg-zinc-700" />
          <span className="text-zinc-500 text-xs">ou</span>
          <div className="flex-1 h-px bg-zinc-700" />
        </div>

        <form onSubmit={handleSubmit} className="flex flex-col gap-3">
          <input
            type="email" placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)}
            className="bg-zinc-800 text-white text-sm px-4 py-2.5 rounded outline-none focus:ring-2 focus:ring-red-600"
            required
          />
          <input
            type="password" placeholder="Senha" value={senha} onChange={(e) => setSenha(e.target.value)}
            className="bg-zinc-800 text-white text-sm px-4 py-2.5 rounded outline-none focus:ring-2 focus:ring-red-600"
            required
          />
          {erro && <p className="text-red-400 text-xs">{erro}</p>}
          <button
            type="submit" disabled={loading}
            className="bg-red-600 text-white font-bold py-2.5 rounded hover:bg-red-700 transition disabled:opacity-50 mt-1"
          >
            {loading ? "Entrando..." : "Entrar"}
          </button>
        </form>

        <p className="text-zinc-500 text-sm text-center mt-5">
          Não tem conta?{" "}
          <Link href="/cadastro" className="text-red-400 hover:text-red-300">Criar conta</Link>
        </p>
      </div>
    </div>
  );
}
