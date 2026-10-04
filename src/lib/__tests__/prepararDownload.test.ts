import test from "node:test";
import assert from "node:assert/strict";
import { encontrarMidiaCompativel } from "../prepararDownload";
import { resolverFonteElectron, type FonteElectron, type MidiaElectron, type PortasResolucaoElectron } from "../resolverFonteElectron";

type Fonte = FonteElectron & { disponivel: boolean; semExtrator: boolean };
const fonte = (id: string, extra: Partial<Fonte> = {}): Fonte => ({ id, rotulo: "Opção", nativo: true, iframeDireto: false, iframeDesafio: false, disponivel: true, semExtrator: false, ...extra });
const boa = "https://fixture.invalid/good.mp4", ruim = "https://fixture.invalid/bad.mp4";
function portas(extra: Partial<PortasResolucaoElectron<Fonte>> = {}): PortasResolucaoElectron<Fonte> {
  return { sessao: "mesma-sessao", signal: new AbortController().signal,
    bridge: { extractStream: async () => ({ stream: boa, streamType: "mp4" }) },
    coordenada: async id => `https://embed.invalid/${id}`, preferida: () => 0, total: () => 1,
    fetch: async () => { throw Error("Não deve abrir sessão/token no caso nativo"); },
    parametroTentativa: () => "", lembrarTentativa: () => {}, erroSessao: () => Error("sessao_invalida"), descobrir: () => {}, ...extra };
}
function automatico(lista: Fonte[], p: PortasResolucaoElectron<Fonte>, extra: Record<string, unknown> = {}, idAtual = "current") {
  const diagnosticos: { id: string; reason: string }[] = [];
  const busca = encontrarMidiaCompativel<MidiaElectron<Fonte>, Fonte>(null, lista, {
    ativa: () => true, id: f => f.id, idAtual,
    verificar: async m => m.tipo === "mp4" && m.stream === boa,
    diagnosticar: (id, reason) => diagnosticos.push({ id, reason }),
    resolver: (f, signal, adicionar, aceitar) => resolverFonteElectron(f, { ...p, signal, aceitar,
      descobrir: (novas, parent) => { p.descobrir(novas, parent); adicionar(novas); } }), ...extra,
  });
  return { busca, diagnosticos };
}

test("AUTO e manual usam o resolvedor real: nativo prevalece sobre semExtrator, streamType normalizado", async () => {
  const atual = fonte("opaque-a"), compativel = fonte("opaque-b", { semExtrator: true });
  const p = portas({ bridge: { extractStream: async url => ({ stream: url.endsWith("opaque-b") ? boa : ruim, streamType: "mp4" }) } });
  const manual = await resolverFonteElectron(compativel, p);
  const original = structuredClone([atual, compativel]);
  const { busca, diagnosticos } = automatico([atual, compativel], p, {}, atual.id);
  const auto = await busca;
  assert.deepEqual(auto, manual);
  assert.equal(auto?.fonte.id, "opaque-b");
  assert.equal(auto?.tipo, "mp4");
  assert.deepEqual([atual, compativel], original, "probe não publica/muta fontes");
  assert.deepEqual(diagnosticos, [{ id: "opaque-a", reason: "current_incompatible" }, { id: "opaque-b", reason: "compatible" }]);
});

test("coordenadas, opções locais e chave renovada produzem a mesma mídia da seleção manual", async () => {
  const outer = fonte("opaque-parent", { iframeDesafio: true }), descobertas: Fonte[] = [], tentativas: number[] = [];
  const p = portas({ total: () => 2, coordenada: async (_id, _signal, t = 0) => { tentativas.push(t); return `https://embed.invalid/${t}`; },
    bridge: {
      prepareSuperflix: async url => url.endsWith("/0") ? { error: "bootstrap_failed" } : { sessionId: "local", options: [{ key: "bad", label: "Opção 1" }, { key: "good", label: "Opção 2" }] },
      resolveSuperflix: async (_sessao, key) => ({ stream: key === "bad" ? ruim : boa, tipo: "mp4", effectiveOptionKey: key === "good" ? "renewed" : key }),
    }, descobrir: novas => descobertas.push(...novas) });
  const auto = await automatico([outer], p).busca;
  assert.ok(auto);
  assert.deepEqual(tentativas, [0, 1]);
  const escolhida = descobertas.find(f => f.superflixLocal?.optionKey === "good")!;
  const manual = await resolverFonteElectron(escolhida, p);
  assert.equal(auto.stream, manual?.stream);
  assert.deepEqual(auto.fonte, manual?.fonte);
  assert.equal(auto.fonte.id, "sf-local:local:renewed");
  assert.equal(outer.iframeDesafio, true);
});

