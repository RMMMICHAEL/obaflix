"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { signIn } from "next-auth/react";

export default function CadastroPage() {
  const router = useRouter();
  const [nome, setNome] = useState("");
  const [email, setEmail] = useState("");
  const [senha, setSenha] = useState("");
  const [erro, setErro] = useState("");
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setErro("");
    const res = await fetch("/api/auth/cadastro", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nome, email, senha }),
    });
    if (res.ok) {
      await signIn("credentials", { email, senha, redirect: false });
      router.push("/");
    } else {
      const d = await res.json();
      setErro(d.error ?? "Erro ao criar conta.");
    }
    setLoading(false);
  };

  return (
    <div className="min-h-screen flex items-center justify-center px-4">
      <div className="w-full max-w-sm bg-zinc-900 rounded-xl p-8 shadow-2xl">
        <h1 className="text-2xl font-bold text-white mb-6 text-center">Criar Conta</h1>
        <form onSubmit={handleSubmit} className="flex flex-col gap-3">
          <input
            placeholder="Nome" value={nome} onChange={(e) => setNome(e.target.value)}
            className="bg-zinc-800 text-white text-sm px-4 py-2.5 rounded outline-none focus:ring-2 focus:ring-red-600"
          />
          <input
            type="email" placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)}
            className="bg-zinc-800 text-white text-sm px-4 py-2.5 rounded outline-none focus:ring-2 focus:ring-red-600"
            required
          />
          <input
            type="password" placeholder="Senha (mín. 6 caracteres)" value={senha} onChange={(e) => setSenha(e.target.value)}
            minLength={6}
            className="bg-zinc-800 text-white text-sm px-4 py-2.5 rounded outline-none focus:ring-2 focus:ring-red-600"
            required
          />
          {erro && <p className="text-red-400 text-xs">{erro}</p>}
          <button
            type="submit" disabled={loading}
            className="bg-red-600 text-white font-bold py-2.5 rounded hover:bg-red-700 transition disabled:opacity-50 mt-1"
          >
            {loading ? "Criando..." : "Criar Conta"}
          </button>
        </form>
        <p className="text-zinc-500 text-sm text-center mt-5">
          Já tem conta?{" "}
          <Link href="/login" className="text-red-400 hover:text-red-300">Entrar</Link>
        </p>
      </div>
    </div>
  );
}
