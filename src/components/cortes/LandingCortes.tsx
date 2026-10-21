"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import {
  CheckCircle2, ChevronDown, CreditCard, Download, Film, ListVideo, Mail, Monitor, Scissors, Sparkles,
} from "lucide-react";
import { LinkAssinatura } from "@/components/ui/LinkAssinatura";
import type { Instalador } from "@/config/downloads";
import { TONS_DOS_TEMAS, vitrineDoPlano, type BeneficioDaVitrine, type PlanoDaVitrine } from "@/lib/billing/vitrine";
import { PLANOS_CORTES } from "@/lib/planos";

type Preco = { id: string; rotulo: string; duracaoDias: number | null; duracaoMeses: number | null; precoCentavos: number; moeda: string };
type PlanoDaApi = { id: string; compravel: boolean; precos: Preco[]; vitrine: PlanoDaVitrine };
/** `null` enquanto carrega; depois, o que a API devolveu (só planos ativos). */
type Catalogo = Record<string, PlanoDaApi> | null;

const VENDIDOS = ["cortes-start", "cortes-pro"] as const;
const dinheiro = (centavos: number, moeda: string) =>
  new Intl.NumberFormat("pt-BR", { style: "currency", currency: moeda }).format(centavos / 100);
const duracao = (p: Preco) => p.duracaoDias ?? (p.duracaoMeses ?? 0) * 30;
/** Apresentação local, só quando o plano ainda não está à venda (fora da API). */
const vitrineLocal = (id: string) => vitrineDoPlano(PLANOS_CORTES.find((p) => p.id === id)!);

const COMO_FUNCIONA = [
  { icone: <Film size={20} />, titulo: "Abra o título", texto: "No aplicativo do Obaflix para Windows, abra o filme ou o episódio e toque em baixar." },
  { icone: <Scissors size={20} />, titulo: "Marque o trecho", texto: "Em “Trecho individual”, escolha o início e o fim da cena." },
  { icone: <Download size={20} />, titulo: "Baixe só a cena", texto: "O arquivo da cena é salvo no seu computador, sem baixar o título inteiro." },
];

const BENEFICIOS = [
  { icone: <Scissors size={20} />, titulo: "Só o trecho que importa", texto: "Guarde a cena que você quer em vez de um arquivo com o filme inteiro." },
  { icone: <ListVideo size={20} />, titulo: "Vários trechos de uma vez", texto: "No Cortes Pro, monte uma lista de cenas e baixe tudo em um único pedido." },
  { icone: <Film size={20} />, titulo: "Obaflix completo incluído", texto: "Filmes e séries do catálogo continuam disponíveis para assistir e baixar." },
  { icone: <CheckCircle2 size={20} />, titulo: "Soma ao seu plano", texto: "Já assina Básico, Plus ou Premium? O Cortes é à parte: um não cancela o outro." },
];

const PASSOS = [
  { icone: <CheckCircle2 size={18} />, titulo: "Escolha o plano", texto: "Start ou Pro, nesta página." },
  { icone: <CreditCard size={18} />, titulo: "Pague com Pix", texto: "O QR Code é gerado na hora. Não precisa criar conta antes." },
  { icone: <Mail size={18} />, titulo: "Receba o acesso por e-mail", texto: "Confirmado o pagamento, enviamos o link para você criar sua senha." },
  { icone: <Monitor size={18} />, titulo: "Use no aplicativo", texto: "Entre no app do Obaflix para Windows com seu e-mail e senha." },
];

