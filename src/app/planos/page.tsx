"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

type Preco = {
  id: string;
  rotulo: string;
  duracaoDias: number | null;
  duracaoMeses: number | null;
  precoCentavos: number;
  moeda: string;
};

type Beneficio = { texto: string; incluido: boolean };

type Plano = {
  id: string;
  nome: string;
  descricao?: string | null;
  compravel: boolean;
  precos: Preco[];
  vitrine: {
    nome: string;
    tema: "azul" | "roxo" | "ambar" | null;
    selo: string | null;
    beneficios: Beneficio[];
  };
};

type Conta = {
  plano?: { id?: string | null } | null;
  assinatura?: unknown;
};

const TOM: Record<"azul" | "roxo" | "ambar", { cor: string; texto: string }> = {
  azul: { cor: "#4C8DFF", texto: "#FFFFFF" },
  roxo: { cor: "#A66BFF", texto: "#FFFFFF" },
  ambar: { cor: "#F5B82E", texto: "#1A1206" },
};

function dinheiro(centavos: number, moeda: string) {
  return new Intl.NumberFormat("pt-BR", { style: "currency", currency: moeda }).format(centavos / 100);
}

function duracaoAproximada(preco: Preco) {
  return preco.duracaoDias ?? ((preco.duracaoMeses ?? 0) * 30);
}

function precoDeEntrada(plano: Plano) {
  return [...plano.precos].sort((a, b) => duracaoAproximada(a) - duracaoAproximada(b))[0] ?? null;
}

