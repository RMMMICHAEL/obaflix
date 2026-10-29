"use client";

import Link from "next/link";
import { ChangeEvent, FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useSession } from "next-auth/react";
import QRCode from "qrcode";
import { Check, ShieldCheck, Scissors, ArrowRight } from "lucide-react";
import { corpoCriarPedido, descricaoDaOperacao, deveFazerPolling, mensagemErroCheckout } from "@/lib/billing/checkout";
import { emailDoComprador, cpfValido, telefoneBrasileiroValido, nomeCompletoValido, IDADE_MINIMA_COMPRA, soDigitos } from "@/lib/billing/pagador";
import { mascararCheckout } from "@/lib/billing/mascarasCheckout";
import { enviarEventoMeta } from "@/lib/metaPixelCortes";
import { MENSAGEM_DE_REVISAO_AO_COMPRADOR } from "@/lib/billing/revisao";

type Preco = { id: string; rotulo: string; duracaoDias: number | null; duracaoMeses: number | null; precoCentavos: number; moeda: string };
type Plano = { id: string; nome: string; compravel: boolean; precos: Preco[] };
type Pedido = {
  pedidoId: string; status: string; valorCentavos: number; moeda: string; expiraEm: string;
  operacao?: string; creditoCentavos?: number; iniciaEm?: string; emRevisao?: boolean;
  pix?: { copiaECola: string }; tokenConsulta?: string;
};
const planos = {
  "cortes-start": { nome: "Start", subtitulo: "Encontre a cena, marque início e fim e exporte um trecho de cada vez.", beneficios: ["Marcação de início e fim no player", "Prévia para revisar antes de exportar", "Exportação de trechos individuais", "Aplicativo Windows"] },
  "cortes-pro": { nome: "Pro", subtitulo: "Organize uma sequência de cenas para a edição.", beneficios: ["Tudo do Start", "Lista de múltiplos trechos", "Exportação em lote", "Aplicativo Windows"] },
  "cortes-ai": { nome: "AI", subtitulo: "Receba sugestões de momentos a partir das legendas e do tema.", beneficios: ["Tudo do Pro", "Sugestões por tema ou roteiro", "Revisão dos trechos sugeridos", "Limites de análises previstos no plano"] },
} as const;
type Id = keyof typeof planos;
const dinheiro = (n: number, moeda = "BRL") => new Intl.NumberFormat("pt-BR", { style: "currency", currency: moeda }).format(n / 100);
// Planos Cortes pela Cakto: preco base + taxa de servico Pix de R$ 0,99.
const precosCakto: Record<Id, number> = { "cortes-start": 2700, "cortes-pro": 4700, "cortes-ai": 19700 };
const taxaPixCakto = (valor: number, id: Id | null) => id && valor === precosCakto[id] ? 99 : 0;
const totalPix = (valor: number, id: Id | null) => valor + taxaPixCakto(valor, id);
const prazo = (p: Preco) => p.duracaoMeses ? `${p.duracaoMeses} ${p.duracaoMeses === 1 ? "mês" : "meses"}` : `${p.duracaoDias ?? 0} dias`;
// Gatilho único para eventuais destinos reais de pós-compra; vazio nesta fase.
// Nunca usar URL vinda do cliente ou de parâmetros de consulta como destino.
const DESTINOS_APROVADOS: Partial<Record<Id, string>> = {};
const classeInput = "mt-1.5 block w-full rounded-xl border border-white/15 bg-black/25 px-4 py-3 text-base text-white outline-none focus:border-red-400";

