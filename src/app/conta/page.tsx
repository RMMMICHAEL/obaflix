"use client";

import { signOut, useSession } from "next-auth/react";
import { redirect } from "next/navigation";
import { useEffect, useState } from "react";
import { LandscapeCard } from "@/components/ui/LandscapeCard";
import { LinkAssinatura } from "@/components/ui/LinkAssinatura";
import { ExcluirConta } from "@/components/conta/ExcluirConta";
import { ctaAssinaturaConta, ehClientePlayNoNavegador, MENSAGEM_ASSINATURA_INDISPONIVEL_PLAY } from "@/config/play";
import { classificarLista, classificarPlano } from "@/lib/conta/respostaConta";

export default function ContaPage() {
  const { data: session, status } = useSession();
  const [watchlist, setWatchlist] = useState<any[]>([]);
  const [historico, setHistorico] = useState<any[]>([]);
  const [comercial, setComercial] = useState<{ plano: { id: string; nome: string }; assinatura: { terminaEm: string } | null } | null>(null);
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
    // Concorrência/stale: se a sessão mudar ou a página desmontar, as respostas
    // tardias são ignoradas e as requisições em voo são abortadas — nada de
    // `setState` com dados de uma sessão que já não vale.
    let ativo = true;
    let encerrando = false;
    const controller = new AbortController();

    // Sessão revogada/expirada no servidor com sessão ainda em memória (ex.: conta
    // excluída noutro navegador): encerra com segurança e vai ao login, UMA vez,
    // sem renderizar dados antigos. Ver `respostaConta.ts`.
    const encerrarSessaoRevogada = () => {
      if (!ativo || encerrando) return;
      encerrando = true;
      signOut({ callbackUrl: "/login" });
    };

    const carregarLista = async (url: string, set: (v: any[]) => void) => {
      let r: Response;
      try {
        r = await fetch(url, { signal: controller.signal });
      } catch {
        return; // abort/rede: mantém o default seguro ([]), sem quebrar o render.
      }
      const resultado = await classificarLista(r);
      if (!ativo) return;
      if (resultado.tipo === "revogada") return encerrarSessaoRevogada();
      set(resultado.tipo === "ok" ? resultado.dados : []);
    };

    const carregarPlano = async () => {
      let r: Response;
      try {
        r = await fetch("/api/billing/me", { signal: controller.signal });
      } catch {
        return; // mantém `comercial` como está (null → "Carregando…").
      }
      const resultado = await classificarPlano(r);
      if (!ativo) return;
      if (resultado.tipo === "revogada") return encerrarSessaoRevogada();
      setComercial(resultado.tipo === "ok" ? (resultado.dados as any) : null);
    };

    carregarLista("/api/user/watchlist", setWatchlist);
    carregarLista("/api/user/history", setHistorico);
    carregarPlano();

    return () => {
      ativo = false;
      controller.abort();
    };
  }, [session]);

  if (status === "loading") return <div className="min-h-screen flex items-center justify-center"><p className="text-zinc-400">Carregando...</p></div>;
  if (!session) return null;

  // Invariante de render: as listas vêm sempre como array dos efeitos acima, mas
  // o guard protege contra qualquer regressão futura — nunca `.map` sobre não-array.
  const lista = Array.isArray(watchlist) ? watchlist : [];

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
        {cta === "neutro" && (
          <p className="mt-4 text-sm text-zinc-500">{MENSAGEM_ASSINATURA_INDISPONIVEL_PLAY}</p>
        )}
        {cta === "cta" && (
          <LinkAssinatura href="/planos" className="mt-4 inline-block rounded-lg bg-red-600 px-4 py-2 text-sm font-semibold text-white">Ver planos</LinkAssinatura>
        )}
        {/* cta === "indefinido": detecção ainda não rodou — nenhum CTA comercial
            (fail-closed). Espaço discreto para não pular o layout. */}
        {cta === "indefinido" && <div className="mt-4 h-10" aria-hidden="true" />}
      </section>

      <section className="mb-10">
        <h2 className="text-lg font-semibold text-white mb-4">Minha Lista ({lista.length})</h2>
        <div className="grid grid-cols-2 gap-x-3 gap-y-5 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
          {lista.map((w) => {
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