test("tentativa do servidor é preservada e fontes dinâmicas entram na mesma busca", async () => {
  const base = fonte("opaque-server", { nativo: false }), filha = fonte("opaque-child", { nativo: false }), pedidos: string[] = [];
  const p = portas({ parametroTentativa: () => "&tentativa=2", fetch: async (url, opts) => {
    pedidos.push(String(url));
    if (url === "/api/player/token") {
      assert.equal(JSON.parse(String(opts?.body)).sessao, "mesma-sessao");
      return Response.json({ playToken: "opaque-grant" });
    }
    return Response.json(String(url).includes("opaque-child") ? { stream: boa, tipo: "mp4_direct" } : { stream: ruim, tipo: "iframe", fontes: [filha] });
  } });
  const auto = await automatico([base], p).busca;
  assert.deepEqual(auto, await resolverFonteElectron(filha, p));
  assert.equal(auto?.fonte.id, filha.id);
  assert.ok(pedidos.filter(u => u.startsWith("/api/player/extract")).every(u => u.endsWith("&tentativa=2")));
  assert.ok(!pedidos.some(u => u.includes("/authorize") || u.includes("/fontes")), "sem nova sessão/anúncio");
});

test("timeout de IPC avança e cancela candidata; resposta tardia não troca a mídia escolhida", async () => {
  let responder!: (v: { stream: string; tipo: string }) => void, signalAntigo!: AbortSignal;
  const lenta = fonte("opaque-stuck"), seguinte = fonte("opaque-next");
  const p = portas({ coordenada: async (id, signal) => { if (id === lenta.id) signalAntigo = signal; return id; },
    bridge: { extractStream: async id => id === lenta.id ? new Promise(r => { responder = r; }) : { stream: boa, tipo: "mp4" } } });
  const { busca, diagnosticos } = automatico([lenta, seguinte], p, { prazos: { candidata: 20, preflight: 15, busca: 200 } });
  const auto = await busca;
  assert.equal(auto?.fonte.id, seguinte.id);
  assert.equal(signalAntigo.aborted, true);
  responder({ stream: boa, tipo: "mp4" });
  await new Promise(r => setImmediate(r));
  assert.equal(auto?.fonte.id, seguinte.id);
  assert.ok(diagnosticos.some(d => d.id === lenta.id && d.reason === "resolve_timeout"));
});

test("preflight tem prazo próprio; teto completo termina com IPC pendente", async () => {
  const p = portas({ bridge: { extractStream: async () => new Promise(() => {}) } });
  const inicio = performance.now();
  assert.equal(await automatico([fonte("opaque-stuck")], p, { prazos: { candidata: 1000, preflight: 15, busca: 35 } }).busca, null);
  assert.ok(performance.now() - inicio < 800);
  let primeira = true;
  const auto = encontrarMidiaCompativel<MidiaElectron<Fonte>, Fonte>(null, [fonte("opaque-slow"), fonte("opaque-good")], {
    ativa: () => true, id: f => f.id, idAtual: "current", prazos: { candidata: 100, preflight: 15, busca: 400 },
    verificar: () => primeira ? (primeira = false, new Promise(() => {})) : Promise.resolve(true),
    resolver: (f, signal) => resolverFonteElectron(f, { ...portas(), signal }),
  });
  assert.equal((await auto)?.fonte.id, "opaque-good");
});

test("atual válida evita resolução; cancelamento da busca não espera IPC", async () => {
  const atual = await resolverFonteElectron(fonte("opaque-current"), portas());
  assert.ok(atual);
  assert.equal(await encontrarMidiaCompativel(atual, [fonte("opaque-other")], {
    ativa: () => true, id: f => f.id, idAtual: "current", verificar: async () => true,
    resolver: async () => { throw Error("não deve resolver"); },
  }), atual);
  const ctrl = new AbortController();
  const busca = automatico([fonte("opaque-cancel")], portas({ bridge: { extractStream: () => new Promise(() => {}) } }), { signal: ctrl.signal }).busca;
  await new Promise(r => setImmediate(r));
  ctrl.abort();
  assert.equal(await busca, null);
});