export function CheckoutCortes({ vendasPublicas, instaladorUrl }: { vendasPublicas: boolean; instaladorUrl: string }) {
  const query = useSearchParams(), router = useRouter();
  const { data: sessao, status: sessaoStatus } = useSession();
  const rawId = query.get("planoId");
  const id: Id | null = rawId && Object.prototype.hasOwnProperty.call(planos, rawId) ? rawId as Id : null;
  const conta = query.get("conta") === "1";
  const [plano, setPlano] = useState<Plano | null>(null);
  const [precoId, setPrecoId] = useState("");
  const [carregando, setCarregando] = useState(true);
  const [nome, setNome] = useState("");
  const [cpf, setCpf] = useState("");
  const [telefone, setTelefone] = useState("");
  const [email, setEmail] = useState("");
  const [nascimento, setNascimento] = useState("");
  const [pedido, setPedido] = useState<Pedido | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [erro, setErro] = useState("");
  const [enviando, setEnviando] = useState(false);
  const [travarNovaTentativa, setTravarNovaTentativa] = useState(false);
  const [copiado, setCopiado] = useState(false);
  const envioEmCurso = useRef(false);
  const visitante = sessaoStatus === "unauthenticated" && !conta;
  const admin = sessaoStatus === "authenticated" && (sessao?.user as { role?: string } | undefined)?.role === "admin";
  const pilotoAdmin = !vendasPublicas && id === "cortes-start" && admin;
  const podeComprar = vendasPublicas || pilotoAdmin;

  function atualizarMascara(event: ChangeEvent<HTMLInputElement>, campo: "cpf" | "telefone") {
    const input = event.currentTarget;
    const resultado = mascararCheckout(campo, input.value, input.selectionStart ?? input.value.length,
      (event.nativeEvent as InputEvent).inputType, campo === "cpf" ? cpf : telefone);
    input.value = resultado.valor;
    input.setSelectionRange(resultado.cursor, resultado.cursor);
    (campo === "cpf" ? setCpf : setTelefone)(resultado.valor);
  }

  useEffect(() => {
    if (sessaoStatus === "unauthenticated" && conta) {
      const destino = `/cortes/checkout?${query.toString()}`;
      router.replace(`/login?callbackUrl=${encodeURIComponent(destino)}`);
    }
  }, [conta, query, router, sessaoStatus]);
  useEffect(() => {
    const nomeDaConta = sessao?.user?.name;
    if (nomeDaConta) setNome(atual => atual || nomeDaConta);
  }, [sessao?.user?.name]);
  useEffect(() => {
    let ativo = true;
    setCarregando(true);
    fetch("/api/billing/plans", { cache: "no-store" })
      .then(r => r.ok ? r.json() : Promise.reject())
      .then(data => {
        if (!ativo) return;
        const encontrado = (Array.isArray(data?.planos) ? data.planos : []).find((p: Plano) => p.id === id) ?? null;
        setPlano(encontrado);
        const preco = encontrado?.precos?.find((p: Preco) => p.id === query.get("planoPrecoId")) ?? encontrado?.precos?.[0];
        setPrecoId(preco?.id ?? "");
      }).catch(() => { if (ativo) setErro("Não foi possível carregar o plano. Atualize a página."); })
      .finally(() => { if (ativo) setCarregando(false); });
    return () => { ativo = false; };
  }, [id, query]);
  // Consulta de pedidos anteriores de contas autenticadas, sem expor cobranças de outros usuários.
  useEffect(() => {
    if (sessaoStatus !== "authenticated" || pedido) return;
    let ativo = true;
    fetch("/api/billing/orders/pending", { cache: "no-store" }).then(r => r.ok ? r.json() : null)
      .then(data => { if (ativo && data?.pedido) setPedido(data.pedido); }).catch(() => {});
    return () => { ativo = false; };
  }, [sessaoStatus, pedido]);
  const preco = useMemo(() => plano?.precos?.find(p => p.id === precoId) ?? null, [plano, precoId]);
  const nascimentoMax = useMemo(() => {
    const d = new Date(); d.setFullYear(d.getFullYear() - IDADE_MINIMA_COMPRA);
    return d.toISOString().slice(0, 10);
  }, []);
  useEffect(() => {
    if (!pedido?.pix?.copiaECola) { setQr(null); return; }
    let ativo = true;
    QRCode.toDataURL(pedido.pix.copiaECola, { width: 256, margin: 2 })
      .then(src => { if (ativo) setQr(src); }).catch(() => { if (ativo) setQr(null); });
    return () => { ativo = false; };
  }, [pedido?.pix?.copiaECola]);
  useEffect(() => {
    if (!pedido || !deveFazerPolling(pedido.status)) return;
    const consultar = async () => {
      try {
        const guest = visitante && !!pedido.tokenConsulta;
        if (visitante && !guest) return;
        const r = guest
          ? await fetch("/api/billing/orders/guest-status", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pedidoId: pedido.pedidoId, token: pedido.tokenConsulta }), cache: "no-store" })
          : await fetch(`/api/billing/orders/${encodeURIComponent(pedido.pedidoId)}`, { cache: "no-store" });
        if (r.ok) { const atualizado = await r.json(); setPedido(atual => atual ? { ...atual, ...atualizado } : atual); }
      } catch { /* Confirmação segue no backend; falha de rede não cria novo Pix. */ }
    };
    const timer = window.setInterval(consultar, 15000);
    return () => window.clearInterval(timer);
  }, [pedido?.pedidoId, pedido?.status, pedido?.tokenConsulta, visitante]);

  async function gerarPix(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!id || !preco || !podeComprar || enviando || envioEmCurso.current || travarNovaTentativa) return;
    setErro("");
    if (!nomeCompletoValido(nome)) { setErro("Digite seu nome completo, com nome e sobrenome."); return; }
    if (!cpfValido(cpf)) { setErro("Confira o CPF: ele precisa ser válido."); return; }
    if (!telefoneBrasileiroValido(telefone)) { setErro("Informe um telefone brasileiro com DDD válido."); return; }
    if (visitante && !emailDoComprador(email)) { setErro("Informe um e-mail válido para receber seu acesso."); return; }
    if (visitante && (!nascimento || nascimento > nascimentoMax)) { setErro("A compra exige uma data de nascimento válida e idade mínima de 18 anos."); return; }
    envioEmCurso.current = true; setEnviando(true);
    try {
      const r = await fetch("/api/billing/orders", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(corpoCriarPedido(id, preco.id, { nome, telefone: soDigitos(telefone), documento: soDigitos(cpf) }, visitante ? { email, nascimento } : {})),
      });
      const data = await r.json().catch(() => null);
      if (!r.ok) {
        setErro(mensagemErroCheckout(data?.codigo));
        if (r.status === 502 || data?.codigo === "pagamento_em_revisao") setTravarNovaTentativa(true);
        return;
      }
      setPedido(data);
      if (data?.pix?.copiaECola) enviarEventoMeta("AddPaymentInfo", { content_ids: [id ?? "cortes"], content_type: "product", currency: "BRL", value: data.valorCentavos / 100 }, "pix_" + data.pedidoId);
    } catch {
      // Rede incerta: o servidor pode ter criado o Pix, então não tentar novamente sem consulta.
      setErro("Não foi possível verificar se o Pix foi criado. Não tente de novo agora; entre em contato com o suporte.");
      setTravarNovaTentativa(true);
    } finally { envioEmCurso.current = false; setEnviando(false); }
  }

  // Purchase só com PAGO vindo do backend; eventID=pedidoId e sessionStorage evitam repetição.
  useEffect(() => {
    if (pedido?.status !== "PAGO") return;
    const marca = "meta_purchase_" + pedido.pedidoId;
    try { if (sessionStorage.getItem(marca)) return; sessionStorage.setItem(marca, "1"); } catch {}
    enviarEventoMeta("Purchase", { content_ids: [id ?? "cortes"], content_type: "product", currency: "BRL", value: pedido.valorCentavos / 100 }, pedido.pedidoId);
  }, [pedido?.status, pedido?.pedidoId, pedido?.valorCentavos, id]);

  useEffect(() => {
    if (pedido?.status !== "PAGO" || !id) return;
    const destino = DESTINOS_APROVADOS[id];
    if (destino && destino.startsWith("/") && !destino.startsWith("//") && !destino.includes("\\")) router.replace(destino);
  }, [pedido?.status, id, router]);

  const oferta = id ? planos[id] : null;
  const bloqueado = !id || !plano?.compravel || !preco || !podeComprar || travarNovaTentativa;
  return (
    <div data-obaflix-landing className="min-h-screen bg-[#171313] text-zinc-50">
      <div className="mx-auto max-w-6xl px-5 pb-16 sm:px-8">
        <header className="flex min-h-20 items-center justify-between gap-4 border-b border-white/10">
          <Link href="/cortes" className="flex items-center gap-2 text-lg font-black tracking-tight text-red-500">OBA<span className="-ml-2 text-white">FLIX</span><span className="ml-2 border-l border-white/20 pl-3 text-xs tracking-[0.18em] text-zinc-200">CORTES</span></Link>
          <Link href="/cortes" className="text-xs text-zinc-300 hover:text-white">Voltar à apresentação</Link>
        </header>
        <div className="mt-8 grid items-start gap-8 lg:grid-cols-[1.1fr_0.9fr]">
          <section>
            <p className="mb-3 text-xs font-bold uppercase tracking-[0.22em] text-red-400">Seu próximo corte começa aqui</p>
            <h1 className="max-w-xl text-3xl font-black leading-tight tracking-tight sm:text-5xl">Menos tempo procurando cenas. Mais tempo criando.</h1>
            <p className="mt-4 max-w-xl text-sm leading-relaxed text-zinc-300">Selecione o momento enquanto assiste, confira a prévia e prepare o trecho para editar. Sem precisar baixar o episódio inteiro antes de marcar a cena, quando a fonte for compatível.</p>
            <div className="mt-6 flex flex-wrap gap-x-5 gap-y-2 text-xs text-zinc-300"><span className="flex items-center gap-2"><ShieldCheck size={16} /> Pix pelo servidor</span><span className="flex items-center gap-2"><Scissors size={16} /> Aplicativo Windows</span><span>Sem renovação automática</span></div>

            {pedido ? (
              <div className="mt-8 rounded-2xl border border-white/15 bg-[#221c1c] p-6" aria-live="polite">
                <p className="text-xs uppercase tracking-widest text-red-400">Status do pedido</p>
                <h2 className="mt-2 text-2xl font-bold">{pedido.status === "PAGO" ? "Pagamento confirmado" : pedido.status === "CONFIRMANDO" ? "Confirmação em andamento" : pedido.status === "REVISAO_MANUAL" || pedido.emRevisao ? "Pagamento em revisão" : pedido.status === "AGUARDANDO" ? "Aguardando pagamento" : "Acompanhe seu pedido"}</h2>
                <p className="mt-3 text-sm text-zinc-300">{pedido.status === "PAGO" ? "O pagamento foi confirmado e o download ja esta liberado abaixo. O acesso tambem e enviado ao e-mail da compra; confira o spam." : pedido.status === "REVISAO_MANUAL" || pedido.emRevisao ? MENSAGEM_DE_REVISAO_AO_COMPRADOR : pedido.status === "CONFIRMANDO" ? "Estamos conferindo o pagamento com o provedor. Não gere outro Pix." : "O pagamento só será confirmado após a verificação pelo servidor. Não é necessário deixar esta tela aberta."}</p>
                <p className="mt-4 text-2xl font-black">{dinheiro(totalPix(pedido.valorCentavos, id), pedido.moeda)}</p>
                {descricaoDaOperacao(pedido) && <p className="mt-2 text-sm text-zinc-300">{descricaoDaOperacao(pedido)}</p>}
                {pedido.status === "AGUARDANDO" && pedido.pix?.copiaECola && (
                  <div className="mt-6 grid gap-5 sm:grid-cols-[180px_1fr]">
                    {qr && <img src={qr} alt="QR Code para pagamento Pix" width={180} height={180} className="rounded-xl bg-white p-2" />}
                    <div><label htmlFor="pix-copia" className="text-sm font-semibold">Pix copia e cola</label><textarea id="pix-copia" readOnly value={pedido.pix.copiaECola} className="mt-2 h-24 w-full resize-none rounded-lg border border-white/15 bg-black/20 p-3 text-xs" /><button type="button" onClick={() => { void navigator.clipboard.writeText(pedido.pix!.copiaECola).then(() => setCopiado(true)).catch(() => setCopiado(false)); }} className="mt-2 rounded-lg bg-red-600 px-5 py-3 text-sm font-bold">{copiado ? "Copiado!" : "Copiar código Pix"}</button></div>
                  </div>
                )}
                {pedido.status === "AGUARDANDO" && <p className="mt-4 text-xs text-zinc-400">Vencimento do Pix: {new Date(pedido.expiraEm).toLocaleString("pt-BR")}. Abra o aplicativo do banco, escolha Pix e confira o destinatário e valor.</p>}
                {pedido.status === "PAGO" && (instaladorUrl ? <a className="mt-5 inline-flex items-center gap-2 rounded-xl bg-red-600 px-5 py-3 font-bold" href={instaladorUrl} rel="noopener noreferrer">Baixar aplicativo Windows <ArrowRight size={16} /></a> : <p className="mt-4 text-sm text-zinc-300">O instalador Windows com Cortes está em preparação. Acompanhe a disponibilidade na página do produto.</p>)}
                {pedido.status === "PAGO" && <p className="mt-3 text-xs text-zinc-300">Vai usar no PC depois? Confira o e-mail da compra. Se o link nao chegar, <a href="/ativar" className="text-red-300 underline">solicite um novo link de ativacao</a>.</p>}
              </div>
            ) : (
              <form className="mt-8 space-y-5 rounded-2xl border border-white/15 bg-[#221c1c] p-5 sm:p-7" onSubmit={gerarPix}>
                <div><p className="text-xs font-semibold uppercase tracking-widest text-red-400">Plano selecionado</p><h2 className="mt-1 text-xl font-bold">Cortes {oferta?.nome ?? ""}</h2><p className="mt-1 text-sm text-zinc-400">{oferta?.subtitulo ?? "Selecione um plano em /cortes."}</p></div>
                {preco && <p className="text-sm text-zinc-300 lg:hidden"><strong className="text-xl text-white">{dinheiro(totalPix(preco.precoCentavos, id), preco.moeda)}</strong> · {prazo(preco)} de acesso</p>}
                 {preco && taxaPixCakto(preco.precoCentavos, id) > 0 && <p className="text-sm text-zinc-300">Plano {dinheiro(preco.precoCentavos, preco.moeda)} + taxa Cakto {dinheiro(taxaPixCakto(preco.precoCentavos, id), preco.moeda)}. Total Pix: {dinheiro(totalPix(preco.precoCentavos, id), preco.moeda)}.</p>}
                {plano?.precos && plano.precos.length > 1 && <fieldset><legend className="text-sm font-semibold">Duração</legend><div className="mt-2 flex flex-wrap gap-2">{plano.precos.map(p => <button key={p.id} type="button" onClick={() => setPrecoId(p.id)} aria-pressed={precoId === p.id} className={`rounded-lg border px-3 py-2 text-sm ${precoId === p.id ? "border-red-500 bg-red-950/30" : "border-white/15"}`}>{p.rotulo} · {dinheiro(p.precoCentavos, p.moeda)}</button>)}</div></fieldset>}
                <div className="grid gap-4 sm:grid-cols-2">
                  <label className="text-sm font-semibold sm:col-span-2">Nome completo<input className={classeInput} autoComplete="name" required value={nome} onChange={e => setNome(e.target.value)} maxLength={80} placeholder="Nome e sobrenome" /></label>
                  <label className="text-sm font-semibold">CPF<input className={classeInput} inputMode="numeric" autoComplete="off" required value={cpf} onChange={e => atualizarMascara(e, "cpf")} placeholder="000.000.000-00" /></label>
                  <label className="text-sm font-semibold">Celular com DDD<input className={classeInput} inputMode="tel" autoComplete="tel" required value={telefone} onChange={e => atualizarMascara(e, "telefone")} placeholder="(00) 00000-0000" /></label>
                  {visitante ? <><label className="text-sm font-semibold sm:col-span-2">E-mail para receber o acesso<input className={classeInput} type="email" autoComplete="email" required value={email} onChange={e => setEmail(e.target.value)} maxLength={254} /></label><label className="text-sm font-semibold sm:col-span-2">Data de nascimento (18+)<input className={classeInput} type="date" required max={nascimentoMax} min="1900-01-01" value={nascimento} onChange={e => setNascimento(e.target.value)} /></label></> : <p className="self-end text-xs text-zinc-400 sm:col-span-2">A confirmação e o acesso ficam vinculados ao e-mail da sua conta: {sessao?.user?.email}</p>}
                </div>
                {erro && <p role="alert" className="rounded-lg border border-red-500/30 bg-red-950/30 p-3 text-sm text-red-200">{erro}</p>}
                {!podeComprar && <p className="rounded-lg border border-amber-500/25 p-3 text-sm text-amber-100">Compras públicas ainda não liberadas. Esta página está em homologação.</p>}
                <button disabled={!!bloqueado || enviando || carregando || sessaoStatus === "loading"} className="flex w-full min-h-[62px] items-center justify-center gap-3 rounded-xl border border-red-300/60 bg-gradient-to-r from-rose-700 via-red-600 to-rose-600 px-5 py-4 text-center text-base font-black text-white shadow-lg shadow-red-950/40 transition duration-200 hover:-translate-y-0.5 hover:brightness-110 hover:shadow-red-900/60 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-white motion-reduce:transform-none motion-reduce:transition-none disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:translate-y-0 disabled:hover:brightness-100" type="submit"><span>{enviando ? "Gerando Pix…" : preco && id ? `Gerar Pix de ${dinheiro(totalPix(preco.precoCentavos, id), preco.moeda)}` : "Gerar meu Pix"}</span><ArrowRight size={19} aria-hidden className="shrink-0" /></button>
                <p className="text-center text-xs leading-relaxed text-zinc-400">O Pix é gerado primeiro. Você só paga ao confirmar no aplicativo do seu banco. O acesso é liberado após a confirmação pelo servidor.</p>
              </form>
            )}
          </section>

          <aside className="space-y-6 lg:sticky lg:top-8">
            <div className="rounded-2xl border border-red-900/60 bg-gradient-to-b from-red-950/40 to-[#221c1c] p-6">
              <p className="text-xs font-semibold uppercase tracking-widest text-red-300">Sua escolha</p>
              <h2 className="mt-2 text-3xl font-black">Cortes {oferta?.nome ?? ""}</h2>
              {preco && <><p className="mt-2 text-4xl font-black">{dinheiro(totalPix(preco.precoCentavos, id), preco.moeda)}</p><p className="mt-1 text-sm text-zinc-300">{prazo(preco)} de acesso · pagamento único por Pix</p>{taxaPixCakto(preco.precoCentavos, id) > 0 && <p className="mt-1 text-xs text-zinc-300">Inclui taxa de serviço Cakto de {dinheiro(taxaPixCakto(preco.precoCentavos, id), preco.moeda)}; plano {dinheiro(preco.precoCentavos, preco.moeda)}.</p>}</>}
              {carregando && <p className="mt-2 text-sm text-zinc-400">Consultando preço oficial…</p>}
              {!carregando && (!plano?.compravel || !preco) && <p className="mt-3 text-sm text-zinc-300">Oferta temporariamente indisponível; nenhum preço será cobrado.</p>}
              <div className="mt-5 border-t border-white/15 pt-5"><h3 className="font-bold">O que você recebe</h3><ul className="mt-3 space-y-3">{(oferta?.beneficios ?? []).map(b => <li key={b} className="flex gap-3 text-sm text-zinc-200"><Check size={17} className="shrink-0 text-red-400" />{b}</li>)}</ul></div>
              <p className="mt-5 text-xs leading-relaxed text-zinc-400">O recorte depende da fonte e do formato; algumas fontes exigem FFmpeg. Montagem, legendagem e finalização continuam no seu editor. Use conteúdos para os quais tenha autorização.</p>
            </div>
            <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-6"><h3 className="font-bold">Como funciona sua compra</h3><ol className="mt-3 space-y-3 text-sm text-zinc-300"><li>1. Confira o plano e informe os dados para o Pix.</li><li>2. Pague no aplicativo do banco.</li><li>3. O servidor verifica o pagamento e envia o acesso por e-mail.</li><li>4. Instale o Obaflix Cortes no Windows quando o instalador estiver disponível.</li></ol></div>
            <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-6"><h3 className="font-bold">Exemplos de uso, não depoimentos</h3><p className="mt-3 text-sm text-zinc-300">Para criadores de resumos que precisam de uma cena específica, canais de análise que preparam referências e editores de vídeos curtos que organizam trechos para trabalhar em outro editor.</p></div>
            <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-6"><h3 className="font-bold">Dúvidas rápidas</h3><div className="mt-3 space-y-3 text-sm text-zinc-300"><details><summary className="cursor-pointer font-semibold">Preciso baixar tudo antes de cortar?</summary><p className="mt-2">Não, quando a fonte for compatível você marca e exporta só o trecho selecionado.</p></details><details><summary className="cursor-pointer font-semibold">É um editor de vídeo no celular?</summary><p className="mt-2">Não. O checkout funciona no celular, mas o recorte é realizado no aplicativo Windows.</p></details><details><summary className="cursor-pointer font-semibold">Há renovação automática?</summary><p className="mt-2">Não. Cada Pix paga somente o período selecionado.</p></details><details><summary className="cursor-pointer font-semibold">Quando recebo o acesso?</summary><p className="mt-2">Após confirmação no servidor, pelo e-mail informado ou pela conta existente.</p></details></div></div>
          </aside>
        </div>
        <footer className="mt-10 border-t border-white/10 pt-6 text-center text-xs text-zinc-500">Obaflix Cortes · Pagamento Pix seguro · Nenhuma avaliação ou venda fictícia</footer>
      </div>
    </div>
  );
}
