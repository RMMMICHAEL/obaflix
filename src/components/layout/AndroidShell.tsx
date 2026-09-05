"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { FormEvent, useEffect, useState } from "react";
import { Film, Home, Search, Smile, Sparkles, Tv, UserRound, X } from "lucide-react";
import { isPlayerRoute, useAppMode } from "./AppMode";
import {
  ANDROID_NAV_ITEMS,
  ROTA_CONTA,
  abaAtiva,
  mostrarBuscaNaTopbar,
  rotaDeBusca,
  type NomeIcone,
} from "./androidNav";

const ICONES: Record<NomeIcone, typeof Home> = {
  home: Home,
  film: Film,
  tv: Tv,
  sparkles: Sparkles,
  smile: Smile,
};

export function AndroidShell() {
  const pathname = usePathname();
  const router = useRouter();
  const mode = useAppMode();
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");

  // A decisão de modo e a classe no <html> ficam no AppModeProvider; aqui só
  // resta a regra própria do shell: nas rotas de player ele não aparece.
  const enabled = mode === "android" && !isPlayerRoute(pathname);

  // Em /buscar quem tem o campo é a página. A lupa some para não existirem
  // duas buscas na mesma tela — que era a confusão original, agravada por a
  // segunda não funcionar.
  const buscaNaTopbar = mostrarBuscaNaTopbar(pathname);

  useEffect(() => setSearchOpen(false), [pathname]);

  function submitSearch(event: FormEvent) {
    event.preventDefault();
    const destino = rotaDeBusca(query);
    if (!destino) return;
    router.push(destino);
  }

  if (!enabled) return null;

  return (
    <div data-android-shell>
      <header className="android-topbar" aria-label="Cabeçalho do aplicativo">
        {searchOpen && buscaNaTopbar ? (
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
            <div className="android-topbar-actions">
              {buscaNaTopbar && (
                <button
                  type="button"
                  className="android-topbar-action"
                  onClick={() => setSearchOpen(true)}
                  aria-label="Buscar no catálogo"
                >
                  <Search size={21} />
                </button>
              )}
              {/* Conta saiu da barra inferior para abrir vaga a Animes e Kids. */}
              <Link
                href={ROTA_CONTA}
                className="android-topbar-action"
                aria-label="Minha conta"
                aria-current={abaAtiva(pathname, ROTA_CONTA) ? "page" : undefined}
              >
                <UserRound size={21} />
              </Link>
            </div>
          </>
        )}
      </header>

      <nav className="android-bottom-nav" aria-label="Navegação principal do aplicativo">
        {ANDROID_NAV_ITEMS.map(({ href, label, icone }) => {
          const active = abaAtiva(pathname, href);
          const Icon = ICONES[icone];
          return (
            <Link key={href} href={href} className={active ? "is-active" : undefined} aria-current={active ? "page" : undefined}>
              <Icon size={22} strokeWidth={active ? 2.4 : 1.8} aria-hidden="true" />
              <span>{label}</span>
            </Link>
          );
        })}
      </nav>
    </div>
  );
}
