"use client";

import Link from "next/link";
import { LinkAssinatura } from "@/components/ui/LinkAssinatura";
import { FormEvent, Suspense, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useSession } from "next-auth/react";
import {
  corpoCriarPedido,
  descricaoDaOperacao,
  deveFazerPolling,
  destinoDoLoginDoCheckout,
  mensagemErroCheckout,
} from "@/lib/billing/checkout";
import { MENSAGEM_DE_REVISAO_AO_COMPRADOR } from "@/lib/billing/revisao";

type Preco = {
  id: string;
  rotulo: string;
  duracaoDias: number | null;
  duracaoMeses: number | null;
  precoCentavos: number;
  moeda: string;
};

type Plano = {
  id: string;
  nome: string;
  precos: Preco[];
  adicionais?: {
    telaMensalCentavos: number | null;
    telasAdicionaisMax: number;
  };
  vitrine?: {
    nome?: string;
    tema?: "azul" | "roxo" | "ambar" | null;
    selo?: string | null;
    beneficios?: Array<{ texto: string; incluido: boolean }>;
  };
};

type Pendente = {
  pedidoId: string;
  status: string;
  valorCentavos: number;
  moeda: string;
  expiraEm: string;
  operacao?: string;
  creditoCentavos?: number;
  iniciaEm?: string;
  emRevisao?: boolean;
  mensagem?: string;
};

type Novo = Pendente & {
  pix: { qrCodeBase64?: string; copiaECola: string };
};

type Pedido = Pendente | Novo;

const TOM = {
  azul: { cor: "#4C8DFF", texto: "#FFFFFF" },
  roxo: { cor: "#A66BFF", texto: "#FFFFFF" },
  ambar: { cor: "#F5B82E", texto: "#1A1206" },
} as const;

const temPix = (pedido: Pedido): pedido is Novo => "pix" in pedido;

function dinheiro(centavos: number, moeda: string) {
  return new Intl.NumberFormat("pt-BR", { style: "currency", currency: moeda }).format(centavos / 100);
}

function duracaoAproximada(preco: Preco) {
  return preco.duracaoDias ?? ((preco.duracaoMeses ?? 0) * 30);
}

function mesesDeComparacao(preco: Preco) {
  if (preco.duracaoMeses && preco.duracaoMeses > 0) return preco.duracaoMeses;
  if (preco.duracaoDias && preco.duracaoDias >= 30 && preco.duracaoDias % 30 === 0) {
    return preco.duracaoDias / 30;
  }
  return null;
}

function mesesCobraveisDeTelas(preco: Preco | null) {
  if (!preco) return null;
  if (preco.duracaoMeses && preco.duracaoMeses > 0) return preco.duracaoMeses;
  return preco.duracaoDias === 30 ? 1 : null;
}

function promocaoDaDuracao(plano: Plano, preco: Preco) {
  const meses = mesesDeComparacao(preco);
  if (!meses || meses <= 1) return null;

  const mensal = plano.precos.find(
    (item) =>
      item.moeda === preco.moeda &&
      (item.duracaoMeses === 1 || item.duracaoDias === 30),
  );
  if (!mensal) return null;

  const referenciaCentavos = mensal.precoCentavos * meses;
  if (referenciaCentavos <= preco.precoCentavos) return null;

  const economiaCentavos = referenciaCentavos - preco.precoCentavos;
  const percentual = Math.round((economiaCentavos / referenciaCentavos) * 100);
  if (percentual <= 0) return null;

  return { referenciaCentavos, economiaCentavos, percentual };
}