const PERGUNTAS: [string, string][] = [
  ["Preciso ter conta no Obaflix para comprar?", "Não. A conta é criada com o e-mail informado na compra, depois que o pagamento é confirmado. Se o e-mail já tem conta no Obaflix, o plano é adicionado a ela e a sua senha continua a mesma."],
  ["Já assino Básico, Plus ou Premium. Posso assinar o Cortes?", "Sim. O Cortes é uma assinatura à parte e soma ao seu plano: contratar ou encerrar um não cancela o outro."],
  ["Onde os cortes são feitos?", "No aplicativo do Obaflix para Windows, na opção de download de filmes e episódios. Sua conta continua valendo nos outros aparelhos do Obaflix."],
  ["Qual a diferença entre o Start e o Pro?", "O Start baixa uma cena por vez (trecho individual). O Pro também permite montar uma lista de cenas e baixar todas de uma vez (lote)."],
  ["Como pago?", "Com Pix. O acesso é liberado quando o pagamento é confirmado pelo provedor; você não precisa ficar na página esperando."],
  ["A renovação é automática?", "Não. O Pix paga o período escolhido. Para continuar, renove em Minha conta antes do fim do período."],
  ["Não recebi o e-mail de acesso. E agora?", "Confira a caixa de spam. Na página de ativação você pode pedir um novo link para o mesmo e-mail."],
  ["E o Cortes AI?", "Está em desenvolvimento e ainda não está à venda. Nenhum recurso de inteligência artificial está disponível hoje."],
  ["O que acontece com o meu CPF?", "O CPF é exigido pelo meio de pagamento e é usado só para gerar o Pix. O Obaflix não o guarda."],
];

function Beneficio({ b, cor }: { b: BeneficioDaVitrine; cor: string }) {
  return (
    <li className="flex items-start gap-2.5 text-[15px]">
      <span className="w-5 shrink-0 font-black" style={{ color: b.incluido ? cor : "#71717A" }} aria-hidden>{b.incluido ? "✓" : "–"}</span>
      <span className={b.incluido ? "text-zinc-100" : "text-zinc-500"}>
        {b.texto}
        {!b.incluido && <span className="sr-only"> (não incluído)</span>}
      </span>
    </li>
  );
}

function CartaoDePlano({ id, catalogo }: { id: string; catalogo: Catalogo }) {
  const daApi = catalogo?.[id];
  const vitrine = daApi?.vitrine ?? vitrineLocal(id);
  const tom = TONS_DOS_TEMAS[vitrine.tema ?? "verde"];
  const preco = daApi?.compravel ? [...daApi.precos].sort((a, b) => duracao(a) - duracao(b))[0] : null;

  return (
    <article
      className="flex flex-col rounded-3xl border bg-[#18181c] p-6 sm:p-7"
      style={{ borderColor: `${tom.cor}66`, backgroundImage: `linear-gradient(180deg, ${tom.cor}24 0%, #18181c 50%)` }}
    >
      <div className="flex h-7 items-center">
        {vitrine.selo && (
          <span className="rounded-full px-3 py-1 text-xs font-black uppercase tracking-wide" style={{ backgroundColor: tom.cor, color: tom.texto }}>
            {vitrine.selo}
          </span>
        )}
      </div>
      <h3 className="mt-4 text-2xl font-black tracking-tight sm:text-3xl">{vitrine.nome}</h3>
      <div className="mt-3 min-h-[44px]">
        {catalogo === null ? (
          <div className="h-9 w-32 animate-pulse rounded-lg bg-white/10" />
        ) : preco ? (
          <p className="flex items-end gap-2">
            <strong className="text-3xl font-black" style={{ color: tom.cor }}>{dinheiro(preco.precoCentavos, preco.moeda)}</strong>
            <span className="pb-1 text-sm text-zinc-400">/ {preco.rotulo}</span>
          </p>
        ) : (
          <p className="text-lg font-semibold text-zinc-400">Preço em breve</p>
        )}
      </div>
      <div className="my-5 h-px bg-white/10" />
      <ul className="flex-1 space-y-2.5">
        {vitrine.beneficios.map((b, i) => <Beneficio key={`${b.texto}-${i}`} b={b} cor={tom.cor} />)}
      </ul>
      <div className="mt-7">
        {preco ? (
          <LinkAssinatura
            href={`/checkout?planoId=${encodeURIComponent(id)}&planoPrecoId=${encodeURIComponent(preco.id)}`}
            className="flex h-12 w-full items-center justify-center rounded-xl text-base font-black transition hover:brightness-110"
            style={{ backgroundColor: tom.cor, color: tom.texto }}
          >
            Assinar {vitrine.nome.replace("Obaflix ", "")}
          </LinkAssinatura>
        ) : (
          <div className="flex h-12 items-center justify-center rounded-xl border border-dashed border-white/15 text-sm font-semibold text-zinc-500">
            {catalogo === null ? "Carregando…" : "Vendas em breve"}
          </div>
        )}
      </div>
    </article>
  );
}

