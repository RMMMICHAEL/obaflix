"use client";

import { useEffect, useRef, useState } from "react";

type Addon = { key: string; name: string; enabled: boolean };
export type AddonSource = { id: string; title: string; available: boolean; reason?: string };
type Result = { addons?: Addon[]; sources?: AddonSource[]; error?: string; message?: string };
export type AddonsBridge = (request: { action: string; key?: string; sessao?: string; sourceId?: string }) => Promise<Result>;

export default function ElectronAddons({ bridge, sessao, onSelect }: {
  bridge: AddonsBridge; sessao: string | null;
  onSelect: (source: AddonSource, addon: Addon, sessao: string) => void;
}) {
  const [addons, setAddons] = useState<Addon[]>([]);
  const [sources, setSources] = useState<Record<string, AddonSource[]>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const generation = useRef(0);
  useEffect(() => {
    generation.current++;
    setSources({}); setNotice(""); setBusy(null);
    return () => { generation.current++; };
  }, [sessao]);

  async function run(action: string, addon?: Addon) {
    const gen = generation.current;
    setBusy(addon?.key || "list"); setNotice("");
    try {
      const result = await bridge({ action, key: addon?.key, ...(sessao ? { sessao } : {}) });
      if (gen !== generation.current) return;
      if (result.error) throw new Error(result.error);
      if (result.addons) { setAddons(result.addons); setSources({}); }
      if (action === "streams" && addon) {
        setSources(previous => ({ ...previous, [addon.key]: result.sources || [] }));
        setNotice(result.message || (result.sources?.length ? "" : "Nenhuma fonte encontrada neste addon para este título."));
      }
    } catch (error) {
      if (gen === generation.current) setNotice(error instanceof Error ? error.message : "Falha ao consultar addons.");
    } finally { if (gen === generation.current) setBusy(null); }
  }

  return (
    <details className="relative" onToggle={event => {
      if (event.currentTarget.open && !addons.length && !busy) void run("list");
    }}>
      <summary className="cursor-pointer rounded px-2 py-1 text-xs text-white/80 hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-red-500">
        Addons
      </summary>
      <section aria-label="Addons de reprodução" className="absolute bottom-10 right-0 z-[10000] w-80 max-w-[90vw] max-h-[65vh] overflow-y-auto rounded-lg border border-white/15 bg-zinc-950 p-4 shadow-xl">
        <h3 className="text-sm font-semibold text-white">Addons de reprodução</h3>
        <p className="mt-1 text-xs leading-relaxed text-white/60">Ative um addon e busque fontes para este título. Esta etapa reproduz fontes HTTPS; P2P e downloads de addons ainda não estão disponíveis.</p>
        {!sessao && <p className="mt-2 text-xs text-amber-300">Aguarde a autorização da reprodução para buscar fontes.</p>}
        {addons.map(addon => (
          <div key={addon.key} className="mt-4 border-t border-white/10 pt-3">
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm text-white">{addon.name}</span>
              <button type="button" disabled={!!busy} onClick={() => void run(addon.enabled ? "disable" : "enable", addon)}
                className="rounded px-2 py-1 text-xs text-white/75 hover:bg-white/10 disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-red-500">
                {addon.enabled ? "Desativar" : "Ativar"}
              </button>
            </div>
            {addon.enabled && (
              <button type="button" disabled={!!busy || !sessao} onClick={() => void run("streams", addon)}
                className="mt-2 rounded bg-red-600 px-3 py-2 text-xs text-white hover:bg-red-500 disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-white">
                {busy === addon.key ? "Consultando…" : "Buscar fontes"}
              </button>
            )}
            <ul className="mt-2 space-y-2">
              {(sources[addon.key] || []).map(source => (
                <li key={source.id}>
                  <button type="button" disabled={!source.available || !sessao || !!busy}
                    onClick={() => sessao && onSelect(source, addon, sessao)}
                    className="w-full rounded border border-white/15 px-3 py-2 text-left text-xs text-white hover:bg-white/10 disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-red-500">
                    {source.title}
                  </button>
                  {source.reason && <p className="mt-1 text-xs leading-relaxed text-white/60">{source.reason}</p>}
                </li>
              ))}
            </ul>
          </div>
        ))}
        {busy && <p role="status" className="mt-3 text-xs text-white/60">Consultando addon…</p>}
        <p role="status" aria-live="polite" className="mt-3 text-xs leading-relaxed text-amber-300">{notice}</p>
      </section>
    </details>
  );
}
