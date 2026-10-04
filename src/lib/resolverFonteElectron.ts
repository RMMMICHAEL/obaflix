/** Resolução Electron única, sem React, anúncio ou abertura de sessão. */
export interface FonteElectron {
  id: string;
  rotulo: string;
  nativo: boolean;
  iframeDireto: boolean;
  iframeDesafio: boolean;
  superflixLocal?: { sessionId: string; optionKey: string; parentId: string; isFile: boolean };
}
type Legenda = { file: string; label?: string; kind?: string; default?: boolean; referer?: string };
type Dados = {
  stream?: string; tipo?: string; streamType?: string; streamToken?: string; referer?: string;
  error?: string; expiresAt?: number | null; subtitles?: (Legenda & { url?: string; language?: string })[];
  effectiveOptionKey?: string; effectiveOptionLabel?: string; effectiveOptionIsFile?: boolean;
};
export type MidiaElectron<F extends FonteElectron> = {
  stream: string; tipo: "hls" | "mp4" | "iframe"; fonte: F; referer?: string;
  expiresAt?: number | null; subtitles?: Legenda[]; tentativa?: number;
  solicitadaId?: string;
};
type Preparado = { sessionId?: string; options?: { key: string; label: string; isFile?: boolean }[]; error?: string };
export type PortasResolucaoElectron<F extends FonteElectron> = {
  sessao: string; signal: AbortSignal;
  bridge: {
    extractStream?: (url: string) => Promise<Dados>;
    prepareSuperflix?: (url: string) => Promise<Preparado>;
    resolveSuperflix?: (sessao: string, opcao: string) => Promise<Dados>;
  };
  coordenada: (id: string, signal: AbortSignal, tentativa?: number) => Promise<string>;
  preferida: (id: string) => number;
  total: (id: string) => number;
  fetch: typeof fetch;
  parametroTentativa: (id: string) => string;
  lembrarTentativa: (id: string, dados: { tentativa?: unknown } | null) => void;
  erroSessao: (motivo?: string) => Error;
  descobrir: (fontes: F[], parentId?: string) => void;
  aceitar?: (midia: MidiaElectron<F>) => Promise<boolean>;
};

function falha(code = "resolve_failed"): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}