export function LandingCortes({ instalador }: { instalador: Instalador }) {
  const [catalogo, setCatalogo] = useState<Catalogo>(null);

  useEffect(() => {
    let vivo = true;
    fetch("/api/billing/plans", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : { planos: [] }))
      .then((dados) => {
        if (!vivo) return;
        const lista: PlanoDaApi[] = Array.isArray(dados?.planos) ? dados.planos : [];
        setCatalogo(Object.fromEntries(lista.filter((p) => p.vitrine?.familia === "cortes").map((p) => [p.id, p])));
      })
      .catch(() => { if (vivo) setCatalogo({}); });
    return () => { vivo = false; };
  }, []);

  const start = catalogo?.["cortes-start"]?.vitrine ?? vitrineLocal("cortes-start");
  const pro = catalogo?.["cortes-pro"]?.vitrine ?? vitrineLocal("cortes-pro");
  // Comparação montada dos próprios benefícios da vitrine: o que muda num muda aqui.
  const linhas = Array.from(new Set([...start.beneficios, ...pro.beneficios].map((b) => b.texto)));
  const marca = (v: PlanoDaVitrine, texto: string) => v.beneficios.find((b) => b.texto === texto)?.incluido === true;
  const ai = vitrineLocal("cortes-ai");

  return (
    <div data-obaflix-landing className="min-h-screen bg-zinc-950 text-white">
      <header className="fixed inset-x-0 top-0 z-50 border-b border-white/[0.06] bg-zinc-950/75 backdrop-blur-xl">
        <div className="mx-auto flex h-14 max-w-6xl items-center justify-between gap-3 px-4 sm:h-16 sm:px-6">
          <Link href="/cortes" className="flex items-baseline gap-2" aria-label="Obaflix Cortes">
            <span className="select-none text-xl font-black tracking-[-0.055em] text-red-600 sm:text-2xl">
              OBA<span className="text-white">FLIX</span>
            </span>
            <span className="text-sm font-bold uppercase tracking-[0.2em] text-emerald-400">Cortes</span>
          </Link>
          <nav className="flex items-center gap-2 sm:gap-3">
            <Link href="/login" className="rounded-full border border-white/15 px-3 py-2 text-xs font-semibold text-white transition hover:border-white/35 sm:px-4 sm:text-sm">
              Entrar
            </Link>
            <a href="#planos" className="rounded-full bg-emerald-400 px-3.5 py-2 text-xs font-bold text-emerald-950 transition hover:bg-emerald-300 sm:px-5 sm:text-sm">
              Ver planos
            </a>
          </nav>
        </div>
      </header>

      <main>
        <section className="relative overflow-hidden px-4 pb-14 pt-28 sm:px-6 sm:pb-20 sm:pt-36">
          <div aria-hidden className="pointer-events-none absolute inset-0 bg-[radial-gradient(90%_60%_at_20%_0%,rgba(52,211,153,0.18),transparent_60%),radial-gradient(70%_50%_at_90%_10%,rgba(229,9,20,0.18),transparent_60%)]" />
          <div className="relative mx-auto grid max-w-6xl items-center gap-12 lg:grid-cols-[1.1fr_0.9fr]">
            <div className="text-center lg:text-left">
              <span className="inline-flex items-center gap-2 rounded-full border border-emerald-400/30 bg-emerald-400/10 px-3 py-1 text-[11px] font-bold uppercase tracking-[0.18em] text-emerald-300">
                <Monitor size={13} /> No aplicativo para Windows
              </span>
              <h1 className="mt-5 text-4xl font-black leading-[1.05] tracking-tight sm:text-6xl">
                Baixe só a cena
                <span className="block bg-gradient-to-r from-emerald-300 via-cyan-300 to-red-400 bg-clip-text text-transparent">que você quer guardar</span>
              </h1>
              <p className="mx-auto mt-5 max-w-xl text-base leading-relaxed text-white/65 sm:text-lg lg:mx-0">
                Com o <strong className="text-white">Obaflix Cortes</strong> você escolhe o início e o fim de uma cena de filme ou série e baixa só esse trecho.
                No Cortes Pro, monte uma lista de cenas e baixe todas de uma vez.
              </p>
              <div className="mt-8 flex flex-col items-stretch justify-center gap-3 sm:flex-row lg:justify-start">
                <a href="#planos" className="inline-flex items-center justify-center rounded-xl bg-emerald-400 px-7 py-3.5 text-base font-black text-emerald-950 transition hover:bg-emerald-300">
                  Escolher plano
                </a>
                <a href="#como-funciona" className="inline-flex items-center justify-center rounded-xl border border-white/20 bg-white/5 px-7 py-3.5 text-base font-bold text-white transition hover:border-white/40">
                  Como funciona
                </a>
              </div>
            </div>

            {/* As duas opções do download no aplicativo, com os textos da própria interface. */}
            <div className="mx-auto w-full max-w-md rounded-3xl border border-white/10 bg-[#18181c]/90 p-5 shadow-2xl shadow-black/60" aria-label="Opções de corte no download do aplicativo">
              <p className="text-xs font-bold uppercase tracking-[0.18em] text-zinc-500">Download no aplicativo</p>
              <div className="mt-4 space-y-3">
                <div className="rounded-2xl border border-emerald-400/40 bg-emerald-400/10 p-4">
                  <p className="flex items-center gap-2 font-bold"><Scissors size={17} className="text-emerald-300" /> Trecho individual</p>
                  <p className="mt-1 text-sm text-zinc-300">Escolha início e fim e baixe só a cena.</p>
                  <p className="mt-2 text-xs font-semibold text-emerald-300">Cortes Start e Pro</p>
                </div>
                <div className="rounded-2xl border border-cyan-400/40 bg-cyan-400/10 p-4">
                  <p className="flex items-center gap-2 font-bold"><ListVideo size={17} className="text-cyan-300" /> Vários trechos (lote)</p>
                  <p className="mt-1 text-sm text-zinc-300">Monte uma lista de cenas e baixe tudo de uma vez.</p>
                  <p className="mt-2 text-xs font-semibold text-cyan-300">Cortes Pro</p>
                </div>
              </div>
            </div>
          </div>
        </section>

        <section id="como-funciona" className="scroll-mt-20 px-4 py-14 sm:px-6 sm:py-20">
          <div className="mx-auto max-w-6xl">
            <h2 className="text-3xl font-black tracking-tight sm:text-4xl">Como funciona</h2>
            <p className="mt-2 text-zinc-400">Tudo acontece no download do aplicativo do Obaflix para Windows.</p>
            <ol className="mt-8 grid gap-4 sm:grid-cols-3">
              {COMO_FUNCIONA.map((p, i) => (
                <li key={p.titulo} className="rounded-2xl border border-white/10 bg-white/[0.03] p-5">
                  <span className="inline-flex h-10 w-10 items-center justify-center rounded-xl bg-emerald-400/15 text-emerald-300">{p.icone}</span>
                  <p className="mt-4 text-xs font-bold uppercase tracking-[0.18em] text-zinc-500">Passo {i + 1}</p>
                  <h3 className="mt-1 text-lg font-bold">{p.titulo}</h3>
                  <p className="mt-1.5 text-sm leading-relaxed text-zinc-400">{p.texto}</p>
                </li>
              ))}
            </ol>
          </div>
        </section>

        <section className="px-4 py-14 sm:px-6 sm:py-20">
          <div className="mx-auto grid max-w-6xl gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {BENEFICIOS.map((b) => (
              <div key={b.titulo} className="rounded-2xl border border-white/10 bg-gradient-to-b from-white/[0.05] to-transparent p-5">
                <span className="text-emerald-300">{b.icone}</span>
                <h3 className="mt-3 font-bold">{b.titulo}</h3>
                <p className="mt-1.5 text-sm leading-relaxed text-zinc-400">{b.texto}</p>
              </div>
            ))}
          </div>
        </section>

        <section id="planos" className="scroll-mt-20 px-4 py-14 sm:px-6 sm:py-20">
          <div className="mx-auto max-w-6xl">
            <h2 className="text-3xl font-black tracking-tight sm:text-4xl">Planos</h2>
            <p className="mt-2 text-zinc-400">Pagamento por Pix. Valor final confirmado no checkout.</p>
            <div className="mt-8 grid gap-5 md:grid-cols-2">
              {VENDIDOS.map((id) => <CartaoDePlano key={id} id={id} catalogo={catalogo} />)}
            </div>

            <div className="mt-5 flex flex-col gap-3 rounded-3xl border border-dashed border-pink-400/30 bg-pink-400/[0.04] p-6 sm:flex-row sm:items-center">
              <Sparkles className="shrink-0 text-pink-300" size={24} />
              <div className="flex-1">
                <p className="font-bold">{ai.nome} <span className="ml-2 rounded-full bg-pink-400/20 px-2 py-0.5 text-xs font-bold text-pink-200">Em breve</span></p>
                <p className="mt-1 text-sm text-zinc-400">Recursos de inteligência artificial ainda em desenvolvimento. Não está à venda.</p>
              </div>
            </div>

            <div className="mt-10 overflow-x-auto rounded-2xl border border-white/10">
              <table className="w-full min-w-[480px] text-left text-sm">
                <caption className="sr-only">Comparação entre Cortes Start e Cortes Pro</caption>
                <thead className="bg-white/[0.04] text-zinc-300">
                  <tr>
                    <th scope="col" className="px-4 py-3 font-semibold">Recurso</th>
                    <th scope="col" className="px-4 py-3 text-center font-semibold">Start</th>
                    <th scope="col" className="px-4 py-3 text-center font-semibold">Pro</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/[0.06]">
                  {linhas.map((texto) => (
                    <tr key={texto}>
                      <th scope="row" className="px-4 py-3 font-normal text-zinc-200">{texto}</th>
                      {[start, pro].map((v, i) => (
                        <td key={i} className="px-4 py-3 text-center">
                          {marca(v, texto)
                            ? <span className="font-black text-emerald-300" aria-label="incluído">✓</span>
                            : <span className="text-zinc-600" aria-label="não incluído">–</span>}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </section>

        <section className="px-4 py-14 sm:px-6 sm:py-20">
          <div className="mx-auto max-w-6xl">
            <h2 className="text-3xl font-black tracking-tight sm:text-4xl">Da compra ao primeiro corte</h2>
            <ol className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              {PASSOS.map((p, i) => (
                <li key={p.titulo} className="rounded-2xl border border-white/10 bg-white/[0.03] p-5">
                  <p className="flex items-center gap-2 text-sm font-bold text-emerald-300">{p.icone} {i + 1}</p>
                  <h3 className="mt-2 font-bold">{p.titulo}</h3>
                  <p className="mt-1 text-sm text-zinc-400">{p.texto}</p>
                </li>
              ))}
            </ol>
          </div>
        </section>

        <section id="instalar" className="scroll-mt-20 px-4 py-14 sm:px-6 sm:py-20">
          <div className="mx-auto grid max-w-6xl gap-6 rounded-3xl border border-white/10 bg-gradient-to-r from-emerald-950/40 via-zinc-900/60 to-zinc-900/40 p-6 sm:p-10 lg:grid-cols-[1.2fr_0.8fr] lg:items-center">
            <div>
              <h2 className="text-2xl font-black sm:text-3xl">Instale o aplicativo para Windows</h2>
              <ol className="mt-4 list-decimal space-y-1.5 pl-5 text-zinc-300">
                <li>Baixe o instalador e abra o arquivo.</li>
                <li>Siga a instalação e abra o Obaflix.</li>
                <li>Entre com o e-mail da compra e a senha que você criou pelo link do e-mail.</li>
                <li>No download de um filme ou episódio, escolha o trecho.</li>
              </ol>
            </div>
            <div>
              {instalador.url ? (
                <a href={instalador.url} rel="noopener nofollow" className="flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-white text-base font-black text-zinc-950 transition hover:bg-white/90">
                  <Download size={18} /> Baixar para Windows
                </a>
              ) : (
                <button type="button" disabled aria-disabled className="h-12 w-full cursor-not-allowed rounded-xl border border-dashed border-white/20 bg-white/[0.04] text-sm font-semibold text-white/50">
                  Instalador com Cortes em preparação
                </button>
              )}
              {instalador.url && (instalador.versao || instalador.tamanho) && (
                <p className="mt-2 text-center text-xs text-zinc-500">{[instalador.versao, instalador.tamanho].filter(Boolean).join(" · ")}</p>
              )}
            </div>
          </div>
        </section>

        <section className="px-4 py-14 sm:px-6 sm:py-20">
          <div className="mx-auto max-w-3xl">
            <h2 className="text-3xl font-black tracking-tight sm:text-4xl">Perguntas frequentes</h2>
            <div className="mt-8 divide-y divide-white/[0.08] rounded-2xl border border-white/10">
              {PERGUNTAS.map(([pergunta, resposta]) => (
                <details key={pergunta} className="group px-5 py-4">
                  <summary className="flex cursor-pointer list-none items-center justify-between gap-4 font-semibold">
                    {pergunta}
                    <ChevronDown size={18} className="shrink-0 text-zinc-500 transition group-open:rotate-180" />
                  </summary>
                  <p className="mt-3 text-sm leading-relaxed text-zinc-400">{resposta}</p>
                </details>
              ))}
            </div>
          </div>
        </section>

        <section className="px-4 pb-16 pt-6 sm:px-6">
          <div className="mx-auto max-w-6xl rounded-3xl border border-emerald-400/20 bg-emerald-400/[0.06] p-6 text-center sm:p-10">
            <h2 className="text-2xl font-black sm:text-3xl">Pronto para guardar suas cenas?</h2>
            <a href="#planos" className="mt-5 inline-flex rounded-xl bg-emerald-400 px-7 py-3.5 font-black text-emerald-950 transition hover:bg-emerald-300">Escolher plano</a>
          </div>
        </section>
      </main>

      <footer className="border-t border-white/[0.06] px-4 py-8 text-xs text-zinc-500 sm:px-6">
        <div className="mx-auto flex max-w-6xl flex-col gap-2 sm:flex-row sm:justify-between">
          <p>Pagamento por Pix. Compra a partir de 18 anos. Valores em reais (BRL), sem renovação automática.</p>
          <p>
            <Link href="/" className="hover:text-zinc-300">Obaflix</Link>
            {" · "}
            <Link href="/excluir-conta" className="hover:text-zinc-300">Excluir conta</Link>
          </p>
        </div>
      </footer>
    </div>
  );
}