function CheckoutConteudo() {
  const query = useSearchParams();
  const router = useRouter();
  const { data: sessao, status } = useSession();

  const [pedido, setPedido] = useState<Pedido | null>(null);
  const [plano, setPlano] = useState<Plano | null>(null);
  const [precoId, setPrecoId] = useState<string | null>(null);
  const [nome, setNome] = useState("");
  const [telefone, setTelefone] = useState("");
  const [documento, setDocumento] = useState("");
  const [telas, setTelas] = useState(0);
  const [erro, setErro] = useState("");
  const [carregandoCatalogo, setCarregandoCatalogo] = useState(true);
  const [carregandoPedido, setCarregandoPedido] = useState(true);
  const [confirmado, setConfirmado] = useState(false);
  const [enviando, setEnviando] = useState(false);

  const planoId = query.get("planoId");
  const precoDaUrl = query.get("planoPrecoId");

  useEffect(() => {
    if (status === "unauthenticated") {
      router.replace(destinoDoLoginDoCheckout(query.toString()));
    }
  }, [status, query, router]);

  useEffect(() => {
    const nomeDaConta = sessao?.user?.name?.trim();
    if (nomeDaConta && !nome) setNome(nomeDaConta);
  }, [sessao?.user?.name, nome]);

  useEffect(() => {
    let ativo = true;
    fetch("/api/billing/plans", { cache: "no-store" })
      .then(async (r) => {
        if (!r.ok) throw new Error("catalogo");
        return r.json();
      })
      .then((dados) => {
        if (!ativo) return;
        const encontrado = Array.isArray(dados?.planos)
          ? dados.planos.find((item: Plano) => item.id === planoId)
          : null;
        if (!encontrado) {
          setPlano(null);
          return;
        }

        setPlano(encontrado);
        const escolhido =
          encontrado.precos.find((item: Preco) => item.id === precoDaUrl) ??
          [...encontrado.precos].sort(
            (a: Preco, b: Preco) => duracaoAproximada(a) - duracaoAproximada(b),
          )[0] ??
          null;
        setPrecoId(escolhido?.id ?? null);
      })
      .catch(() => {
        if (ativo) setErro("Não foi possível carregar este plano.");
      })
      .finally(() => {
        if (ativo) setCarregandoCatalogo(false);
      });

    return () => {
      ativo = false;
    };
  }, [planoId, precoDaUrl]);

  useEffect(() => {
    if (status !== "authenticated") return;

    let ativo = true;
    fetch("/api/billing/orders/pending", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((dados) => {
        if (ativo && dados?.pedido) setPedido(dados.pedido);
      })
      .catch(() => {})
      .finally(() => {
        if (ativo) setCarregandoPedido(false);
      });

    return () => {
      ativo = false;
    };
  }, [status]);

  useEffect(() => {
    if (!pedido || !(deveFazerPolling(pedido.status) || pedido.emRevisao)) return;
    const intervalo = window.setInterval(
      () =>
        fetch(`/api/billing/orders/${pedido.pedidoId}`, { cache: "no-store" })
          .then((r) => (r.ok ? r.json() : null))
          .then((dados) => {
            if (dados) setPedido((atual) => (atual ? { ...atual, ...dados } : atual));
          })
          .catch(() => {}),
      pedido.emRevisao ? 30000 : 10000,
    );
    return () => window.clearInterval(intervalo);
  }, [pedido]);

  useEffect(() => {
    if (pedido?.status !== "PAGO") return;
    fetch("/api/billing/me", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((dados) => setConfirmado(Boolean(dados?.plano?.id && dados.plano.id === planoId)))
      .catch(() => setConfirmado(false));
  }, [pedido?.status, planoId]);

  const preco = useMemo(
    () => plano?.precos.find((item) => item.id === precoId) ?? null,
    [plano, precoId],
  );

  useEffect(() => {
    setTelas(0);
  }, [precoId]);

  const temaNome = plano?.vitrine?.tema;
  const tema = temaNome && temaNome in TOM ? TOM[temaNome as keyof typeof TOM] : { cor: "#C4C4C4", texto: "#101014" };
  const telaMensal = plano?.adicionais?.telaMensalCentavos ?? null;
  const limiteTelas = telaMensal !== null ? plano?.adicionais?.telasAdicionaisMax ?? 0 : 0;
  const mesesDeTelas = mesesCobraveisDeTelas(preco) ?? 0;
  const telasPermitidasNestaDuracao = mesesDeTelas > 0 && telaMensal !== null && limiteTelas > 0;
  const promocao = plano && preco ? promocaoDaDuracao(plano, preco) : null;

  const subtotal = useMemo(() => {
    if (!preco) return null;
    if (!telas || !telasPermitidasNestaDuracao || telaMensal === null || mesesDeTelas <= 0) {
      return preco.precoCentavos;
    }
    return preco.precoCentavos + telaMensal * telas * mesesDeTelas;
  }, [preco, telas, telasPermitidasNestaDuracao, telaMensal, mesesDeTelas]);

  async function criarPedido(evento: FormEvent) {
    evento.preventDefault();
    if (!plano || !preco) return;

    setErro("");
    setEnviando(true);
    try {
      const resposta = await fetch("/api/billing/orders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          corpoCriarPedido(
            plano.id,
            preco.id,
            { nome, telefone, documento },
            { telasAdicionais: telas },
          ),
        ),
      });
      const dados = await resposta.json().catch(() => null);
      if (!resposta.ok) {
        if (dados?.codigo === "pagamento_em_revisao") {
          fetch("/api/billing/orders/pending", { cache: "no-store" })
            .then((r) => (r.ok ? r.json() : null))
            .then((pendente) => {
              if (pendente?.pedido) setPedido(pendente.pedido);
            })
            .catch(() => {});
        }
        setErro(mensagemErroCheckout(dados?.codigo));
        return;
      }
      setPedido(dados);
    } finally {
      setEnviando(false);
    }
  }

  const fundo = {
    backgroundImage: `radial-gradient(ellipse at top, ${tema.cor}24 0%, transparent 56%)`,
  };

  if (pedido?.emRevisao) {
    return (
      <main className="min-h-screen bg-[#101014] px-5 pb-12 pt-24 text-white" style={fundo}>
        <div className="mx-auto max-w-3xl rounded-3xl border border-white/10 bg-[#18181c] p-8">
          <p className="text-sm font-bold uppercase tracking-widest" style={{ color: tema.cor }}>Obaflix</p>
          <h1 className="mt-2 text-3xl font-black">Pagamento em análise</h1>
          <p className="mt-4 text-zinc-300">{MENSAGEM_DE_REVISAO_AO_COMPRADOR}</p>
          <p className="mt-5 text-2xl font-black">{dinheiro(pedido.valorCentavos, pedido.moeda)}</p>
          <Link href="/conta" className="mt-7 inline-block underline">Ir para minha conta</Link>
        </div>
      </main>
    );
  }

  if (status !== "authenticated" || carregandoCatalogo || carregandoPedido) {
    return <main className="min-h-screen bg-[#101014] p-24 text-white">Carregando checkout…</main>;
  }

  if (pedido) {
    const operacao = descricaoDaOperacao(pedido);
    return (
      <main className="min-h-screen bg-[#101014] px-5 pb-12 pt-24 text-white" style={fundo}>
        <div className="mx-auto max-w-4xl rounded-3xl border border-white/10 bg-[#18181c] p-8">
          <p className="text-sm font-bold uppercase tracking-widest" style={{ color: tema.cor }}>Pagamento Obaflix</p>
          <h1 className="mt-2 text-3xl font-black">
            {pedido.status === "PAGO" ? "Assinatura ativada" : "Pagamento pendente"}
          </h1>
          <p className="mt-2 text-zinc-400">Status: {pedido.status}</p>
          <p className="mt-4 text-3xl font-black">{dinheiro(pedido.valorCentavos, pedido.moeda)}</p>
          {operacao && <p className="mt-2 text-sm text-zinc-300">{operacao}</p>}

          {pedido.status === "PAGO" ? (
            <div className="mt-7">
              <p className="text-zinc-300">{confirmado ? "Seu plano foi atualizado." : "Confirmando seu plano…"}</p>
              <Link
                href="/conta"
                className="mt-5 inline-flex rounded-xl px-5 py-3 font-bold"
                style={{ backgroundColor: tema.cor, color: tema.texto }}
              >
                Ir para minha conta
              </Link>
              <LinkAssinatura href="/planos" className="ml-4 text-sm underline">Ver planos</LinkAssinatura>
            </div>
          ) : temPix(pedido) ? (
            <div className="mt-7 grid gap-6 md:grid-cols-[240px_1fr]">
              {pedido.pix.qrCodeBase64 && (
                <img
                  className="h-60 w-60 rounded-2xl bg-white p-3"
                  alt="QR Code PIX"
                  src={`data:image/png;base64,${pedido.pix.qrCodeBase64}`}
                />
              )}
              <div>
                <p className="mb-2 text-sm font-semibold text-zinc-300">PIX copia e cola</p>
                <textarea
                  readOnly
                  value={pedido.pix.copiaECola}
                  className="h-32 w-full resize-none rounded-xl border border-white/10 bg-black/30 p-3 text-xs text-zinc-200"
                />
                <button
                  className="mt-3 rounded-xl px-5 py-3 font-bold"
                  style={{ backgroundColor: tema.cor, color: tema.texto }}
                  onClick={() => navigator.clipboard.writeText(pedido.pix.copiaECola)}
                >
                  Copiar PIX
                </button>
              </div>
            </div>
          ) : (
            <p className="mt-7 text-sm text-zinc-400">
              Já existe um pagamento pendente. Volte à sessão em que o PIX foi gerado ou aguarde a confirmação.
            </p>
          )}
          <p className="mt-5 text-sm text-zinc-500">
            Expira em {new Date(pedido.expiraEm).toLocaleString("pt-BR")}. A confirmação vem do servidor.
          </p>
        </div>
      </main>
    );
  }

  if (!plano || plano.precos.length === 0) {
    return (
      <main className="min-h-screen bg-[#101014] px-5 pt-24 text-white">
        <div className="mx-auto max-w-3xl rounded-2xl border border-white/10 bg-white/5 p-8">
          <h1 className="text-2xl font-black">Plano indisponível</h1>
          <p className="mt-2 text-zinc-400">Volte à vitrine e escolha um plano disponível.</p>
          <LinkAssinatura href="/planos" className="mt-5 inline-block underline">Voltar aos planos</LinkAssinatura>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-[#101014] px-5 pb-14 pt-20 text-white md:px-8" style={fundo}>
      <div className="mx-auto max-w-6xl">
        <LinkAssinatura href="/planos" className="text-sm font-semibold text-zinc-400 hover:text-white">← Voltar aos planos</LinkAssinatura>

        <header className="mt-6">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-3xl font-black md:text-4xl">{plano.vitrine?.nome || plano.nome}</h1>
            {plano.vitrine?.selo && (
              <span
                className="rounded-full px-3 py-1 text-xs font-black uppercase tracking-wide"
                style={{ backgroundColor: tema.cor, color: tema.texto }}
              >
                {plano.vitrine.selo}
              </span>
            )}
          </div>
          <p className="mt-2 text-zinc-400">Configure sua assinatura e gere o PIX com o valor final calculado pelo servidor.</p>
        </header>

        <form onSubmit={criarPedido} className="mt-8 grid gap-7 lg:grid-cols-[1.35fr_0.65fr]">
          <div className="space-y-7">
            <section className="rounded-3xl border border-white/10 bg-[#18181c]/95 p-6">
              <div className="mb-5 flex items-center justify-between gap-4">
                <div>
                  <p className="text-xs font-black uppercase tracking-[0.18em]" style={{ color: tema.cor }}>1. Período</p>
                  <h2 className="mt-1 text-xl font-black">Escolha por quanto tempo</h2>
                </div>
              </div>

              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {plano.precos.map((item) => {
                  const promo = promocaoDaDuracao(plano, item);
                  const selecionado = item.id === precoId;
                  return (
                    <button
                      type="button"
                      key={item.id}
                      onClick={() => setPrecoId(item.id)}
                      className="relative min-h-32 rounded-2xl border p-4 text-left transition hover:bg-white/[0.04]"
                      style={{
                        borderColor: selecionado ? tema.cor : "rgba(255,255,255,0.10)",
                        backgroundColor: selecionado ? `${tema.cor}14` : "rgba(255,255,255,0.02)",
                      }}
                    >
                      {promo && (
                        <span
                          className="absolute right-3 top-3 rounded-full px-2.5 py-1 text-[11px] font-black"
                          style={{ backgroundColor: tema.cor, color: tema.texto }}
                        >
                          -{promo.percentual}%
                        </span>
                      )}
                      <p className="pr-16 text-sm font-bold text-zinc-300">{item.rotulo}</p>
                      {promo && (
                        <p className="mt-4 text-xs text-zinc-500 line-through">
                          {dinheiro(promo.referenciaCentavos, item.moeda)}
                        </p>
                      )}
                      <p className={promo ? "mt-1 text-2xl font-black" : "mt-7 text-2xl font-black"} style={{ color: tema.cor }}>
                        {dinheiro(item.precoCentavos, item.moeda)}
                      </p>
                      {promo && (
                        <p className="mt-1 text-xs font-semibold text-emerald-400">
                          Economize {dinheiro(promo.economiaCentavos, item.moeda)}
                        </p>
                      )}
                    </button>
                  );
                })}
              </div>
            </section>

            {limiteTelas > 0 && telaMensal !== null && (
              <section className="rounded-3xl border border-white/10 bg-[#18181c]/95 p-6">
                <p className="text-xs font-black uppercase tracking-[0.18em]" style={{ color: tema.cor }}>2. Telas adicionais</p>
                <div className="mt-1 flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
                  <h2 className="text-xl font-black">Quer adicionar mais telas?</h2>
                  <p className="text-sm text-zinc-400">
                    {dinheiro(telaMensal, preco?.moeda ?? "BRL")} por tela/mês
                  </p>
                </div>

                {telasPermitidasNestaDuracao ? (
                  <div className="mt-5 flex flex-wrap gap-3">
                    {Array.from({ length: limiteTelas + 1 }, (_, quantidade) => (
                      <button
                        type="button"
                        key={quantidade}
                        onClick={() => setTelas(quantidade)}
                        className="rounded-xl border px-4 py-3 text-sm font-bold transition"
                        style={{
                          borderColor: telas === quantidade ? tema.cor : "rgba(255,255,255,0.10)",
                          backgroundColor: telas === quantidade ? `${tema.cor}18` : "rgba(255,255,255,0.02)",
                          color: telas === quantidade ? tema.cor : "#D4D4D8",
                        }}
                      >
                        {quantidade === 0
                          ? "Sem adicional"
                          : `+${quantidade} tela${quantidade > 1 ? "s" : ""}`}
                      </button>
                    ))}
                  </div>
                ) : (
                  <p className="mt-4 text-sm text-zinc-500">
                    Telas adicionais não estão disponíveis para esta duração.
                  </p>
                )}
                <p className="mt-4 text-xs text-zinc-500">
                  Limite deste checkout: até {limiteTelas} telas adicionais. O servidor confirma disponibilidade e valor.
                </p>
              </section>
            )}

            <section className="rounded-3xl border border-white/10 bg-[#18181c]/95 p-6">
              <p className="text-xs font-black uppercase tracking-[0.18em]" style={{ color: tema.cor }}>3. Dados do pagador</p>
              <h2 className="mt-1 text-xl font-black">Informações para o pagamento</h2>

              <div className="mt-5 grid gap-4 sm:grid-cols-2">
                <label className="text-sm font-semibold text-zinc-300 sm:col-span-2">
                  Nome completo
                  <input
                    value={nome}
                    onChange={(e) => setNome(e.target.value)}
                    autoComplete="name"
                    required
                    className="mt-2 w-full rounded-xl border border-white/10 bg-black/25 px-4 py-3 text-white outline-none focus:border-white/30"
                  />
                </label>

                <label className="text-sm font-semibold text-zinc-300">
                  CPF ou CNPJ
                  <input
                    value={documento}
                    onChange={(e) => setDocumento(e.target.value)}
                    placeholder="Somente números ou formatado"
                    inputMode="numeric"
                    required
                    className="mt-2 w-full rounded-xl border border-white/10 bg-black/25 px-4 py-3 text-white outline-none focus:border-white/30"
                  />
                </label>

                <label className="text-sm font-semibold text-zinc-300">
                  E-mail da conta
                  <input
                    value={sessao?.user?.email ?? ""}
                    readOnly
                    className="mt-2 w-full cursor-not-allowed rounded-xl border border-white/10 bg-black/15 px-4 py-3 text-zinc-400"
                  />
                </label>

                <label className="text-sm font-semibold text-zinc-300 sm:col-span-2">
                  Telefone com DDD
                  <input
                    value={telefone}
                    onChange={(e) => setTelefone(e.target.value)}
                    autoComplete="tel"
                    inputMode="tel"
                    required
                    placeholder="(00) 00000-0000"
                    className="mt-2 w-full rounded-xl border border-white/10 bg-black/25 px-4 py-3 text-white outline-none focus:border-white/30"
                  />
                </label>
              </div>
            </section>
          </div>

          <aside className="lg:sticky lg:top-20 lg:h-fit">
            <div
              className="overflow-hidden rounded-3xl border bg-[#18181c]"
              style={{
                borderColor: `${tema.cor}70`,
                backgroundImage: `linear-gradient(180deg, ${tema.cor}24 0%, #18181c 52%)`,
              }}
            >
              <div className="p-6">
                <p className="text-xs font-black uppercase tracking-[0.18em]" style={{ color: tema.cor }}>Resumo</p>
                <h2 className="mt-2 text-2xl font-black">{plano.vitrine?.nome || plano.nome}</h2>

                {preco && (
                  <>
                    <div className="mt-6 flex items-end justify-between gap-3 border-b border-white/10 pb-5">
                      <div>
                        <p className="text-sm text-zinc-400">{preco.rotulo}</p>
                        {promocao && (
                          <p className="mt-1 text-xs text-zinc-500 line-through">
                            {dinheiro(promocao.referenciaCentavos, preco.moeda)}
                          </p>
                        )}
                      </div>
                      <p className="text-2xl font-black" style={{ color: tema.cor }}>
                        {dinheiro(preco.precoCentavos, preco.moeda)}
                      </p>
                    </div>

                    {telas > 0 && telaMensal !== null && mesesDeTelas > 0 && (
                      <div className="flex items-center justify-between gap-3 border-b border-white/10 py-5 text-sm">
                        <span className="text-zinc-400">
                          +{telas} tela{telas > 1 ? "s" : ""} × {mesesDeTelas} mês{mesesDeTelas > 1 ? "es" : ""}
                        </span>
                        <span className="font-bold">
                          {dinheiro(telaMensal * telas * mesesDeTelas, preco.moeda)}
                        </span>
                      </div>
                    )}

                    <div className="py-5">
                      <p className="text-xs text-zinc-500">Subtotal antes de créditos ou mudança de plano</p>
                      <p className="mt-1 text-3xl font-black">
                        {subtotal !== null ? dinheiro(subtotal, preco.moeda) : "—"}
                      </p>
                    </div>
                  </>
                )}

                {erro && (
                  <div className="mb-4 rounded-xl border border-red-500/20 bg-red-500/10 p-3 text-sm text-red-200">
                    {erro}
                  </div>
                )}

                <button
                  type="submit"
                  disabled={!preco || enviando}
                  className="flex h-13 w-full items-center justify-center rounded-xl px-5 py-3.5 text-base font-black transition disabled:cursor-not-allowed disabled:opacity-50"
                  style={{ backgroundColor: tema.cor, color: tema.texto }}
                >
                  {enviando ? "Gerando PIX…" : "Gerar PIX"}
                </button>

                <p className="mt-4 text-xs leading-relaxed text-zinc-500">
                  O servidor recalcula duração, telas, crédito de upgrade e total antes de criar a cobrança. Nenhum valor desta tela é enviado como autoridade.
                </p>
              </div>
            </div>
          </aside>
        </form>
      </div>
    </main>
  );
}

export default function CheckoutPage() {
  return (
    <Suspense fallback={<main className="min-h-screen bg-[#101014] p-24 text-white">Carregando checkout…</main>}>
      <CheckoutConteudo />
    </Suspense>
  );
}