export async function resolverFonteElectron<F extends FonteElectron>(fonte: F, p: PortasResolucaoElectron<F>): Promise<MidiaElectron<F> | null> {
  const ativa = () => !p.signal.aborted;
  const converter = (data: Dados, selecionada: F, servidor = false): MidiaElectron<F> => {
    const solicitadaId = selecionada.id;
    if (data.error) throw falha();
    const tipoOriginal = data.streamType ?? data.tipo ?? "hls";
    const tipo = tipoOriginal === "mp4_direct" ? "mp4" : tipoOriginal === "hls_direct" ? "hls" : tipoOriginal;
    let stream = data.stream;
    if (servidor && !["iframe", "mp4_direct", "hls_direct"].includes(tipoOriginal)) {
      if (!data.streamToken) throw falha();
      stream = data.streamToken.startsWith("/") ? data.streamToken : `/api/player/proxy?t=${encodeURIComponent(data.streamToken)}`;
    }
    if (!stream || !["hls", "mp4", "iframe"].includes(tipo)) throw falha();
    if (selecionada.superflixLocal) {
      const local = selecionada.superflixLocal;
      const key = data.effectiveOptionKey || local.optionKey;
      selecionada = { ...selecionada, id: `sf-local:${local.sessionId}:${key}`,
        rotulo: data.effectiveOptionLabel || selecionada.rotulo,
        superflixLocal: { ...local, optionKey: key, isFile: data.effectiveOptionIsFile ?? local.isFile } };
    }
    return { stream, tipo: tipo as MidiaElectron<F>["tipo"], fonte: selecionada, solicitadaId, referer: data.referer,
      expiresAt: data.expiresAt, subtitles: (data.subtitles ?? []).map(t => ({ ...t, file: t.file ?? t.url ?? "", label: t.label || t.language || "Legenda" })) };
  };
  const aceitar = async (midia: MidiaElectron<F>) => {
    if (!ativa()) return null;
    if (p.aceitar && !await p.aceitar(midia)) throw falha("preflight_failed");
    return ativa() ? midia : null;
  };
  const coordenadas = async (tentar: (url: string) => Promise<MidiaElectron<F> | null>) => {
    const feitas = new Set<number>();
    let erro: unknown = falha();
    for (let passo = 0; passo < 4 && ativa(); passo++) {
      const total = Math.min(4, Math.max(1, p.total(fonte.id)));
      const t = passo === 0 ? p.preferida(fonte.id) : Array.from({ length: total }, (_, i) => i).find(i => !feitas.has(i));
      if (t === undefined) break;
      feitas.add(t);
      try {
        const url = await p.coordenada(fonte.id, p.signal, t);
        if (!ativa()) return null;
        const midia = await tentar(url);
        if (!ativa()) return null;
        if (midia) return { ...midia, tentativa: t };
      } catch (e) { if (!ativa()) return null; erro = e; }
      if (feitas.size >= p.total(fonte.id)) break;
    }
    if (!ativa()) return null;
    throw erro;
  };

  if (!ativa()) return null;
  if (fonte.superflixLocal && p.bridge.resolveSuperflix) {
    const local = fonte.superflixLocal;
    return aceitar(converter(await p.bridge.resolveSuperflix(local.sessionId, local.optionKey), fonte));
  }
  if (fonte.iframeDesafio && p.bridge.prepareSuperflix && p.bridge.resolveSuperflix) {
    return coordenadas(async url => {
      const prepared = await p.bridge.prepareSuperflix!(url);
      if (!ativa()) return null;
      if (prepared.error || !prepared.sessionId || !prepared.options?.length) throw falha();
      const sessionId = prepared.sessionId;
      const locais = prepared.options.map(o => ({ ...fonte, id: `sf-local:${sessionId}:${o.key}`, rotulo: o.label,
        iframeDesafio: false, iframeDireto: false,
        superflixLocal: { sessionId, optionKey: o.key, parentId: fonte.id, isFile: !!o.isFile } }));
      p.descobrir(locais, fonte.id);
      let erro: unknown = falha();
      for (const local of locais) {
        if (!ativa()) return null;
        try { const data = await p.bridge.resolveSuperflix!(sessionId, local.superflixLocal.optionKey); return await aceitar(converter(data, local)); }
        catch (e) { if (!ativa()) return null; erro = e; }
      }
      throw erro;
    });
  }
  if (fonte.iframeDireto) {
    const stream = await p.coordenada(fonte.id, p.signal);
    return aceitar({ stream, tipo: "iframe", fonte });
  }
  // semExtrator não sobrepõe capacidade nativa: mesma prioridade do seletor.
  if (fonte.nativo && p.bridge.extractStream) {
    return coordenadas(async url => aceitar(converter(await p.bridge.extractStream!(url), fonte)));
  }
  const tokenRes = await p.fetch("/api/player/token", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessao: p.sessao, fonteId: fonte.id }), signal: p.signal });
  if (!ativa()) return null;
  const token = await tokenRes.json();
  if (!tokenRes.ok) { if (token.codigo === "sessao_invalida") throw p.erroSessao(token.motivo); throw falha(); }
  const res = await p.fetch(`/api/player/extract?sessao=${encodeURIComponent(p.sessao)}&fonteId=${encodeURIComponent(fonte.id)}`
    + `&playToken=${encodeURIComponent(token.playToken)}${p.parametroTentativa(fonte.id)}`, { signal: p.signal });
  const data = await res.json();
  if (!ativa()) return null;
  p.lembrarTentativa(fonte.id, data);
  if (Array.isArray(data.fontes)) p.descobrir(data.fontes);
  if (!res.ok) { if (data.codigo === "sessao_invalida") throw p.erroSessao(data.motivo); throw falha(); }
  return aceitar(converter(data, fonte, true));
}
