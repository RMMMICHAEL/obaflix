"use client";

import { signOut, useSession } from "next-auth/react";
import { redirect } from "next/navigation";
import { useEffect, useState } from "react";
import { LandscapeCard } from "@/components/ui/LandscapeCard";
import { LinkAssinatura } from "@/components/ui/LinkAssinatura";
import { ExcluirConta } from "@/components/conta/ExcluirConta";
import { ctaAssinaturaConta, ehClientePlayNoNavegador, MENSAGEM_ASSINATURA_INDISPONIVEL_PLAY } from "@/config/play";

export default function ContaPage() {
  const { data: session, status } = useSession();
  const [watchlist, setWatchlist] = useState<any[]>([]);
  const [historico, setHistorico] = useState<any[]>([]);
  const [comercial, setComercial] = useState<{
    plano: { id: string; nome: string };
    assinatura: { terminaEm: string } | null;
    cortes?: { plano: { id: string; nome: string }; terminaEm: string } | null;
  } | null>(null);
  // Google Play é consumo apenas: nada de assinar/renovar/upgrade. A leitura é
  // no cliente (shim nativo/UA) e só troca o CTA por uma mensagem neutra — o
  // plano atual (GET /api/billing/me) continua aparecendo. Começa `null`
  // (desconhecido) e o CTA comercial só aparece quando a detecção confirma
  // não-Play: assim o cliente Play nunca vê "Ver planos", nem por um instante
  // antes da hidratação (fail-closed). Ver `ctaAssinaturaConta`.
  const [play, setPlay] = useState<boolean | null>(null);

  useEffect(() => {
    setPlay(ehClientePlayNoNavegador());
  }, []);
  const cta = ctaAssinaturaConta(play);

  useEffect(() => {
    if (status === "unauthenticated") redirect("/login");
  }, [status]);

  useEffect(() => {
    if (!session) return;
    fetch("/api/user/watchlist").then((r) => r.json()).then(setWatchlist);
    fetch("/api/user/history").then((r) => r.json()).then(setHistorico);
    fetch("/api/billing/me").then((r) => r.ok ? r.json() : null).then(setComercial);
  }, [session]);

  if (status === "loading") return <div className="min-h-screen flex items-center justify-center"><p className="text-zinc-400">Carregando...</p></div>;
  if (!session) return null;

  return (
    <div className="pt-20 px-4 md:px-8 pb-16 min-h-screen">
      <div className="flex items-center gap-4 mb-10">
        <div className="w-16 h-16 rounded-full bg-zinc-700 flex items-center justify-center text-2xl font-bold text-white">
          {session.user?.name?.charAt(0) ?? "U"}
        </div>
        <div className="min-w-0">
          <h1 className="text-xl font-bold text-white">{session.user?.name ?? "Usuário"}</h1>
          <p className="text-zinc-400 text-sm">{session.user?.email}</p>
          {/*
            Logout do NextAuth, o mesmo da Navbar, voltando para /login. Fica no
            perfil, no topo — não depois da lista. Não apaga nada do aparelho:
            downloads vivem no armazenamento nativo do app.
          */}
          <button
            type="button"
            onClick={() => signOut({ callbackUrl: "/login" })}
            className="mt-2 rounded-lg border border-zinc-700 px-3 py-1.5 text-xs font-semibold text-zinc-200 hover:border-zinc-500 hover:bg-zinc-800"
          >
            Sair da conta
          </button>
        </div>
      </div>

      <section className="mb-10 rounded-xl border border-zinc-800 bg-zinc-900 p-5">
        <h2 className="text-lg font-semibold text-white">Meu plano</h2>
        <p className="mt-1 text-sm text-zinc-400">Plano atual: {comercial?.plano.nome ?? "Carregando…"}</p>
        {comercial?.assinatura && <p className="mt-1 text-sm text-zinc-400">Válido até {new Date(comercial.assinatura.terminaEm).toLocaleDateString("pt-BR")}</p>}
        {/* Cortes é assinatura à parte: aparece mesmo quando o plano base é o tradicional. */}
        {comercial?.cortes && comercial.cortes.plano.id !== comercial.plano.id && (
          <p className="mt-3 text-sm text-zinc-400">
            Também ativo: {comercial.cortes.plano.nome} · válido até {new Date(comercial.cortes.terminaEm).toLocaleDateString("pt-BR")}
          </p>
        )}
        {cta === "neutro" && (
          <p className="mt-4 text-sm text-zinc-500">{MENSAGEM_ASSINATURA_INDISPONIVEL_PLAY}</p>
        )}
        {cta === "cta" && (
          <div className="mt-4 flex flex-wrap gap-2">
            <LinkAssinatura href="/planos" className="inline-block rounded-lg bg-red-600 px-4 py-2 text-sm font-semibold text-white">Ver planos</LinkAssinatura>
            {comercial?.cortes ? (
              <>
                <LinkAssinatura href={`/checkout?planoId=${encodeURIComponent(comercial.cortes.plano.id)}`} className="inline-block rounded-lg border border-zinc-700 px-4 py-2 text-sm font-semibold text-zinc-100 hover:border-zinc-500">Renovar Cortes</LinkAssinatura>
                {comercial.cortes.plano.id === "cortes-start" && (
                  <LinkAssinatura href="/checkout?planoId=cortes-pro" className="inline-block rounded-lg border border-zinc-700 px-4 py-2 text-sm font-semibold text-zinc-100 hover:border-zinc-500">Upgrade para Cortes Pro</LinkAssinatura>
                )}
              </>
            ) : comercial && (
              <LinkAssinatura href="/cortes" className="inline-block rounded-lg border border-zinc-700 px-4 py-2 text-sm font-semibold text-zinc-100 hover:border-zinc-500">Conhecer o Obaflix Cortes</LinkAssinatura>
            )}
          </div>
        )}
        {/* cta === "indefinido": detecção ainda não rodou — nenhum CTA comercial
            (fail-closed). Espaço discreto para não pular o layout. */}
        {cta === "indefinido" && <div className="mt-4 h-10" aria-hidden="true" />}
      </section>

      <section className="mb-10">
        <h2 className="text-lg font-semibold text-white mb-4">Minha Lista ({watchlist.length})</h2>
        <div className="grid grid-cols-2 gap-x-3 gap-y-5 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
          {watchlist.map((w) => {
            const item = w.filme ?? w.serie;
            if (!item) return null;
            return (
              <LandscapeCard
                key={`${w.userId}-${w.conteudoId}`}
                layout="grid"
                id={item.id}
                tipo={w.conteudoTipo === "filme" ? "filme" : (item.tipo ?? "serie")}
                titulo={item.titulo}
                poster={item.poster ?? null}
                background={item.background ?? null}
                ano={item.ano ?? null}
                nota={item.nota ?? null}
              />
            );
          })}
        </div>
      </section>

      <section className="mb-10">
        <ExcluirConta />
      </section>
    </div>
  );
}
