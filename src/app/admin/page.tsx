"use client";

import { useSession } from "next-auth/react";
import { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import {
  Film, Tv, LayoutDashboard, Search, Plus, Trash2, Edit2,
  ChevronLeft, ChevronRight, Loader2, Check, X, ListVideo, Trophy,
  Users, CreditCard, Receipt, Radio, RefreshCw, ScrollText, LogOut,
} from "lucide-react";
import Image from "next/image";
import { signOut } from "next-auth/react";

const ADMIN_JSON_HEADERS = { "Content-Type": "application/json" } as const;

// ── Types ─────────────────────────────────────────────────────────────────────

interface TmdbResult {
  id: number;
  title?: string;
  name?: string;
  poster_path?: string;
  release_date?: string;
  first_air_date?: string;
  vote_average?: number;
  overview?: string;
  genres?: { id: number; name: string }[];
  number_of_seasons?: number;
  runtime?: number;
  original_title?: string;
  original_name?: string;
}

interface FilmeItem {
  id: string;
  titulo: string;
  poster: string | null;
  ano: number | null;
  urlDub: string | null;
  urlLeg: string | null;
  tmdbId: string | null;
}

interface SerieItem {
  id: string;
  titulo: string;
  poster: string | null;
  ano: number | null;
  tipo: string;
  tmdbId: string | null;
  _count: { episodios: number };
}

interface EpItem {
  id: string;
  serieId: string;
  numeroEp: number;
  temporada: number;
  titulo: string | null;
  urlDub: string | null;
  urlLeg: string | null;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function poster(path: string | null | undefined, size = "w92") {
  if (!path) return null;
  if (path.startsWith("http")) return path;
  return `https://image.tmdb.org/t/p/${size}${path}`;
}

function slugify(str: string) {
  return str
    .toLowerCase()
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

// ── Main component ────────────────────────────────────────────────────────────

export default function AdminPage() {
  const { data: session, status } = useSession();
  const router = useRouter();
  const [tab, setTab] = useState<"dash" | "usuarios" | "assinaturas" | "pagamentos" | "catalogo" | "canais" | "sincronizacoes" | "auditoria">("dash");
  const [catalogTab, setCatalogTab] = useState<"filme" | "serie" | "lista" | "episodios">("lista");
  const [preloadSerieId, setPreloadSerieId] = useState<string | undefined>();

  useEffect(() => {
    if (status === "unauthenticated") router.push("/login");
    // Na superfície admin `/` volta para `/admin`; o destino seguro é `/login`.
    if (status === "authenticated" && (session?.user as any)?.role !== "admin") router.push(process.env.NEXT_PUBLIC_OBAFLIX_SURFACE === "admin" ? "/login" : "/");
  }, [status, session, router]);

  if (status === "loading") return <div className="min-h-screen flex items-center justify-center"><Loader2 className="animate-spin text-white" /></div>;

  // Autorização agora é por sessão (cookie enviado automaticamente). Sem token client-side.
  const headers = ADMIN_JSON_HEADERS;

  return (
    <div className="min-h-screen bg-[oklch(0.125_0.008_25)] text-zinc-100 lg:grid lg:grid-cols-[15rem_minmax(0,1fr)]">
      <aside className="border-b border-white/10 bg-[oklch(0.16_0.009_25)] lg:sticky lg:top-0 lg:h-screen lg:border-b-0 lg:border-r">
        <div className="flex h-16 items-center justify-between px-5 lg:h-20">
          <div><p className="text-lg font-black tracking-tight"><span className="text-red-500">OBA</span>FLIX</p><p className="text-[10px] uppercase tracking-[0.2em] text-zinc-500">Administração</p></div>
          <button onClick={() => signOut({ callbackUrl: "/login" })} className="rounded-md p-2 text-zinc-500 hover:bg-white/5 hover:text-zinc-200" aria-label="Sair"><LogOut size={16} /></button>
        </div>
        <nav className="flex gap-1 overflow-x-auto px-3 pb-3 lg:block lg:space-y-1 lg:overflow-visible">
        {([
          { key: "dash", icon: LayoutDashboard, label: "Dashboard" },
          { key: "usuarios", icon: Users, label: "Usuários" },
          { key: "assinaturas", icon: CreditCard, label: "Assinaturas" },
          { key: "pagamentos", icon: Receipt, label: "Pagamentos" },
          { key: "catalogo", icon: Search, label: "Catálogo" },
          { key: "canais", icon: Radio, label: "Canais" },
          { key: "sincronizacoes", icon: RefreshCw, label: "Sincronizações" },
          { key: "auditoria", icon: ScrollText, label: "Auditoria" },
        ] as const).map(({ key, icon: Icon, label }) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={`flex shrink-0 items-center gap-2 rounded-md px-3 py-2.5 text-sm transition lg:w-full ${
              tab === key
                ? "bg-red-500/12 text-red-300 font-semibold"
                : "text-zinc-400 hover:bg-white/5 hover:text-white"
            }`}
          >
            <Icon size={15} /> {label}
          </button>
        ))}
        </nav>
      </aside>

      <main className="min-w-0 px-4 py-6 md:px-8 lg:px-10 lg:py-9">
        {tab === "dash"      && <Dashboard headers={headers} />}
        {tab === "usuarios" && <UsersPanel headers={headers} />}
        {tab === "assinaturas" && <SubscriptionsPanel headers={headers} />}
        {tab === "pagamentos" && <PaymentsPanel headers={headers} />}
        {tab === "catalogo" && <section><PageTitle title="Catálogo" subtitle="Filmes, séries, classificação e episódios" /><div className="mb-6 flex flex-wrap gap-2">{([['lista','Acervo'],['filme','Adicionar filme'],['serie','Adicionar série'],['episodios','Episódios']] as const).map(([key,label]) => <button key={key} onClick={() => setCatalogTab(key)} className={`rounded-md px-3 py-2 text-sm ${catalogTab === key ? 'bg-zinc-100 text-zinc-950' : 'bg-white/5 text-zinc-400 hover:text-white'}`}>{label}</button>)}</div>
          {catalogTab === "filme" && <AdicionarFilme headers={headers} />}
          {catalogTab === "serie" && <AdicionarSerie headers={headers} onSaved={(id) => { setPreloadSerieId(id); setCatalogTab("episodios"); }} />}
          {catalogTab === "lista" && <Catalogo headers={headers} onEditEp={(id) => { setPreloadSerieId(id); setCatalogTab("episodios"); }} />}
          {catalogTab === "episodios" && <GerenciarEpisodios headers={headers} initialSerieId={preloadSerieId} onLoaded={() => setPreloadSerieId(undefined)} />}
        </section>}
        {tab === "canais" && <ChannelsPanel headers={headers} />}
        {tab === "sincronizacoes" && <SyncPanel headers={headers} />}
        {tab === "auditoria" && <AuditPanel headers={headers} />}
      </main>
    </div>
  );
}

function PageTitle({ title, subtitle }: { title: string; subtitle: string }) {
  return <header className="mb-7"><h1 className="text-2xl font-bold tracking-tight text-zinc-100">{title}</h1><p className="mt-1 text-sm text-zinc-500">{subtitle}</p></header>;
}

function Status({ value }: { value: string }) {
  const ok = ["ATIVA", "PAGO", "SUCCESS", "RUNNING"].includes(value);
  const warning = ["AGUARDANDO", "PENDENTE", "SUSPENSA"].includes(value);
  return <span className={`inline-flex rounded-full px-2 py-0.5 text-[11px] font-semibold ${ok ? "bg-emerald-400/10 text-emerald-300" : warning ? "bg-amber-400/10 text-amber-300" : "bg-zinc-400/10 text-zinc-400"}`}>{value}</span>;
}

const dateTime = (value: string | null | undefined) => value ? new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short" }).format(new Date(value)) : "—";

function UsersPanel({ headers }: { headers: Record<string, string> }) {
  const [q, setQ] = useState(""); const [data, setData] = useState<any>(null); const [selected, setSelected] = useState<any>(null);
  const [password, setPassword] = useState(""); const [reason, setReason] = useState(""); const [confirming, setConfirming] = useState(false); const [message, setMessage] = useState("");
  const load = useCallback(() => fetch(`/api/admin/usuarios?q=${encodeURIComponent(q)}`, { headers }).then(r => r.json()).then(setData), [q, headers]);
  useEffect(() => { const timer = setTimeout(load, 250); return () => clearTimeout(timer); }, [load]);
  const open = async (id: string) => setSelected(await fetch(`/api/admin/usuarios/${id}`, { headers }).then(r => r.json()));
  const resetPassword = async () => {
    const response = await fetch("/api/admin/reset-password", { method: "POST", headers, body: JSON.stringify({ userId: selected.id, novaSenha: password, motivo: reason }) });
    const body = await response.json(); setMessage(response.ok ? "Senha temporária definida e ação auditada." : body.error); if (response.ok) { setPassword(""); setReason(""); setConfirming(false); }
  };
  return <section><PageTitle title="Usuários" subtitle="Busca, assinatura vigente, dispositivos e suporte de acesso" />
    <input value={q} onChange={e => setQ(e.target.value)} placeholder="Buscar por nome ou e-mail" className="mb-5 w-full max-w-xl rounded-md border border-white/10 bg-white/5 px-3 py-2.5 text-sm outline-none focus:border-red-400/60" />
    <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_24rem]"><div className="overflow-x-auto rounded-lg border border-white/10"><table className="w-full text-left text-sm"><thead className="bg-white/[0.035] text-xs uppercase tracking-wide text-zinc-500"><tr><th className="px-4 py-3">Usuário</th><th className="px-4 py-3">Role</th><th className="px-4 py-3">Assinatura</th><th className="px-4 py-3">Criado</th></tr></thead><tbody className="divide-y divide-white/5">{data?.items?.map((user: any) => <tr key={user.id} onClick={() => open(user.id)} className="cursor-pointer hover:bg-white/[0.035]"><td className="px-4 py-3"><b className="block font-medium">{user.nome || "Sem nome"}</b><span className="text-xs text-zinc-500">{user.email}</span></td><td className="px-4 py-3 text-zinc-400">{user.role}</td><td className="px-4 py-3">{user.assinaturas[0] ? <Status value={user.assinaturas[0].status} /> : <span className="text-zinc-600">Sem assinatura</span>}</td><td className="px-4 py-3 text-zinc-500">{dateTime(user.createdAt)}</td></tr>)}</tbody></table></div>
      <aside className="rounded-lg border border-white/10 bg-white/[0.025] p-5">{selected ? <><h2 className="font-semibold">{selected.nome || "Sem nome"}</h2><p className="text-sm text-zinc-500">{selected.email}</p><p className="mt-2 break-all text-xs text-zinc-600">{selected.id}</p><div className="mt-5 space-y-2"><h3 className="text-xs font-bold uppercase tracking-wide text-zinc-500">Assinaturas</h3>{selected.assinaturas?.length ? selected.assinaturas.map((a: any) => <div key={a.id} className="rounded-md bg-white/[0.03] p-2 text-xs"><div className="flex items-center justify-between"><b>{a.plano.nome}</b><Status value={a.status} /></div><p className="mt-1 text-zinc-500">{dateTime(a.iniciaEm)} até {dateTime(a.terminaEm)} · {a.origem}</p><p className="text-zinc-500">+{a.telasAdicionais} telas · VIP {a.servidorVip ? "sim" : "não"}</p></div>) : <p className="text-sm text-zinc-600">Nenhuma assinatura</p>}</div><div className="mt-5 space-y-2"><h3 className="text-xs font-bold uppercase tracking-wide text-zinc-500">Dispositivos TV</h3>{selected.dispositivos?.length ? selected.dispositivos.map((d: any) => <div key={d.id} className="text-sm"><span>{d.nome}</span><span className="float-right text-xs text-zinc-500">{dateTime(d.ultimoUso)}</span></div>) : <p className="text-sm text-zinc-600">Nenhum pareado</p>}</div><div className="mt-6 border-t border-white/10 pt-5"><h3 className="text-sm font-semibold">Definir senha temporária</h3><p className="mt-1 text-xs text-zinc-500">A senha existente nunca é exibida.</p><input type="password" value={password} onChange={e => { setPassword(e.target.value); setConfirming(false); }} placeholder="Mínimo de 12 caracteres" className="mt-3 w-full rounded-md bg-zinc-900 px-3 py-2 text-sm" /><textarea value={reason} onChange={e => { setReason(e.target.value); setConfirming(false); }} placeholder="Motivo obrigatório" className="mt-2 w-full rounded-md bg-zinc-900 px-3 py-2 text-sm" />{confirming ? <div className="mt-3 rounded-md bg-amber-400/10 p-3 text-xs text-amber-200"><p>Confirmar redefinição para {selected.email}?</p><button onClick={resetPassword} className="mt-2 rounded bg-amber-300 px-3 py-1.5 font-semibold text-zinc-950">Confirmar e auditar</button></div> : <button disabled={password.length < 12 || reason.trim().length < 5} onClick={() => setConfirming(true)} className="mt-3 rounded-md bg-red-600 px-3 py-2 text-sm font-semibold disabled:opacity-40">Redefinir senha</button>}{message && <p className="mt-2 text-xs text-zinc-400">{message}</p>}</div></> : <p className="text-sm text-zinc-600">Selecione um usuário para ver detalhes.</p>}</aside></div>
  </section>;
}

function SubscriptionsPanel({ headers }: { headers: Record<string, string> }) {
  const [q, setQ] = useState(""); const [data, setData] = useState<any>(null); const [editing, setEditing] = useState<string | null>(null); const [reason, setReason] = useState(""); const [pendingAction, setPendingAction] = useState<string | null>(null);
  const load = useCallback(() => fetch(`/api/admin/assinaturas?q=${encodeURIComponent(q)}`, { headers }).then(r => r.json()).then(setData), [q, headers]);
  useEffect(() => { load(); }, [load]);
  const [actionError, setActionError] = useState("");
  const act = async (assinaturaId: string, acao: string) => { setActionError(""); const r = await fetch("/api/admin/assinaturas/acao", { method: "POST", headers, body: JSON.stringify({ assinaturaId, acao, motivo: reason }) }); if (r.ok) { setEditing(null); setReason(""); setPendingAction(null); load(); } else { const body = await r.json().catch(() => ({})); setActionError(body.error ?? "Ação não executada"); setPendingAction(null); } };
  return <section><PageTitle title="Assinaturas" subtitle="Direitos de acesso separados do histórico financeiro" /><input value={q} onChange={e => setQ(e.target.value)} placeholder="Buscar usuário ou e-mail" className="mb-5 w-full max-w-xl rounded-md border border-white/10 bg-white/5 px-3 py-2.5 text-sm" /><div className="overflow-x-auto rounded-lg border border-white/10"><table className="w-full text-left text-sm"><thead className="bg-white/[0.035] text-xs uppercase text-zinc-500"><tr><th className="px-4 py-3">Usuário</th><th className="px-4 py-3">Plano</th><th className="px-4 py-3">Status</th><th className="px-4 py-3">Período</th><th className="px-4 py-3">Origem</th><th className="px-4 py-3">Extras</th><th /></tr></thead><tbody className="divide-y divide-white/5">{data?.items?.map((item: any) => <tr key={item.id}><td className="px-4 py-3"><b className="block">{item.user.nome || "Sem nome"}</b><span className="text-xs text-zinc-500">{item.user.email}</span></td><td className="px-4 py-3">{item.plano.nome}</td><td className="px-4 py-3"><Status value={item.status} /></td><td className="px-4 py-3 text-xs text-zinc-400">{dateTime(item.iniciaEm)}<br />{dateTime(item.terminaEm)}</td><td className="px-4 py-3 text-zinc-400">{item.origem}</td><td className="px-4 py-3 text-xs text-zinc-400">+{item.telasAdicionais} telas · VIP {item.servidorVip ? "sim" : "não"}</td><td className="px-4 py-3"><button onClick={() => { setEditing(editing === item.id ? null : item.id); setPendingAction(null); }} className="text-xs text-red-300">Suporte</button>{editing === item.id && <div className="mt-2 min-w-56"><input value={reason} onChange={e => { setReason(e.target.value); setPendingAction(null); }} placeholder="Motivo obrigatório" className="w-full rounded bg-zinc-900 px-2 py-1.5 text-xs" />{pendingAction ? <div className="mt-2 rounded bg-amber-400/10 p-2 text-xs text-amber-200"><p>Confirmar ação: {pendingAction}?</p><button onClick={() => act(item.id, pendingAction)} className="mt-2 rounded bg-amber-300 px-2 py-1 font-semibold text-zinc-950">Confirmar e auditar</button></div> : <div className="mt-2 flex gap-1">{item.status === "ATIVA" && <button disabled={reason.trim().length < 5} onClick={() => setPendingAction("suspender")} className="rounded bg-amber-400/15 px-2 py-1 text-xs text-amber-300 disabled:opacity-40">Suspender</button>}{item.status === "SUSPENSA" && <button disabled={reason.trim().length < 5} onClick={() => setPendingAction("reativar")} className="rounded bg-emerald-400/15 px-2 py-1 text-xs text-emerald-300 disabled:opacity-40">Reativar</button>}{(item.status === "ATIVA" || item.status === "SUSPENSA") ? <button disabled={reason.trim().length < 5} onClick={() => setPendingAction("cancelar")} className="rounded bg-red-400/15 px-2 py-1 text-xs text-red-300 disabled:opacity-40">Cancelar</button> : <span className="text-xs text-zinc-600">Sem ação de suporte para {item.status}</span>}</div>}{actionError && <p className="mt-2 text-xs text-red-300">{actionError}</p>}</div>}</td></tr>)}</tbody></table></div></section>;
}

function PaymentsPanel({ headers }: { headers: Record<string, string> }) {
  const [q, setQ] = useState(""); const [data, setData] = useState<any>(null);
  useEffect(() => { const timer = setTimeout(() => fetch(`/api/admin/pagamentos?q=${encodeURIComponent(q)}`, { headers }).then(r => r.json()).then(setData), 200); return () => clearTimeout(timer); }, [q, headers]);
  return <section><PageTitle title="Pagamentos" subtitle="Histórico de pedidos e sinalização de revisões, sem editar transações" /><input value={q} onChange={e => setQ(e.target.value)} placeholder="Buscar usuário ou e-mail" className="mb-5 w-full max-w-xl rounded-md border border-white/10 bg-white/5 px-3 py-2.5 text-sm" /><div className="overflow-x-auto rounded-lg border border-white/10"><table className="w-full text-left text-sm"><thead className="bg-white/[0.035] text-xs uppercase text-zinc-500"><tr><th className="px-4 py-3">Usuário</th><th className="px-4 py-3">Plano</th><th className="px-4 py-3">Valor</th><th className="px-4 py-3">Status</th><th className="px-4 py-3">Operação</th><th className="px-4 py-3">Criado</th></tr></thead><tbody className="divide-y divide-white/5">{data?.items?.map((item: any) => <tr key={item.id}><td className="px-4 py-3"><b className="block">{item.user.nome || "Sem nome"}</b><span className="text-xs text-zinc-500">{item.user.email}</span></td><td className="px-4 py-3">{item.plano.nome}</td><td className="px-4 py-3">{new Intl.NumberFormat("pt-BR", { style: "currency", currency: item.moeda }).format(item.valorCentavos / 100)}</td><td className="px-4 py-3"><Status value={item.status} />{item.revisoes.length > 0 && <span className="ml-2 text-xs text-amber-300">revisão</span>}</td><td className="px-4 py-3 text-zinc-400">{item.operacao}</td><td className="px-4 py-3 text-zinc-500">{dateTime(item.criadoEm)}</td></tr>)}</tbody></table></div></section>;
}

function ChannelsPanel({ headers }: { headers: Record<string, string> }) {
  const [data, setData] = useState<any>(null); const [q, setQ] = useState(""); const [editing, setEditing] = useState<any>(null); const [reason, setReason] = useState("");
  const load = useCallback(() => fetch(`/api/admin/canais?q=${encodeURIComponent(q)}`, { headers }).then(r => r.json()).then(setData), [q, headers]); useEffect(() => { load(); }, [load]);
  const save = async () => { const r = await fetch("/api/admin/canais", { method: "POST", headers, body: JSON.stringify({ ...editing, motivo: reason }) }); if (r.ok) { setEditing(null); setReason(""); load(); } };
  return <section><PageTitle title="Canais" subtitle="Visão operacional sem expor URLs ou dados do provider" /><div className="mb-5 flex items-center gap-4"><input value={q} onChange={e => setQ(e.target.value)} placeholder="Canal ou categoria" className="w-full max-w-xl rounded-md border border-white/10 bg-white/5 px-3 py-2.5 text-sm" /><span className="text-sm text-zinc-500">{data?.ativos ?? 0}/{data?.total ?? 0} ativos</span></div><div className="divide-y divide-white/5 rounded-lg border border-white/10">{data?.items?.map((item: any) => <div key={item.id} className="grid gap-3 px-4 py-3 md:grid-cols-[minmax(12rem,1fr)_10rem_8rem_6rem]"><div><b className="text-sm">{item.nome}</b><p className="text-xs text-zinc-500">{item.categoria}</p></div><span className="text-sm text-zinc-400">{item.nivelMinimo}{!item.nivelRevisado && " · pendente"}</span><Status value={item.ativo ? "ATIVA" : "INATIVA"} /><button onClick={() => setEditing({ id: item.id, ativo: item.ativo, nivelMinimo: item.nivelMinimo })} className="text-left text-xs text-red-300">Revisar</button>{editing?.id === item.id && <div className="md:col-span-4 flex flex-wrap gap-2 rounded-md bg-white/[0.03] p-3"><select value={editing.nivelMinimo} onChange={e => setEditing({ ...editing, nivelMinimo: e.target.value })} className="rounded bg-zinc-900 px-2 py-1 text-sm"><option value="gratuito">Gratuito</option><option value="plus">Plus</option><option value="premium">Premium</option></select><label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={editing.ativo} onChange={e => setEditing({ ...editing, ativo: e.target.checked })} /> Ativo</label><input value={reason} onChange={e => setReason(e.target.value)} placeholder="Motivo obrigatório" className="min-w-60 flex-1 rounded bg-zinc-900 px-2 py-1 text-sm" /><button disabled={reason.trim().length < 5} onClick={save} className="rounded bg-red-600 px-3 py-1 text-sm disabled:opacity-40">Salvar revisão</button></div>}</div>)}</div></section>;
}

function SyncPanel({ headers }: { headers: Record<string, string> }) {
  const [data, setData] = useState<any>(null); useEffect(() => { fetch("/api/admin/sincronizacoes", { headers }).then(r => r.json()).then(setData); }, [headers]);
  const row = (id: string, label: string, where: string, freq: number | null, item: any, atrasada: boolean, ultimoSucessoEm: string | null) => <div key={id} className="grid gap-2 px-4 py-4 md:grid-cols-[16rem_8rem_1fr_10rem]"><div><b className="text-sm">{label}</b><p className="text-xs text-zinc-500">{where}{freq ? ` · a cada ${freq}h` : " · sob demanda"}</p></div>{item ? <><Status value={atrasada ? "ATRASADA" : item.status} /><span className="text-xs text-zinc-500">Último início {dateTime(item.startedAt)} · fim {dateTime(item.finishedAt)}{item.legacy ? " · métrica legada" : ""}<br />{item.legacy ? `erros ${item.errors ?? 0}` : `F ${item.moviesAdded}/${item.moviesUpdated} · S ${item.seriesAdded}/${item.seriesUpdated} · E ${item.episodesAdded}/${item.episodesUpdated} · erros ${item.errors}`}{item.errorSummary ? <><br /><span className="text-red-300/80">{item.errorSummary}</span></> : null}</span><span className="text-xs text-zinc-500">Último sucesso {dateTime(ultimoSucessoEm)}</span></> : <span className="md:col-span-3 text-sm text-zinc-600">sem telemetria</span>}</div>;
  return <section><PageTitle title="Sincronizações" subtitle="Saúde dos produtores de catálogo. Atraso: último sucesso acima de 2× a frequência (5h → alerta após 10h)." /><div className="divide-y divide-white/5 rounded-lg border border-white/10">{(data?.fontes ?? []).map((f: any) => row(f.id, f.label, f.executaOnde, f.frequenciaHoras, f.ultima, f.atrasada, f.ultimoSucessoEm))}{(data?.outras ?? []).map((item: any) => row(`${item.source}:${item.job}`, `${item.source} · ${item.job}`, "fora do inventário", null, item, false, item.status === "SUCCESS" ? item.finishedAt : null))}</div></section>;
}

function AuditPanel({ headers }: { headers: Record<string, string> }) {
  const [data, setData] = useState<any>(null); useEffect(() => { fetch("/api/admin/auditoria", { headers }).then(r => r.json()).then(setData); }, [headers]);
  return <section><PageTitle title="Auditoria" subtitle="Ações administrativas sensíveis, com motivo e metadados sanitizados" /><div className="overflow-x-auto rounded-lg border border-white/10"><table className="w-full text-left text-sm"><thead className="bg-white/[0.035] text-xs uppercase text-zinc-500"><tr><th className="px-4 py-3">Quando</th><th className="px-4 py-3">Administrador</th><th className="px-4 py-3">Ação</th><th className="px-4 py-3">Alvo</th><th className="px-4 py-3">Motivo</th></tr></thead><tbody className="divide-y divide-white/5">{data?.items?.map((item: any) => <tr key={item.id}><td className="px-4 py-3 text-zinc-500">{dateTime(item.createdAt)}</td><td className="px-4 py-3">{item.adminUser.nome || item.adminUser.email}</td><td className="px-4 py-3"><code className="text-xs text-red-300">{item.action}</code></td><td className="px-4 py-3 text-zinc-400">{item.targetType}<br /><span className="text-xs text-zinc-600">{item.targetId}</span></td><td className="max-w-md px-4 py-3 text-zinc-400">{item.reason}</td></tr>)}</tbody></table></div></section>;
}

// ── Dashboard ─────────────────────────────────────────────────────────────────

function Dashboard({ headers }: { headers: Record<string, string> }) {
  const [stats, setStats] = useState<any>(null);
  const [syncState, setSyncState] = useState<"idle" | "loading" | "done" | "error">("idle");
  const [syncResult, setSyncResult] = useState<string>("");

  useEffect(() => {
    fetch("/api/admin/stats", { headers })
      .then((r) => r.json())
      .then((d) => { if (d && typeof d.filmes === "number") setStats(d); })
      .catch(() => {});
  }, [headers]);

  const syncTop250 = async () => {
    setSyncState("loading");
    setSyncResult("");
    try {
      const r = await fetch("/api/admin/sync-top250", { method: "POST", headers });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error ?? "Erro desconhecido");
      setSyncResult(
        `${d.filmes.atualizados} filmes · ${d.series.atualizadas} séries atualizados`,
      );
      setSyncState("done");
    } catch (e: any) {
      setSyncResult(e.message);
      setSyncState("error");
    }
  };

  const cards = stats ? [
    { label: "Usuários totais", value: stats.usuarios ?? 0 },
    { label: "Novos hoje", value: stats.novosHoje ?? 0 },
    { label: "Novos 7 dias", value: stats.novos7Dias ?? 0 },
    { label: "Novos 30 dias", value: stats.novos30Dias ?? 0 },
    { label: "Assinaturas ativas", value: stats.assinaturasAtivas ?? 0 },
    { label: "Vencendo em 7 dias", value: stats.vencendo7Dias ?? 0 },
    { label: "Filmes", value: stats.filmes ?? 0 },
    { label: "Séries", value: stats.series ?? 0 },
    { label: "Animes", value: stats.animes ?? 0 },
    { label: "Desenhos", value: stats.desenhos ?? 0 },
    { label: "Episódios", value: stats.episodios ?? 0 },
    { label: "Canais ativos / total", value: `${stats.canaisAtivos ?? 0} / ${stats.canais ?? 0}` },
  ] : [];

  const maxDaily = Math.max(1, ...(stats?.usuariosPorDia ?? []).map((item: any) => item.count));

  return (
    <div>
      <PageTitle title="Dashboard" subtitle="Visão operacional baseada nos dados reais do Obaflix" />
      {!stats && <Loader2 className="animate-spin text-white/40" />}
      <div className="grid grid-cols-2 border-y border-white/10 md:grid-cols-3 xl:grid-cols-6">
        {cards.map((c, index) => (
          <div key={c.label} className={`px-4 py-5 ${index % 6 !== 5 ? "xl:border-r xl:border-white/10" : ""}`}>
            <p className="mb-2 text-[11px] uppercase tracking-wider text-zinc-500">{c.label}</p>
            <p className="text-2xl font-bold tracking-tight">{typeof c.value === "number" ? c.value.toLocaleString("pt-BR") : c.value}</p>
          </div>
        ))}
      </div>

      {stats && <div className="mt-8 grid gap-7 xl:grid-cols-[minmax(0,1.5fr)_minmax(18rem,1fr)]"><section><h3 className="mb-4 text-sm font-semibold">Novos usuários, últimos 30 dias</h3><div className="flex h-44 items-end gap-1 border-b border-white/10 pb-1" aria-label="Gráfico de novos usuários por dia">{stats.usuariosPorDia.map((item: any) => <div key={item.date} title={`${item.date}: ${item.count}`} className="min-w-0 flex-1 rounded-t-sm bg-red-500/70 hover:bg-red-400" style={{ height: `${Math.max(3, item.count / maxDaily * 100)}%` }} />)}</div></section><section><h3 className="mb-4 text-sm font-semibold">Sincronizações recentes</h3><div className="space-y-3">{stats.sincronizacoes.length ? stats.sincronizacoes.slice(0, 5).map((item: any) => <div key={item.id} className="flex items-center justify-between gap-4 text-sm"><div><b className="font-medium">{item.source}</b><p className="text-xs text-zinc-500">{dateTime(item.finishedAt ?? item.startedAt)}</p></div><Status value={item.status} /></div>) : <p className="text-sm text-zinc-600">Sem telemetria registrada ainda.</p>}</div></section></div>}

      {/* Ações de manutenção */}
      <div className="mt-8 border border-white/10 rounded-lg p-5">
        <h3 className="text-white/60 text-xs uppercase tracking-wider mb-4">Manutenção</h3>
        <div className="flex flex-wrap gap-3 items-center">
          <button
            onClick={syncTop250}
            disabled={syncState === "loading"}
            className="flex items-center gap-2 bg-amber-600 hover:bg-amber-500 disabled:opacity-50 text-white text-sm font-semibold px-4 py-2 rounded-lg transition"
          >
            {syncState === "loading"
              ? <Loader2 size={15} className="animate-spin" />
              : <Trophy size={15} />}
            Sincronizar Top 250
          </button>
          {syncResult && (
            <span className={`text-sm ${syncState === "error" ? "text-red-400" : "text-green-400"}`}>
              {syncState === "done" && <Check size={13} className="inline mr-1" />}
              {syncResult}
            </span>
          )}
        </div>
        <p className="text-zinc-500 text-xs mt-2">
          Usa os mesmos dados da página Melhores (TMDB top_rated) para atualizar o badge Top 250.
        </p>
      </div>
    </div>
  );
}

