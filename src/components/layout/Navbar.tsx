"use client";

import Link from "next/link";
import { useSession, signOut } from "next-auth/react";
import { useState, useEffect } from "react";
import { Search, User, Menu, X, ChevronDown } from "lucide-react";
import { useRouter, usePathname } from "next/navigation";

const NAV_LINKS = [
  { href: "/", label: "Início" },
  { href: "/filmes", label: "Filmes" },
  { href: "/series", label: "Séries" },
  { href: "/animes", label: "Animes" },
  { href: "/desenhos", label: "Desenhos" },
];

export function Navbar() {
  const { data: session } = useSession();
  const router = useRouter();
  const pathname = usePathname();
  const [q, setQ] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  const [userOpen, setUserOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 40);
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    if (q.trim()) { router.push(`/buscar?q=${encodeURIComponent(q.trim())}`); setMenuOpen(false); }
  };

  return (
    <nav
      className={`fixed top-0 left-0 right-0 z-40 transition-colors duration-300 ${
        scrolled ? "bg-zinc-950/98 border-b border-zinc-800/50" : "bg-gradient-to-b from-black/90 to-transparent"
      }`}
    >
      <div className="flex items-center justify-between px-4 md:px-8 h-16">
        {/* Logo */}
        <Link href="/" className="text-red-600 font-black text-xl tracking-tight shrink-0 mr-6">
          OBA<span className="text-white">FLIX</span>
        </Link>

        {/* Desktop nav links */}
        <div className="hidden md:flex items-center gap-1 flex-1">
          {NAV_LINKS.map(({ href, label }) => {
            const active = href === "/" ? pathname === "/" : pathname.startsWith(href);
            return (
              <Link
                key={href}
                href={href}
                className={`px-3 py-1.5 rounded text-sm transition ${
                  active ? "text-white font-semibold" : "text-zinc-400 hover:text-white"
                }`}
              >
                {label}
              </Link>
            );
          })}
        </div>

        {/* Right actions */}
        <div className="flex items-center gap-2">
          {/* Search — desktop */}
          <form onSubmit={handleSearch} className="hidden md:flex items-center bg-black/60 border border-zinc-700 rounded-lg px-2 focus-within:border-zinc-500 transition-colors">
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Buscar..."
              className="bg-transparent text-white text-sm px-2 py-1.5 outline-none w-36 focus:w-52 transition-all"
            />
            <button type="submit" className="text-zinc-400 hover:text-white transition">
              <Search size={15} />
            </button>
          </form>

          {/* User menu */}
          {session ? (
            <div className="relative">
              <button
                onClick={() => setUserOpen((o) => !o)}
                className="flex items-center gap-1.5 text-white text-sm px-2 py-1.5 rounded hover:bg-white/10 transition"
              >
                <div className="w-7 h-7 rounded-full bg-red-600 flex items-center justify-center text-xs font-bold">
                  {(session.user?.name ?? session.user?.email ?? "U")[0].toUpperCase()}
                </div>
                <span className="hidden md:inline text-sm font-medium">
                  {session.user?.name?.split(" ")[0] ?? session.user?.email}
                </span>
                <ChevronDown size={14} className={`transition-transform ${userOpen ? "rotate-180" : ""}`} />
              </button>

              {userOpen && (
                <>
                  <div className="fixed inset-0 z-10" onClick={() => setUserOpen(false)} />
                  <div className="absolute right-0 top-full mt-2 w-52 bg-zinc-900 border border-zinc-800 rounded-xl shadow-2xl z-20 overflow-hidden">
                    <div className="px-4 py-3 border-b border-zinc-800">
                      <p className="text-xs text-zinc-500">Logado como</p>
                      <p className="text-sm text-white font-medium truncate">{session.user?.email}</p>
                    </div>
                    <Link href="/conta" onClick={() => setUserOpen(false)} className="block px-4 py-2.5 text-sm text-zinc-300 hover:text-white hover:bg-zinc-800 transition">
                      Minha Conta
                    </Link>
                    {(session.user as { role?: string })?.role === "admin" && (
                      <Link href="/admin" onClick={() => setUserOpen(false)} className="block px-4 py-2.5 text-sm text-zinc-300 hover:text-white hover:bg-zinc-800 transition">
                        Painel Admin
                      </Link>
                    )}
                    <div className="border-t border-zinc-800">
                      <button onClick={() => signOut()} className="w-full text-left px-4 py-2.5 text-sm text-red-400 hover:text-red-300 hover:bg-zinc-800 transition">
                        Sair
                      </button>
                    </div>
                  </div>
                </>
              )}
            </div>
          ) : (
            <Link href="/login" className="bg-red-600 text-white text-sm font-bold px-4 py-1.5 rounded-lg hover:bg-red-700 transition">
              Entrar
            </Link>
          )}

          {/* Mobile hamburger */}
          <button
            className="md:hidden text-white p-1"
            onClick={() => setMenuOpen(!menuOpen)}
            aria-label="Menu"
          >
            {menuOpen ? <X size={22} /> : <Menu size={22} />}
          </button>
        </div>
      </div>

      {/* Mobile menu */}
      {menuOpen && (
        <div className="md:hidden bg-zinc-950 border-t border-zinc-800 px-4 py-4 flex flex-col gap-1 text-sm">
          {NAV_LINKS.map(({ href, label }) => {
            const active = href === "/" ? pathname === "/" : pathname.startsWith(href);
            return (
              <Link
                key={href}
                href={href}
                onClick={() => setMenuOpen(false)}
                className={`px-3 py-2.5 rounded-lg transition ${active ? "bg-white/10 text-white font-semibold" : "text-zinc-300 hover:text-white hover:bg-white/5"}`}
              >
                {label}
              </Link>
            );
          })}
          <form onSubmit={handleSearch} className="flex gap-2 mt-3 pt-3 border-t border-zinc-800">
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Buscar..."
              className="flex-1 bg-zinc-800 text-white text-sm px-3 py-2 rounded-lg outline-none"
            />
            <button type="submit" className="bg-red-600 text-white px-4 rounded-lg font-semibold text-sm">
              Buscar
            </button>
          </form>
        </div>
      )}
    </nav>
  );
}
