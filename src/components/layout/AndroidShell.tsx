"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { FormEvent, useEffect, useState } from "react";
import { Film, Home, Search, Tv, UserRound, X } from "lucide-react";
import { isPlayerRoute, useAppMode } from "./AppMode";

const NAV_ITEMS = [
  { href: "/android", label: "Início", icon: Home },
  { href: "/filmes", label: "Filmes", icon: Film },
  { href: "/buscar", label: "Buscar", icon: Search },
  { href: "/series", label: "Séries", icon: Tv },
  { href: "/conta", label: "Minha conta", shortLabel: "Conta", icon: UserRound },
];

export function AndroidShell() {
  const pathname = usePathname();
  const router = useRouter();
  const mode = useAppMode();
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");

  // A decisão de modo e a classe no <html> ficam no AppModeProvider; aqui só
  // resta a regra própria do shell: nas rotas de player ele não aparece.
  const enabled = mode === "android" && !isPlayerRoute(pathname);

  useEffect(() => setSearchOpen(false), [pathname]);

  function submitSearch(event: FormEvent) {
    event.preventDefault();
    const value = query.trim();
    if (!value) return;
    router.push(`/buscar?q=${encodeURIComponent(value)}`);
  }

  if (!enabled) return null;

  return (
    <div data-android-shell>
      <header className="android-topbar" aria-label="Cabeçalho do aplicativo">
        {searchOpen ? (
          <form className="android-search" onSubmit={submitSearch} role="search">
            <Search size={19} aria-hidden="true" />
            <input
              autoFocus
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Filme, série, anime..."
              aria-label="Buscar no catálogo"
            />
            <button type="button" onClick={() => setSearchOpen(false)} aria-label="Fechar busca">
              <X size={20} />
            </button>
          </form>
        ) : (
          <>
            <Link href="/android" className="android-wordmark" aria-label="Obaflix, início">
              OBA<span>FLIX</span>
            </Link>
            <button
              type="button"
              className="android-topbar-action"
              onClick={() => setSearchOpen(true)}
              aria-label="Abrir busca"
            >
              <Search size={21} />
            </button>
          </>
        )}
      </header>

      <nav className="android-bottom-nav" aria-label="Navegação principal do aplicativo">
        {NAV_ITEMS.map(({ href, label, shortLabel, icon: Icon }) => {
          const active = href === "/android"
            ? pathname === "/android"
            : pathname === href || pathname.startsWith(`${href}/`);
          return (
            <Link key={href} href={href} className={active ? "is-active" : undefined} aria-current={active ? "page" : undefined}>
              <Icon size={22} strokeWidth={active ? 2.4 : 1.8} aria-hidden="true" />
              <span>{shortLabel ?? label}</span>
            </Link>
          );
        })}
      </nav>
    </div>
  );
}
