"use client";

import Link from "next/link";
import { useSession, signOut } from "next-auth/react";
import { useState } from "react";
import { Search, User, Menu, X } from "lucide-react";
import { useRouter } from "next/navigation";

export function Navbar() {
  const { data: session } = useSession();
  const router = useRouter();
  const [q, setQ] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    if (q.trim()) router.push(`/buscar?q=${encodeURIComponent(q.trim())}`);
  };

  return (
    <nav className="fixed top-0 left-0 right-0 z-40 bg-gradient-to-b from-black/90 to-transparent">
      <div className="flex items-center justify-between px-4 md:px-8 h-16">
        {/* logo */}
        <Link href="/" className="text-red-600 font-black text-2xl tracking-tight shrink-0">
          STREAM<span className="text-white">IX</span>
        </Link>

        {/* links desktop */}
        <div className="hidden md:flex items-center gap-5 text-sm text-zinc-300">
          <Link href="/" className="hover:text-white transition">Início</Link>
          <Link href="/filmes" className="hover:text-white transition">Filmes</Link>
          <Link href="/series" className="hover:text-white transition">Séries</Link>
          <Link href="/animes" className="hover:text-white transition">Animes</Link>
          <Link href="/desenhos" className="hover:text-white transition">Desenhos</Link>
        </div>

        {/* right actions */}
        <div className="flex items-center gap-3">
          <form onSubmit={handleSearch} className="hidden md:flex items-center bg-black/60 border border-zinc-700 rounded px-2">
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Buscar..."
              className="bg-transparent text-white text-sm px-2 py-1.5 outline-none w-40 focus:w-56 transition-all"
            />
            <button type="submit" className="text-zinc-400 hover:text-white">
              <Search size={16} />
            </button>
          </form>

          {session ? (
            <div className="relative">
              <button
                onClick={() => setMenuOpen((o) => !o)}
                className="flex items-center gap-1.5 text-white text-sm"
              >
                <User size={18} />
                <span className="hidden md:inline">{session.user?.name?.split(" ")[0] ?? session.user?.email}</span>
              </button>
              {menuOpen && (
                <>
                  {/* Backdrop para fechar ao clicar fora */}
                  <div className="fixed inset-0 z-10" onClick={() => setMenuOpen(false)} />
                  <div className="absolute right-0 top-full mt-2 w-52 bg-zinc-900 border border-zinc-800 rounded-xl shadow-xl z-20 overflow-hidden">
                    <div className="px-4 py-3 border-b border-zinc-800">
                      <p className="text-xs text-zinc-400">Logado como</p>
                      <p className="text-sm text-white font-medium truncate">{session.user?.email}</p>
                    </div>
                    <Link href="/conta" onClick={() => setMenuOpen(false)} className="block px-4 py-2.5 text-sm text-zinc-300 hover:text-white hover:bg-zinc-800">Minha Conta</Link>
                    {(session.user as { role?: string })?.role === "admin" && (
                      <Link href="/admin" onClick={() => setMenuOpen(false)} className="block px-4 py-2.5 text-sm text-zinc-300 hover:text-white hover:bg-zinc-800">Admin</Link>
                    )}
                    <button onClick={() => signOut()} className="w-full text-left px-4 py-2.5 text-sm text-red-400 hover:text-red-300 hover:bg-zinc-800">
                      Sair
                    </button>
                  </div>
                </>
              )}
            </div>
          ) : (
            <Link href="/login" className="bg-red-600 text-white text-sm font-semibold px-4 py-1.5 rounded hover:bg-red-700 transition">
              Entrar
            </Link>
          )}

          <button className="md:hidden text-white" onClick={() => setMenuOpen(!menuOpen)}>
            {menuOpen ? <X size={22} /> : <Menu size={22} />}
          </button>
        </div>
      </div>

      {/* mobile menu */}
      {menuOpen && (
        <div className="md:hidden bg-zinc-950 border-t border-zinc-800 px-4 py-4 flex flex-col gap-3 text-sm">
          {["/" , "/filmes", "/series", "/animes", "/desenhos"].map((href) => (
            <Link key={href} href={href} className="text-zinc-300 hover:text-white" onClick={() => setMenuOpen(false)}>
              {href === "/" ? "Início" : href.slice(1).charAt(0).toUpperCase() + href.slice(2)}
            </Link>
          ))}
          <form onSubmit={handleSearch} className="flex gap-2 mt-2">
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Buscar..." className="flex-1 bg-zinc-800 text-white text-sm px-3 py-2 rounded outline-none" />
            <button type="submit" className="bg-zinc-700 text-white px-3 rounded"><Search size={16} /></button>
          </form>
        </div>
      )}
    </nav>
  );
}
