"use client";

import { useSession } from "next-auth/react";
import { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import {
  Film, Tv, LayoutDashboard, Search, Plus, Trash2, Edit2,
  ChevronLeft, ChevronRight, Loader2, Check, X, ListVideo,
} from "lucide-react";
import Image from "next/image";

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
  const [tab, setTab] = useState<"dash" | "filme" | "serie" | "catalogo" | "episodios">("dash");
  const [preloadSerieId, setPreloadSerieId] = useState<string | undefined>();

  useEffect(() => {
    if (status === "unauthenticated") router.push("/login");
    if (status === "authenticated" && (session?.user as any)?.role !== "admin") router.push("/");
  }, [status, session, router]);

  if (status === "loading") return <div className="min-h-screen flex items-center justify-center"><Loader2 className="animate-spin text-white" /></div>;

  // Autorização agora é por sessão (cookie enviado automaticamente). Sem token client-side.
  const headers = { "Content-Type": "application/json" };

  return (
    <div className="min-h-screen bg-zinc-950 text-white pt-16">
      {/* Tab nav */}
      <nav className="flex gap-1 px-4 pt-4 pb-0 border-b border-white/5">
        {([
          { key: "dash", icon: LayoutDashboard, label: "Dashboard" },
          { key: "filme", icon: Film, label: "Add Filme" },
          { key: "serie", icon: Tv, label: "Add Série" },
          { key: "catalogo", icon: Search, label: "Catálogo" },
          { key: "episodios", icon: ListVideo, label: "Episódios" },
        ] as const).map(({ key, icon: Icon, label }) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={`flex items-center gap-2 text-sm px-4 py-2.5 rounded-t transition ${
              tab === key
                ? "bg-zinc-900 border border-b-transparent border-white/10 text-white font-semibold"
                : "text-zinc-400 hover:text-white"
            }`}
          >
            <Icon size={15} /> {label}
          </button>
        ))}
      </nav>

      <div className="px-4 py-6 md:px-8 max-w-5xl">
        {tab === "dash"      && <Dashboard headers={headers} />}
        {tab === "filme"     && <AdicionarFilme headers={headers} />}
        {tab === "serie"     && (
          <AdicionarSerie
            headers={headers}
            onSaved={(id) => { setPreloadSerieId(id); setTab("episodios"); }}
          />
        )}
        {tab === "catalogo"  && (
          <Catalogo
            headers={headers}
            onEditEp={(id) => { setPreloadSerieId(id); setTab("episodios"); }}
          />
        )}
        {tab === "episodios" && (
          <GerenciarEpisodios
            headers={headers}
            initialSerieId={preloadSerieId}
            onLoaded={() => setPreloadSerieId(undefined)}
          />
        )}
      </div>
    </div>
  );
}

// ── Dashboard ─────────────────────────────────────────────────────────────────

function Dashboard({ headers }: { headers: Record<string, string> }) {
  const [stats, setStats] = useState<any>(null);

  useEffect(() => {
    fetch("/api/admin/stats", { headers })
      .then((r) => r.json())
      .then((d) => { if (d && typeof d.filmes === "number") setStats(d); })
      .catch(() => {});
  }, []);

  const cards = stats ? [
    { label: "Filmes", value: stats.filmes ?? 0, color: "from-blue-600 to-blue-800" },
    { label: "Séries", value: stats.series ?? 0, color: "from-purple-600 to-purple-800" },
    { label: "Animes", value: stats.animes ?? 0, color: "from-pink-600 to-pink-800" },
    { label: "Desenhos", value: stats.desenhos ?? 0, color: "from-orange-600 to-orange-800" },
    { label: "Episódios", value: stats.episodios ?? 0, color: "from-green-600 to-green-800" },
    { label: "Usuários", value: stats.usuarios ?? 0, color: "from-zinc-600 to-zinc-800" },
  ] : [];

  return (
    <div>
      <h2 className="text-xl font-bold mb-6">Dashboard</h2>
      {!stats && <Loader2 className="animate-spin text-white/40" />}
      <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
        {cards.map((c) => (
          <div key={c.label} className={`bg-gradient-to-br ${c.color} rounded-xl p-5`}>
            <p className="text-white/60 text-xs uppercase tracking-wider mb-1">{c.label}</p>
            <p className="text-3xl font-black">{c.value.toLocaleString("pt-BR")}</p>
          </div>
        ))}
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
                  <div key={ep.id} className="flex items-center gap-3 bg-zinc-900 rounded-lg px-3 py-2.5">
                    <span className="text-xs text-zinc-500 w-8 shrink-0">EP{ep.numeroEp}</span>
                    <span className="flex-1 text-sm truncate">{ep.titulo || <span className="text-zinc-500">Sem título</span>}</span>
                    <span className="text-xs text-zinc-500 hidden md:block">
                      {[ep.urlDub ? "Dub" : null, ep.urlLeg ? "Leg" : null].filter(Boolean).join(" · ") || "—"}
                    </span>
                    <button onClick={() => delEp(ep.id)} className="p-1 text-zinc-500 hover:text-red-400 transition">
                      <Trash2 size={13} />
                    </button>
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