// ── Shared TMDB Search ────────────────────────────────────────────────────────

function TmdbSearch({ tipo, headers, onSelect }: {
  tipo: "filme" | "serie";
  headers: Record<string, string>;
  onSelect: (item: TmdbResult) => void;
}) {
  const [q, setQ] = useState("");
  const [results, setResults] = useState<TmdbResult[]>([]);
  const [loading, setLoading] = useState(false);

  const search = useCallback(async () => {
    if (!q.trim()) return;
    setLoading(true);
    const r = await fetch(`/api/admin/tmdb-search?q=${encodeURIComponent(q)}&tipo=${tipo}`, { headers });
    const d = await r.json();
    setResults(d.results ?? []);
    setLoading(false);
  }, [q, tipo, headers]);

  useEffect(() => {
    const t = setTimeout(() => { if (q.length > 2) search(); }, 400);
    return () => clearTimeout(t);
  }, [q, search]);

  return (
    <div className="mb-6">
      <div className="flex gap-2">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={`Buscar ${tipo === "filme" ? "filme" : "série/anime"} no TMDB...`}
          className="flex-1 bg-zinc-800 text-white px-4 py-2.5 rounded-lg outline-none border border-white/10 focus:border-white/30 text-sm"
          onKeyDown={(e) => e.key === "Enter" && search()}
        />
        <button onClick={search} className="bg-zinc-700 hover:bg-zinc-600 px-4 rounded-lg transition">
          {loading ? <Loader2 size={16} className="animate-spin" /> : <Search size={16} />}
        </button>
      </div>

      {results.length > 0 && (
        <div className="mt-2 bg-zinc-900 border border-white/10 rounded-lg overflow-hidden max-h-72 overflow-y-auto">
          {results.slice(0, 10).map((item) => (
            <button
              key={item.id}
              onClick={() => { onSelect(item); setResults([]); setQ(""); }}
              className="w-full flex items-center gap-3 px-3 py-2.5 hover:bg-zinc-800 transition text-left border-b border-white/5 last:border-0"
            >
              {item.poster_path ? (
                <Image
                  src={`https://image.tmdb.org/t/p/w92${item.poster_path}`}
                  alt=""
                  width={32}
                  height={48}
                  className="rounded object-cover flex-none"
                />
              ) : (
                <div className="w-8 h-12 bg-zinc-700 rounded flex-none" />
              )}
              <div className="min-w-0">
                <p className="text-sm font-medium truncate">{item.title ?? item.name}</p>
                <p className="text-xs text-zinc-400">
                  {(item.release_date ?? item.first_air_date ?? "").slice(0, 4)}
                  {item.vote_average ? ` · ★ ${item.vote_average.toFixed(1)}` : ""}
                </p>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Adicionar Filme ───────────────────────────────────────────────────────────

function AdicionarFilme({ headers }: { headers: Record<string, string> }) {
  const blank = { id: "", tmdbId: "", titulo: "", tituloOriginal: "", poster: "", background: "", sinopse: "", ano: "", nota: "", duracao: "", urlDub: "", urlLeg: "", generos: [] as any[] };
  const [form, setForm] = useState(blank);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState("");

  const fill = (item: TmdbResult) => {
    const ano = (item.release_date ?? "").slice(0, 4);
    const id = `tmdb-${item.id}`;
    setForm({
      id,
      tmdbId: String(item.id),
      titulo: item.title ?? "",
      tituloOriginal: item.original_title ?? "",
      poster: item.poster_path ? `https://image.tmdb.org/t/p/w500${item.poster_path}` : "",
      background: "",
      sinopse: item.overview ?? "",
      ano,
      nota: item.vote_average ? String(item.vote_average.toFixed(1)) : "",
      duracao: item.runtime ? String(item.runtime) : "",
      urlDub: "",
      urlLeg: "",
      generos: item.genres ?? [],
    });
  };

  const set = (k: string, v: string) => setForm((f) => ({ ...f, [k]: v }));

  const save = async () => {
    if (!form.id || !form.titulo) return setMsg("ID e Título obrigatórios");
    setSaving(true);
    setMsg("");
    const r = await fetch("/api/admin/filme", {
      method: "POST",
      headers,
      body: JSON.stringify(form),
    });
    const d = await r.json();
    setMsg(r.ok ? `✓ Salvo: ${d.id}` : `Erro: ${d.error}`);
    if (r.ok) setForm(blank);
    setSaving(false);
  };

  return (
    <div>
      <h2 className="text-xl font-bold mb-6">Adicionar Filme</h2>
      <TmdbSearch tipo="filme" headers={headers} onSelect={fill} />
      <FilmeForm form={form} set={set} />
      <div className="flex items-center gap-4 mt-6">
        <button
          onClick={save}
          disabled={saving}
          className="flex items-center gap-2 bg-[#E50914] hover:bg-red-700 text-white font-bold px-6 py-2.5 rounded-lg transition disabled:opacity-50"
        >
          {saving ? <Loader2 size={16} className="animate-spin" /> : <Plus size={16} />}
          Salvar Filme
        </button>
        <button onClick={() => setForm(blank)} className="text-zinc-400 hover:text-white text-sm transition">
          Limpar
        </button>
        {msg && <p className={`text-sm ${msg.startsWith("✓") ? "text-green-400" : "text-red-400"}`}>{msg}</p>}
      </div>
    </div>
  );
}

function FilmeForm({ form, set }: { form: any; set: (k: string, v: string) => void }) {
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
      <Field label="ID" value={form.id} onChange={(v) => set("id", v)} required />
      <Field label="TMDB ID" value={form.tmdbId} onChange={(v) => set("tmdbId", v)} />
      <Field label="Título" value={form.titulo} onChange={(v) => set("titulo", v)} required className="md:col-span-2" />
      <Field label="Título Original" value={form.tituloOriginal} onChange={(v) => set("tituloOriginal", v)} />
      <Field label="Ano" value={form.ano} onChange={(v) => set("ano", v)} />
      <Field label="Nota (0-10)" value={form.nota} onChange={(v) => set("nota", v)} />
      <Field label="Duração (min)" value={form.duracao} onChange={(v) => set("duracao", v)} />
      <Field label="Poster URL" value={form.poster} onChange={(v) => set("poster", v)} className="md:col-span-2" />
      <Field label="URLs Dublado (vírgula p/ múltiplos)" value={form.urlDub} onChange={(v) => set("urlDub", v)} className="md:col-span-2" mono />
      <Field label="URLs Legendado (vírgula p/ múltiplos)" value={form.urlLeg} onChange={(v) => set("urlLeg", v)} className="md:col-span-2" mono />
      <Field label="Sinopse" value={form.sinopse} onChange={(v) => set("sinopse", v)} className="md:col-span-2" multiline />
    </div>
  );
}

// ── Adicionar Série ───────────────────────────────────────────────────────────

function AdicionarSerie({ headers, onSaved }: { headers: Record<string, string>; onSaved?: (id: string) => void }) {
  const blank = { id: "", tmdbId: "", titulo: "", tituloOriginal: "", poster: "", background: "", sinopse: "", ano: "", nota: "", temporadas: "", tipo: "serie", generos: [] as any[] };
  const [form, setForm] = useState(blank);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState("");

  const fill = (item: TmdbResult) => {
    const ano = (item.first_air_date ?? item.release_date ?? "").slice(0, 4);
    const id = `s-${item.id}`;
    setForm({
      id,
      tmdbId: String(item.id),
      titulo: item.name ?? item.title ?? "",
      tituloOriginal: item.original_name ?? item.original_title ?? "",
      poster: item.poster_path ? `https://image.tmdb.org/t/p/w500${item.poster_path}` : "",
      background: "",
      sinopse: item.overview ?? "",
      ano,
      nota: item.vote_average ? String(item.vote_average.toFixed(1)) : "",
      temporadas: item.number_of_seasons ? String(item.number_of_seasons) : "",
      tipo: "serie",
      generos: item.genres ?? [],
    });
  };

  const set = (k: string, v: string) => setForm((f) => ({ ...f, [k]: v }));

  const save = async () => {
    if (!form.id || !form.titulo) return setMsg("ID e Título obrigatórios");
    setSaving(true);
    setMsg("");
    const r = await fetch("/api/admin/serie", {
      method: "POST",
      headers,
      body: JSON.stringify(form),
    });
    const d = await r.json();
    setMsg(r.ok ? `✓ Salvo: ${d.id}` : `Erro: ${d.error}`);
    if (r.ok) {
      const savedId = form.id;
      setForm(blank);
      setTimeout(() => onSaved?.(savedId), 600);
    }
    setSaving(false);
  };

  return (
    <div>
      <h2 className="text-xl font-bold mb-6">Adicionar Série / Anime / Desenho</h2>
      <TmdbSearch tipo="serie" headers={headers} onSelect={fill} />
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Field label="ID" value={form.id} onChange={(v) => set("id", v)} required />
        <Field label="TMDB ID" value={form.tmdbId} onChange={(v) => set("tmdbId", v)} />
        <Field label="Título" value={form.titulo} onChange={(v) => set("titulo", v)} required className="md:col-span-2" />
        <Field label="Título Original" value={form.tituloOriginal} onChange={(v) => set("tituloOriginal", v)} />
        <Field label="Ano" value={form.ano} onChange={(v) => set("ano", v)} />
        <Field label="Nota (0-10)" value={form.nota} onChange={(v) => set("nota", v)} />
        <Field label="Temporadas" value={form.temporadas} onChange={(v) => set("temporadas", v)} />
        <div>
          <label className="block text-xs text-zinc-400 mb-1.5">Tipo</label>
          <select
            value={form.tipo}
            onChange={(e) => set("tipo", e.target.value)}
            className="w-full bg-zinc-800 text-white px-3 py-2.5 rounded-lg border border-white/10 focus:border-white/30 outline-none text-sm"
          >
            <option value="serie">Série</option>
            <option value="anime">Anime</option>
            <option value="desenho">Desenho</option>
          </select>
        </div>
        <Field label="Poster URL" value={form.poster} onChange={(v) => set("poster", v)} className="md:col-span-2" />
        <Field label="Sinopse" value={form.sinopse} onChange={(v) => set("sinopse", v)} className="md:col-span-2" multiline />
      </div>
      <div className="flex items-center gap-4 mt-6">
        <button
          onClick={save}
          disabled={saving}
          className="flex items-center gap-2 bg-[#E50914] hover:bg-red-700 text-white font-bold px-6 py-2.5 rounded-lg transition disabled:opacity-50"
        >
          {saving ? <Loader2 size={16} className="animate-spin" /> : <Plus size={16} />}
          Salvar Série
        </button>
        <button onClick={() => setForm(blank)} className="text-zinc-400 hover:text-white text-sm transition">Limpar</button>
        {msg && <p className={`text-sm ${msg.startsWith("✓") ? "text-green-400" : "text-red-400"}`}>{msg}</p>}
      </div>
    </div>
  );
}

// ── Catálogo ──────────────────────────────────────────────────────────────────

function Catalogo({ headers, onEditEp }: { headers: Record<string, string>; onEditEp: (id: string) => void }) {
  const [tipo, setTipo] = useState<"filme" | "serie">("filme");
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const [data, setData] = useState<{ items: any[]; total: number; pages: number } | null>(null);
  const [loading, setLoading] = useState(false);
  const [editing, setEditing] = useState<any>(null);
  const [editMsg, setEditMsg] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    const endpoint = tipo === "filme" ? "/api/admin/filme" : "/api/admin/serie";
    const r = await fetch(`${endpoint}?q=${encodeURIComponent(q)}&page=${page}`, { headers });
    const d = await r.json();
    setData(r.ok && Array.isArray(d.items) ? d : null);
    setLoading(false);
  }, [tipo, q, page, headers]);

  useEffect(() => { load(); }, [load]);

  const del = async (id: string) => {
    if (!confirm("Excluir permanentemente?")) return;
    const endpoint = tipo === "filme" ? "/api/admin/filme" : "/api/admin/serie";
    await fetch(endpoint, { method: "DELETE", headers, body: JSON.stringify({ id }) });
    load();
  };

  const saveEdit = async () => {
    const endpoint = tipo === "filme" ? "/api/admin/filme" : "/api/admin/serie";
    const r = await fetch(endpoint, { method: "POST", headers, body: JSON.stringify(editing) });
    const d = await r.json();
    setEditMsg(r.ok ? "✓ Atualizado" : `Erro: ${d.error}`);
    if (r.ok) { setTimeout(() => { setEditing(null); setEditMsg(""); load(); }, 1000); }
  };

  return (
    <div>
      <h2 className="text-xl font-bold mb-4">Catálogo</h2>

      {/* Filters */}
      <div className="flex gap-2 mb-4">
        {(["filme", "serie"] as const).map((t) => (
          <button key={t} onClick={() => { setTipo(t); setPage(1); setData(null); }}
            className={`text-sm px-4 py-1.5 rounded-lg transition ${tipo === t ? "bg-[#E50914] text-white font-bold" : "bg-zinc-800 text-zinc-300 hover:bg-zinc-700"}`}>
            {t === "filme" ? "Filmes" : "Séries"}
          </button>
        ))}
        <input
          value={q}
          onChange={(e) => { setQ(e.target.value); setPage(1); }}
          placeholder="Buscar..."
          className="flex-1 max-w-xs bg-zinc-800 text-white px-3 py-1.5 rounded-lg outline-none border border-white/10 focus:border-white/30 text-sm"
        />
      </div>

      {loading && <Loader2 className="animate-spin text-white/40 my-8" />}

      {data && (
        <>
          <p className="text-xs text-zinc-500 mb-3">{data.total} itens</p>
          <div className="space-y-2">
            {data.items.map((item) => (
              <div key={item.id} className="flex items-center gap-3 bg-zinc-900 rounded-lg px-3 py-2.5 hover:bg-zinc-800 transition">
                {poster(item.poster, "w92") ? (
                  <Image src={poster(item.poster, "w92")!} alt="" width={28} height={42} className="rounded object-cover flex-none" />
                ) : (
                  <div className="w-7 h-10 bg-zinc-700 rounded flex-none" />
                )}
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate">{item.titulo}</p>
                  <p className="text-xs text-zinc-400">{item.ano ?? "—"} · ID: {item.id}
                    {tipo === "serie" && ` · ${item._count.episodios} eps · ${item.tipo}`}
                  </p>
                </div>
                <div className="flex items-center gap-2 flex-none">
                  {tipo === "serie" && (
                    <button
                      onClick={() => { onEditEp(item.id); }}
                      title="Episódios"
                      className="p-1.5 text-zinc-400 hover:text-white transition"
                    >
                      <ListVideo size={15} />
                    </button>
                  )}
                  <button onClick={() => setEditing({ ...item })} className="p-1.5 text-zinc-400 hover:text-white transition">
                    <Edit2 size={14} />
                  </button>
                  <button onClick={() => del(item.id)} className="p-1.5 text-zinc-400 hover:text-red-400 transition">
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>
            ))}
          </div>

          {/* Pagination */}
          <div className="flex items-center gap-3 mt-4">
            <button onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page === 1} className="p-1.5 disabled:opacity-40"><ChevronLeft size={18} /></button>
            <span className="text-sm text-zinc-400">{page} / {data.pages}</span>
            <button onClick={() => setPage((p) => Math.min(data.pages, p + 1))} disabled={page >= data.pages} className="p-1.5 disabled:opacity-40"><ChevronRight size={18} /></button>
          </div>
        </>
      )}

      {/* Edit modal */}
      {editing && (
        <div className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4">
          <div className="bg-zinc-900 border border-white/10 rounded-xl w-full max-w-2xl max-h-[90vh] overflow-y-auto p-6">
            <div className="flex items-center justify-between mb-5">
              <h3 className="font-bold text-lg">Editar: {editing.titulo}</h3>
              <button onClick={() => setEditing(null)}><X size={20} /></button>
            </div>
            {tipo === "filme" ? (
              <FilmeForm form={editing} set={(k, v) => setEditing((e: any) => ({ ...e, [k]: v }))} />
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <Field label="Título" value={editing.titulo} onChange={(v) => setEditing((e: any) => ({ ...e, titulo: v }))} required className="md:col-span-2" />
                <Field label="Poster URL" value={editing.poster ?? ""} onChange={(v) => setEditing((e: any) => ({ ...e, poster: v }))} className="md:col-span-2" />
                <div>
                  <label className="block text-xs text-zinc-400 mb-1.5">Tipo</label>
                  <select value={editing.tipo} onChange={(e) => setEditing((f: any) => ({ ...f, tipo: e.target.value }))}
                    className="w-full bg-zinc-800 text-white px-3 py-2.5 rounded-lg border border-white/10 outline-none text-sm">
                    <option value="serie">Série</option>
                    <option value="anime">Anime</option>
                    <option value="desenho">Desenho</option>
                  </select>
                </div>
              </div>
            )}
            <div className="flex items-center gap-3 mt-5">
              <button onClick={saveEdit} className="bg-[#E50914] hover:bg-red-700 text-white font-bold px-5 py-2 rounded-lg transition text-sm">Salvar</button>
              <button onClick={() => setEditing(null)} className="text-zinc-400 hover:text-white text-sm">Cancelar</button>
              {editMsg && <p className={`text-sm ${editMsg.startsWith("✓") ? "text-green-400" : "text-red-400"}`}>{editMsg}</p>}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Gerenciar Episódios ───────────────────────────────────────────────────────

function GerenciarEpisodios({ headers, initialSerieId, onLoaded }: {
  headers: Record<string, string>;
  initialSerieId?: string;
  onLoaded?: () => void;
}) {
  const [serieId, setSerieId] = useState("");
  const [serieNome, setSerieNome] = useState("");
  const [serieQ, setSerieQ] = useState("");
  const [serieResults, setSerieResults] = useState<SerieItem[]>([]);
  const [episodios, setEpisodios] = useState<EpItem[]>([]);
  const [newEp, setNewEp] = useState({ temporada: "1", numeroEp: "", titulo: "", urlDub: "", urlLeg: "" });
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState("");
  const [bulkJson, setBulkJson] = useState("");
  const [bulkMsg, setBulkMsg] = useState("");
  const [bulkSaving, setBulkSaving] = useState(false);
  const [showConsole, setShowConsole] = useState(false);
  const [editingEp, setEditingEp] = useState<string | null>(null);
  const [editEpData, setEditEpData] = useState({ temporada: "", numeroEp: "", titulo: "", urlDub: "", urlLeg: "" });
  const [editSaving, setEditSaving] = useState(false);
  const [editMsg, setEditMsg] = useState("");

  // Auto-load quando vem de "Add Série" ou catálogo
  useEffect(() => {
    if (initialSerieId) {
      loadEps(initialSerieId);
      onLoaded?.();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialSerieId]);

  const searchSerie = async () => {
    const r = await fetch(`/api/admin/serie?q=${encodeURIComponent(serieQ)}`, { headers });
    const d = await r.json();
    setSerieResults(d.items ?? []);
  };

  const loadEps = async (id: string, nome?: string) => {
    setSerieId(id);
    if (nome) setSerieNome(nome);
    setSerieResults([]);
    const r = await fetch(`/api/admin/episodio?serieId=${id}`, { headers });
    setEpisodios(await r.json());
  };

  const bulkImport = async () => {
    if (!serieId || !bulkJson.trim()) return;
    setBulkSaving(true);
    setBulkMsg("");
    try {
      const episodios = JSON.parse(bulkJson);
      const r = await fetch("/api/admin/episodio/bulk", {
        method: "POST",
        headers,
        body: JSON.stringify({ serieId, episodios }),
      });
      const d = await r.json();
      if (r.ok) {
        setBulkMsg(`✓ ${d.ok} episódios importados${d.errors ? `, ${d.errors} erros` : ""}`);
        setBulkJson("");
        loadEps(serieId);
      } else {
        setBulkMsg(`Erro: ${d.error}`);
      }
    } catch {
      setBulkMsg("JSON inválido — verifique o formato");
    }
    setBulkSaving(false);
  };

  const addEp = async () => {
    if (!serieId || !newEp.numeroEp || !newEp.temporada) return;
    setSaving(true);
    const r = await fetch("/api/admin/episodio", {
      method: "POST",
      headers,
      body: JSON.stringify({ serieId, ...newEp }),
    });
    const d = await r.json();
    setMsg(r.ok ? "✓ Episódio adicionado" : `Erro: ${d.error}`);
    if (r.ok) {
      setNewEp((p) => ({ ...p, numeroEp: String(Number(p.numeroEp) + 1), titulo: "", urlDub: "", urlLeg: "" }));
      loadEps(serieId);
    }
    setSaving(false);
    setTimeout(() => setMsg(""), 2000);
  };

  const delEp = async (id: string) => {
    await fetch("/api/admin/episodio", { method: "DELETE", headers, body: JSON.stringify({ id }) });
    loadEps(serieId);
  };

  const saveEdit = async () => {
    if (!editingEp) return;
    setEditSaving(true);
    const r = await fetch("/api/admin/episodio", {
      method: "POST",
      headers,
      body: JSON.stringify({ id: editingEp, serieId, ...editEpData }),
    });
    const d = await r.json();
    if (r.ok) {
      setEditMsg("✓ Salvo");
      loadEps(serieId);
      setTimeout(() => { setEditingEp(null); setEditMsg(""); }, 800);
    } else {
      setEditMsg(`Erro: ${d.error}`);
    }
    setEditSaving(false);
  };

  const byTemp = episodios.reduce((acc, ep) => {
    const k = ep.temporada;
    if (!acc[k]) acc[k] = [];
    acc[k].push(ep);
    return acc;
  }, {} as Record<number, EpItem[]>);

  return (
    <div>
      <h2 className="text-xl font-bold mb-4">Gerenciar Episódios</h2>

      {/* Serie picker */}
      <div className="flex gap-2 mb-4">
        <input
          value={serieQ}
          onChange={(e) => setSerieQ(e.target.value)}
          placeholder="Buscar série pelo nome..."
          className="flex-1 max-w-sm bg-zinc-800 text-white px-3 py-2 rounded-lg outline-none border border-white/10 focus:border-white/30 text-sm"
          onKeyDown={(e) => e.key === "Enter" && searchSerie()}
        />
        <button onClick={searchSerie} className="bg-zinc-700 hover:bg-zinc-600 px-4 rounded-lg transition text-sm">Buscar</button>
      </div>

      {serieResults.length > 0 && (
        <div className="bg-zinc-900 border border-white/10 rounded-lg overflow-hidden mb-4 max-h-48 overflow-y-auto">
          {serieResults.map((s) => (
            <button key={s.id} onClick={() => loadEps(s.id, s.titulo)}
              className="w-full text-left px-4 py-2.5 hover:bg-zinc-800 transition border-b border-white/5 last:border-0 text-sm">
              <span className="font-medium">{s.titulo}</span>
              <span className="text-zinc-400 ml-2 text-xs">{s.tipo} · {s._count.episodios} eps · {s.id}</span>
            </button>
          ))}
        </div>
      )}

      {serieId && (
        <>
          <p className="text-xs text-zinc-500 mb-4">
            Série: <code className="text-zinc-300">{serieNome || serieId}</code>
            <code className="text-zinc-600 ml-2 text-[10px]">{serieId}</code>
          </p>

          {/* Add episode form */}
          <div className="bg-zinc-900 border border-white/10 rounded-xl p-4 mb-6">
            <h3 className="text-sm font-semibold mb-3 text-zinc-300">Novo Episódio</h3>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-3">
              <Field label="Temporada" value={newEp.temporada} onChange={(v) => setNewEp((p) => ({ ...p, temporada: v }))} />
              <Field label="Ep. Nº" value={newEp.numeroEp} onChange={(v) => setNewEp((p) => ({ ...p, numeroEp: v }))} />
              <Field label="Título" value={newEp.titulo} onChange={(v) => setNewEp((p) => ({ ...p, titulo: v }))} className="md:col-span-2" />
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-3">
              <Field label="URLs Dub (vírgula p/ múltiplos)" value={newEp.urlDub} onChange={(v) => setNewEp((p) => ({ ...p, urlDub: v }))} mono />
              <Field label="URLs Leg (vírgula p/ múltiplos)" value={newEp.urlLeg} onChange={(v) => setNewEp((p) => ({ ...p, urlLeg: v }))} mono />
            </div>
            <div className="flex items-center gap-3">
              <button
                onClick={addEp}
                disabled={saving}
                className="flex items-center gap-2 bg-[#E50914] hover:bg-red-700 text-white font-bold px-5 py-2 rounded-lg transition disabled:opacity-50 text-sm"
              >
                {saving ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />}
                Adicionar
              </button>
              {msg && <p className={`text-sm ${msg.startsWith("✓") ? "text-green-400" : "text-red-400"}`}>{msg}</p>}
            </div>
          </div>

          {/* ── Importar em Lote ── */}
          <div className="bg-zinc-900 border border-white/10 rounded-xl p-4 mb-6">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-semibold text-zinc-300">Importar em Lote</h3>
              <button
                onClick={() => setShowConsole(!showConsole)}
                className="text-xs text-[#E50914] hover:underline"
              >
                {showConsole ? "Ocultar" : "Ver script do console"}
              </button>
            </div>

            {showConsole && (
              <div className="mb-4 bg-zinc-950 border border-white/10 rounded-lg p-3">
                <p className="text-xs text-zinc-400 mb-2">
                  Cole no console do painel MegaFlix (F12 → Console) enquanto estiver na página de episódios da série:
                </p>
                <pre className="text-[11px] text-green-300 font-mono whitespace-pre-wrap overflow-x-auto leading-relaxed">{`(function(){
  var eps = [];
  document.querySelectorAll('.edit_ep').forEach(function(btn){
    eps.push({
      ep:     btn.getAttribute('data-ep'),
      temp:   btn.getAttribute('data-temp'),
      titulo: btn.getAttribute('data-nome'),
      urlDub: btn.getAttribute('data-urlBR'),
      urlLeg: btn.getAttribute('data-urlENG')
    });
  });
  var json = JSON.stringify(eps, null, 2);
  console.log(json);
  if(navigator.clipboard) navigator.clipboard.writeText(json).then(function(){ console.log('✓ Copiado!'); });
  return eps.length + ' episódios extraídos';
})()`}</pre>
                <p className="text-[10px] text-zinc-500 mt-2">O JSON será copiado automaticamente para a área de transferência. Cole abaixo.</p>
              </div>
            )}

            <textarea
              value={bulkJson}
              onChange={(e) => setBulkJson(e.target.value)}
              placeholder={`Cole o JSON aqui:\n[\n  {"ep":"1","temp":"1","titulo":"Episódio 1","urlDub":"https://...","urlLeg":""},\n  ...\n]`}
              rows={6}
              className="w-full bg-zinc-800 text-white px-3 py-2.5 rounded-lg border border-white/10 focus:border-white/30 text-xs font-mono outline-none resize-none mb-3"
            />
            <div className="flex items-center gap-3">
              <button
                onClick={bulkImport}
                disabled={bulkSaving || !bulkJson.trim()}
                className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white font-bold px-5 py-2 rounded-lg transition disabled:opacity-50 text-sm"
              >
                {bulkSaving ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />}
                Importar Todos
              </button>
              {bulkMsg && <p className={`text-sm ${bulkMsg.startsWith("✓") ? "text-green-400" : "text-red-400"}`}>{bulkMsg}</p>}
            </div>
          </div>

          {/* Episodes list */}
          {Object.keys(byTemp).sort((a, b) => Number(a) - Number(b)).map((t) => (
            <div key={t} className="mb-4">
              <h4 className="text-sm font-semibold text-zinc-400 mb-2">Temporada {t}</h4>
              <div className="space-y-1.5">
                {byTemp[Number(t)].map((ep) => (
                  <div key={ep.id} className="bg-zinc-900 rounded-lg overflow-hidden">
                    <div className="flex items-center gap-3 px-3 py-2.5">
                      <span className="text-xs text-zinc-500 w-8 shrink-0">EP{ep.numeroEp}</span>
                      <span className="flex-1 text-sm truncate">{ep.titulo || <span className="text-zinc-500">Sem título</span>}</span>
                      <span className="text-xs text-zinc-500 hidden md:block">
                        {[ep.urlDub ? "Dub" : null, ep.urlLeg ? "Leg" : null].filter(Boolean).join(" · ") || "—"}
                      </span>
                      <button
                        onClick={() => {
                          if (editingEp === ep.id) {
                            setEditingEp(null);
                          } else {
                            setEditingEp(ep.id);
                            setEditEpData({
                              temporada: String(ep.temporada),
                              numeroEp: String(ep.numeroEp),
                              titulo: ep.titulo || "",
                              urlDub: ep.urlDub || "",
                              urlLeg: ep.urlLeg || "",
                            });
                            setEditMsg("");
                          }
                        }}
                        className={`p-1 transition ${editingEp === ep.id ? "text-yellow-400" : "text-zinc-500 hover:text-yellow-400"}`}
                      >
                        <Edit2 size={13} />
                      </button>
                      <button onClick={() => delEp(ep.id)} className="p-1 text-zinc-500 hover:text-red-400 transition">
                        <Trash2 size={13} />
                      </button>
                    </div>
                    {editingEp === ep.id && (
                      <div className="border-t border-white/10 px-3 py-3 space-y-2">
                        <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
                          <Field label="Temporada" value={editEpData.temporada} onChange={(v) => setEditEpData((p) => ({ ...p, temporada: v }))} />
                          <Field label="Ep. Nº" value={editEpData.numeroEp} onChange={(v) => setEditEpData((p) => ({ ...p, numeroEp: v }))} />
                          <Field label="Título" value={editEpData.titulo} onChange={(v) => setEditEpData((p) => ({ ...p, titulo: v }))} className="md:col-span-2" />
                        </div>
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                          <Field label="URL Dub" value={editEpData.urlDub} onChange={(v) => setEditEpData((p) => ({ ...p, urlDub: v }))} mono />
                          <Field label="URL Leg" value={editEpData.urlLeg} onChange={(v) => setEditEpData((p) => ({ ...p, urlLeg: v }))} mono />
                        </div>
                        <div className="flex items-center gap-3">
                          <button
                            onClick={saveEdit}
                            disabled={editSaving}
                            className="flex items-center gap-1.5 bg-[#E50914] hover:bg-red-700 text-white font-bold px-4 py-1.5 rounded-lg transition disabled:opacity-50 text-xs"
                          >
                            {editSaving ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
                            Salvar
                          </button>
                          <button
                            onClick={() => { setEditingEp(null); setEditMsg(""); }}
                            className="text-xs px-4 py-1.5 rounded-lg bg-zinc-700 hover:bg-zinc-600 transition"
                          >
                            Cancelar
                          </button>
                          {editMsg && <p className={`text-xs ${editMsg.startsWith("✓") ? "text-green-400" : "text-red-400"}`}>{editMsg}</p>}
                        </div>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          ))}
        </>
      )}
    </div>
  );
}

// ── Field component ───────────────────────────────────────────────────────────

function Field({
  label, value, onChange, required, className = "", multiline, mono,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  required?: boolean;
  className?: string;
  multiline?: boolean;
  mono?: boolean;
}) {
  const base = `w-full bg-zinc-800 text-white px-3 py-2.5 rounded-lg outline-none border border-white/10 focus:border-white/30 text-sm ${mono ? "font-mono text-xs" : ""}`;
  return (
    <div className={className}>
      <label className="block text-xs text-zinc-400 mb-1.5">
        {label}{required && <span className="text-red-400 ml-0.5">*</span>}
      </label>
      {multiline ? (
        <textarea value={value} onChange={(e) => onChange(e.target.value)} rows={3} className={base + " resize-none"} />
      ) : (
        <input value={value} onChange={(e) => onChange(e.target.value)} className={base} />
      )}
    </div>
  );
}