export default function PlanosPage() {
  const [planos, setPlanos] = useState<Plano[]>([]);
  const [conta, setConta] = useState<Conta | null>(null);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState("");

  useEffect(() => {
    let ativo = true;
    Promise.all([
      fetch("/api/billing/plans", { cache: "no-store" }).then(async (r) => {
        if (!r.ok) throw new Error("planos");
        return r.json();
      }),
      fetch("/api/billing/me", { cache: "no-store" }).then(async (r) => {
        if (r.status === 401) return null;
        if (!r.ok) throw new Error("conta");
        return r.json();
      }),
    ])
      .then(([catalogo, me]) => {
        if (!ativo) return;
        setPlanos(Array.isArray(catalogo?.planos) ? catalogo.planos : []);
        setConta(me);
      })
      .catch(() => {
        if (ativo) setErro("Não foi possível carregar os planos agora.");
      })
      .finally(() => {
        if (ativo) setCarregando(false);
      });

    return () => {
      ativo = false;
    };
  }, []);

  const vitrine = useMemo(
    () => planos.filter((plano) => plano.vitrine?.tema && TOM[plano.vitrine.tema]),
    [planos],
  );

  const indiceAtual = vitrine.findIndex((plano) => plano.id === conta?.plano?.id);
  const assinaturaAtiva = Boolean(conta?.assinatura);

  return (
    <main className="relative min-h-screen overflow-hidden bg-[#101014] px-5 pb-12 pt-24 text-white md:px-10 xl:px-14">
      <div className="pointer-events-none absolute inset-x-0 top-0 h-[520px] bg-[radial-gradient(ellipse_at_top,rgba(166,107,255,0.15),transparent_66%)]" />

      <div className="relative mx-auto max-w-[1500px]">
        <header className="mb-8 flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="mb-2 text-xs font-bold uppercase tracking-[0.24em] text-zinc-500">Obaflix</p>
            <h1 className="text-3xl font-black tracking-tight md:text-4xl">Planos Obaflix</h1>
            <p className="mt-2 text-base text-zinc-400 md:text-lg">
              Escolha um plano e finalize os detalhes da assinatura no checkout.
            </p>
          </div>
          <Link
            href="/"
            className="w-fit rounded-xl border border-white/10 bg-white/5 px-5 py-2.5 text-sm font-semibold text-zinc-200 transition hover:bg-white/10"
          >
            Voltar
          </Link>
        </header>

        {carregando && (
          <div className="grid gap-5 lg:grid-cols-3">
            {[0, 1, 2].map((item) => (
              <div key={item} className="h-[570px] animate-pulse rounded-[22px] border border-white/10 bg-zinc-900/70" />
            ))}
          </div>
        )}

        {!carregando && erro && (
          <div className="rounded-2xl border border-red-500/20 bg-red-500/10 p-6 text-red-100">{erro}</div>
        )}

        {!carregando && !erro && vitrine.length === 0 && (
          <div className="rounded-2xl border border-white/10 bg-white/5 p-8 text-zinc-300">
            Planos indisponíveis no momento.
          </div>
        )}

        {!carregando && !erro && vitrine.length > 0 && (
          <section className="grid items-stretch gap-5 lg:grid-cols-3">
            {vitrine.map((plano, indice) => {
              const tema = TOM[plano.vitrine.tema as keyof typeof TOM];
              const preco = precoDeEntrada(plano);
              const atual = indice === indiceAtual;
              const podeAssinar =
                plano.compravel &&
                (!assinaturaAtiva || (indiceAtual >= 0 && indice > indiceAtual));
              const rotuloAcao =
                assinaturaAtiva && indiceAtual >= 0 && indice > indiceAtual ? "Fazer upgrade" : "Assinar";
              const selo = atual ? "Plano atual" : plano.vitrine.selo;
              const nivel = Math.min(indice + 1, 3);

              return (
                <article
                  key={plano.id}
                  className="group relative flex min-h-[570px] flex-col overflow-hidden rounded-[22px] border bg-[#18181c] p-6 transition duration-200 hover:-translate-y-1 hover:shadow-2xl"
                  style={{
                    borderColor: atual ? tema.cor : `${tema.cor}66`,
                    backgroundImage: `linear-gradient(180deg, ${tema.cor}2E 0%, rgba(24,24,28,0.97) 48%, #18181c 100%)`,
                    boxShadow: atual ? `0 0 0 1px ${tema.cor}55, 0 22px 70px ${tema.cor}18` : undefined,
                  }}
                >
                  <div className="mb-7 h-7">
                    {selo && (
                      <span
                        className="inline-flex rounded-full px-3 py-1 text-xs font-black uppercase tracking-wide"
                        style={{
                          backgroundColor: atual ? "#F4F4F5" : tema.cor,
                          color: atual ? "#101014" : tema.texto,
                        }}
                      >
                        {selo}
                      </span>
                    )}
                  </div>

                  <div className="mb-3 flex items-center gap-3">
                    <h2 className="text-3xl font-black tracking-tight">{plano.vitrine.nome || plano.nome}</h2>
                    <div className="flex gap-1.5" aria-label={`Nível ${nivel}`}>
                      {Array.from({ length: nivel }, (_, ponto) => (
                        <span key={ponto} className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: tema.cor }} />
                      ))}
                    </div>
                  </div>

                  {preco ? (
                    <div className="mb-5 flex items-end gap-2">
                      <strong className="text-3xl font-black" style={{ color: tema.cor }}>
                        {dinheiro(preco.precoCentavos, preco.moeda)}
                      </strong>
                      <span className="pb-1 text-sm text-zinc-400">/ {preco.rotulo}</span>
                    </div>
                  ) : (
                    <p className="mb-5 text-lg text-zinc-500">Sem preço disponível</p>
                  )}

                  <div className="mb-5 h-px bg-white/10" />

                  <div className="flex-1 space-y-2.5">
                    {plano.vitrine.beneficios.map((beneficio, i) => (
                      <div key={`${beneficio.texto}-${i}`} className="flex items-start gap-2.5 text-[15px]">
                        <span
                          className="w-5 shrink-0 font-black"
                          style={{ color: beneficio.incluido ? tema.cor : "#71717A" }}
                        >
                          {beneficio.incluido ? "✓" : "–"}
                        </span>
                        <span className={beneficio.incluido ? "text-zinc-100" : "text-zinc-500"}>
                          {beneficio.texto}
                        </span>
                      </div>
                    ))}
                  </div>

                  <div className="mt-7">
                    {podeAssinar ? (
                      <Link
                        href={`/checkout?planoId=${encodeURIComponent(plano.id)}`}
                        className="flex h-12 w-full items-center justify-center rounded-xl text-base font-black transition group-hover:brightness-110"
                        style={{ backgroundColor: tema.cor, color: tema.texto }}
                      >
                        {rotuloAcao}
                      </Link>
                    ) : atual ? (
                      <div className="flex h-12 items-center justify-center text-sm font-semibold text-zinc-400">
                        Este é o seu plano
                      </div>
                    ) : assinaturaAtiva ? (
                      <div className="flex h-12 items-center justify-center text-sm font-semibold text-zinc-500">
                        Sem alteração disponível
                      </div>
                    ) : (
                      <div className="flex h-12 items-center justify-center text-sm font-semibold text-zinc-500">
                        Indisponível no momento
                      </div>
                    )}
                  </div>
                </article>
              );
            })}
          </section>
        )}

        <p className="mt-7 text-center text-xs text-zinc-600">
          Valores, disponibilidade e total final são confirmados pelo servidor no checkout.
        </p>
      </div>
    </main>
  );
}
