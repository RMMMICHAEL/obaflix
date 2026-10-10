import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  autorizarDownloadNaSessao, criarDownloadDoPlayer, resolverCandidataDeMidia,
  type FonteDeMidia, type MidiaResolvida, type SessaoDownloadDoPlayer,
} from "../../components/android/useFonteParaMidia";
import { procurarFonteDeDownload } from "../androidMedia";
import { AcaoInterrompida } from "../ads/acaoPatrocinada";
import { autorizarPorAnuncio } from "../ads/enforcement";
import { PLANO_GRATUITO } from "../planos";

const fonte = (id: string): FonteDeMidia => ({ id, nativo: true, disponivel: true, rotulo: `Servidor ${id}` });
const midia = (id: string, tipo = "mp4"): MidiaResolvida => ({
  stream: `https://media.example/${id}`, tipo, referer: `https://referer.example/${id}`,
  userAgent: "fixture-agent", expiresAt: 9_999_999_999_999,
});

function fixture(t: TestContext, opts: {
  atual?: MidiaResolvida;
  base?: string[];
  alternativas?: string[];
  previamenteExpandida?: boolean;
  status?: number;
  tipos?: Record<string, string>;
  falhas?: string[];
} = {}) {
  const base = (opts.base ?? ["atual", "b1"]).map(fonte);
  const extras = (opts.alternativas ?? ["a1"]).map(fonte);
  const lista = [...base, ...extras];
  const chamadas: Array<{ url: string; body: Record<string, unknown> }> = [];
  const extraidas: string[] = [];
  const sondadas: string[] = [];
  let liberacoes = 0;
  let consumos = 0;
  let expansoes = 0;
  let snapshot: SessaoDownloadDoPlayer = {
    sessao: "sessao-original", base,
    atual: { fonteId: "atual", midia: opts.atual ?? midia("atual") },
    alternativas: opts.previamenteExpandida ? Promise.resolve(lista) : undefined,
  };
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    chamadas.push({ url, body });
    if (body.acao === true) {
      if (opts.status) return new Response("{}", { status: opts.status });
      const { id, nome, descricao, ordem, ativo, ehPadrao, ...direitos } = PLANO_GRATUITO;
      void [nome, descricao, ordem, ativo, ehPadrao];
      const resultado = await autorizarPorAnuncio({
        userId: "u", tipo: "filme", finalidade: "download", concessao: String(body.concessao),
        alvo: { tipo: "filme", conteudoId: "f", temporada: null, episodio: null },
      }, {
        ativa: true,
        resolver: async () => ({ assinatura: { ativa: true, planoId: id, expiraEm: null }, direitos }),
        consumir: async (concessao) => { consumos++; return concessao === "concessao-unica" && consumos === 1; },
      });
      return Response.json({ sessao: body.sessao, liberado: resultado.liberado }, { status: resultado.liberado ? 200 : 403 });
    }
    if (body.alternativas) { expansoes++; return Response.json({ sessao: body.sessao, fontes: lista }); }
    assert.equal(url, "/api/player/fonte-nativa");
    if (opts.falhas?.includes(String(body.fonteId))) return new Response("{}", { status: 404 });
    return Response.json({ embedUrl: String(body.fonteId), tentativas: 1 });
  });
  const liberar = async () => { liberacoes++; return "concessao-unica"; };
  const acao = criarDownloadDoPlayer({
    capturar: () => snapshot,
    autorizar: (sessao, lib) => autorizarDownloadNaSessao(sessao, { conteudoId: "f", conteudoTipo: "filme" }, lib),
    resolver: (sessao, alvo) => resolverCandidataDeMidia(sessao, alvo, async (id) => {
      extraidas.push(id);
      return midia(id, opts.tipos?.[id] ?? "mp4");
    }, true),
    expandir: async (sessao) => {
      const r = await fetch("/api/player/fontes", { method: "POST", body: JSON.stringify({ sessao, alternativas: true }) });
      return (await r.json()).fontes;
    },
  });
  acao.reiniciarAcao("download");
  return {
    acao, liberar, chamadas, extraidas, sondadas,
    contadores: () => ({ liberacoes, consumos, expansoes }),
    trocarSessao: () => { snapshot = { sessao: "outra-sessao", base: [fonte("outra")] }; },
    procurar: async (aceita: string) => procurarFonteDeDownload({
      resolverFonte: (i) => acao.resolverFonte(i, "download", liberar),
      expandir: () => acao.expandirAlternativas("download"),
      sondar: async (f) => {
        const id = new URL(f.stream!).pathname.slice(1);
        sondadas.push(id);
        return { ok: id === aceita, tentarOutraFonte: true, motivo: "fonte_incompativel", escolhida: id };
      },
    }),
  };
}

test("MP4 atual aceita imediatamente, sem extração nem expansão", async (t) => {
  const f = fixture(t);
  const r = await f.procurar("atual");
  assert.equal(r.ok, true);
  assert.deepEqual(f.extraidas, []);
  assert.deepEqual(f.sondadas, ["atual"]);
  assert.deepEqual(f.contadores(), { liberacoes: 1, consumos: 1, expansoes: 0 });
  assert.equal(f.chamadas.length, 1);
});

for (const previamenteExpandida of [false, true]) {
  test(`HLS atual + MP4 alternativo: MP4 vence (expansão prévia=${previamenteExpandida})`, async (t) => {
    const f = fixture(t, { atual: midia("atual", "hls"), previamenteExpandida, tipos: { b1: "hls" } });
    assert.equal((await f.procurar("a1")).ok, true);
    assert.deepEqual(f.sondadas, ["a1"]);
    assert.deepEqual(f.extraidas, ["b1", "a1"]);
    assert.equal(f.contadores().expansoes, previamenteExpandida ? 0 : 1);
    assert.equal(await f.acao.expandirAlternativas("download"), null);
  });
}

test("HLS incompatível continua até HLS alternativo; não reextrai os HLS guardados", async (t) => {
  const f = fixture(t, { atual: midia("atual", "hls"), tipos: { b1: "hls", a1: "hls" } });
  assert.equal((await f.procurar("a1")).ok, true);
  assert.deepEqual(f.sondadas, ["atual", "b1", "a1"]);
  assert.deepEqual(f.extraidas, ["b1", "a1"]);
});

test("6 base incluindo atual + 6 alternativas, com bases maiores e deduplicação", async (t) => {
  const f = fixture(t, {
    base: ["atual", "b1", "atual", "b2", "b3", "b4", "b5", "b6", "b7"],
    alternativas: ["atual", "b1", "a1", "a2", "a3", "a4", "a5", "a6", "a7"],
    previamenteExpandida: true,
  });
  assert.equal((await f.procurar("inexistente")).ok, false);
  assert.deepEqual(f.sondadas, ["atual", "b1", "b2", "b3", "b4", "b5", "a1", "a2", "a3", "a4", "a5", "a6"]);
  assert.equal(f.extraidas.length, 11);
  assert.ok(!f.extraidas.includes("atual"));
});

test("fonte com resolução falha e MP4 recusado com tentarOutraFonte continuam", async (t) => {
  const f = fixture(t, { falhas: ["b1"], alternativas: ["a1", "a2"] });
  assert.equal((await f.procurar("a2")).ok, true);
  assert.deepEqual(f.sondadas, ["atual", "a1", "a2"]);
});

test("snapshot congelado e inicialização concorrente: mesma sessão, liberação e consumo únicos", async (t) => {
  const f = fixture(t);
  f.trocarSessao();
  await Promise.all([0, 1, 0, 1].map((i) => f.acao.resolverFonte(i, "download", f.liberar)));
  await f.acao.expandirAlternativas("download");
  assert.deepEqual(f.contadores(), { liberacoes: 1, consumos: 1, expansoes: 1 });
  assert.ok(f.chamadas.every((c) => c.body.sessao === "sessao-original"));
  assert.equal(f.chamadas.filter((c) => c.body.acao).length, 1);
  assert.equal(f.chamadas.filter((c) => "concessao" in c.body).length, 1);
  assert.ok(f.chamadas.every((c) => "sessao" in c.body), "nenhum pedido cria sessão");
});

test("expansão pendente do player é reutilizada e não modifica sua lista", async () => {
  let concluir!: (fontes: FonteDeMidia[]) => void;
  const listaPlayback = Object.freeze([fonte("atual"), fonte("a1")]);
  const pendente = new Promise<FonteDeMidia[]>((resolve) => { concluir = resolve; });
  let autorizacoes = 0;
  const acao = criarDownloadDoPlayer({
    capturar: () => ({ sessao: "s", base: [fonte("atual")], atual: { fonteId: "atual", midia: midia("atual", "hls") }, alternativas: pendente }),
    autorizar: async (_sessao, lib) => { await lib("download"); autorizacoes++; },
    resolver: async (_sessao, f) => midia(f.id),
    expandir: async () => { assert.fail("não deve repetir expansão em andamento"); return null; },
  });
  acao.reiniciarAcao("download");
  await acao.resolverFonte(0, "download", async () => "g");
  const expandindo = acao.expandirAlternativas("download");
  concluir([...listaPlayback]);
  assert.deepEqual(await expandindo, { inicio: 1, quantidade: 1 });
  assert.equal(autorizacoes, 1);
  assert.equal(listaPlayback.length, 2);
  assert.equal(await acao.expandirAlternativas("download"), null);
});

test("perda da sessão na expansão compartilhada encerra a procura", async () => {
  const acao = criarDownloadDoPlayer({
    capturar: () => ({ sessao: "s", base: [fonte("atual")], atual: { fonteId: "atual", midia: midia("atual", "hls") },
      alternativas: Promise.resolve().then(() => { throw new AcaoInterrompida("sessao_expirada"); }) }),
    autorizar: async () => {}, resolver: async () => null, expandir: async () => null,
  });
  acao.reiniciarAcao("download");
  const r = await procurarFonteDeDownload({
    resolverFonte: (i) => acao.resolverFonte(i, "download", async () => "g"),
    expandir: () => acao.expandirAlternativas("download"),
    sondar: async () => { assert.fail("não pode sondar após perder sessão"); return { ok: true }; },
  });
  assert.deepEqual(r, { ok: false, motivo: "sessao_expirada" });
});

for (const status of [403, 410]) {
  test(`autorização ${status} é terminal e não solicita liberação novamente`, async (t) => {
    const f = fixture(t, { status });
    const r = await f.procurar("a1");
    assert.equal(r.ok, false);
    await assert.rejects(f.acao.resolverFonte(1, "download", f.liberar), AcaoInterrompida);
    assert.equal(f.contadores().liberacoes, 1);
    assert.equal(f.chamadas.length, 1);
    assert.deepEqual(f.sondadas, []);
  });
}

test("sessão expirada durante resolução ou expansão encerra sem sondar HLS", async (t) => {
  const f = fixture(t, { atual: midia("atual", "hls") });
  t.mock.method(globalThis, "fetch", async (url: string) => new Response("{}", { status: url.includes("fonte-nativa") ? 410 : 200 }));
  assert.deepEqual(await f.procurar("atual"), { ok: false, motivo: "sessao_expirada" });
  assert.deepEqual(f.sondadas, []);
  const r = await procurarFonteDeDownload({
    resolverFonte: async (i) => i === 0 ? midia("atual", "hls") : null,
    expandir: async () => { throw new AcaoInterrompida("sessao_expirada"); },
    sondar: async () => { assert.fail("não pode sondar após expiração"); return { ok: true }; },
  });
  assert.deepEqual(r, { ok: false, motivo: "sessao_expirada" });
});

test("novo clique autoriza novamente; reiniciar transmissão não interfere no download", async (t) => {
  const f = fixture(t);
  await f.procurar("atual");
  f.acao.reiniciarAcao("transmissao");
  await f.acao.resolverFonte(0, "download", f.liberar);
  assert.equal(f.contadores().liberacoes, 1);
  f.acao.reiniciarAcao("download");
  await assert.rejects(f.acao.resolverFonte(0, "download", f.liberar), AcaoInterrompida);
  assert.equal(f.contadores().liberacoes, 2);
});

test("player só captura playback e encaminha download; Cast permanece na fonte atual", () => {
  const src = readFileSync("src/components/player/CustomPlayer.tsx", "utf8");
  const captura = src.slice(src.indexOf("const capturarSessaoDoPlayer"), src.indexOf("const downloadAndroid"));
  const rota = src.slice(src.indexOf("const resolverMidiaAndroid"), src.indexOf("const rotuloDiag"));
  for (const trecho of [captura, rota, readFileSync("src/components/android/useFonteParaMidia.ts", "utf8")]) {
    assert.doesNotMatch(trecho, /\b(?:switchFonte|setFonteIdx|setAllFontes|extractRef)\s*[.(]/);
    assert.doesNotMatch(trecho, /(?:directStreamRef|streamTipoRef|streamRefererRef|streamExpiresAtRef)\.current\s*=(?!=)/);
    assert.doesNotMatch(trecho, /jw(?:Ref)?[\s\S]{0,20}\.(?:setup|load|remove)\(/);
  }
  assert.match(rota, /finalidade === "download"[\s\S]*downloadAndroid\.resolverFonte[\s\S]*fonteAtualParaMidia/);
  const acoes = src.slice(src.indexOf("<AndroidMediaActions"), src.indexOf("{/* Servidor dropdown */}"));
  assert.match(acoes, /resolverFonte=\{resolverMidiaAndroid\}/);
  assert.match(acoes, /reiniciarAcao=\{downloadAndroid\.reiniciarAcao\}/);
  assert.match(acoes, /expandirAlternativas=\{downloadAndroid\.expandirAlternativas\}/);
});

test("página individual mantém seu caminho e player exige ponte isolada", () => {
  const src = readFileSync("src/components/android/useFonteParaMidia.ts", "utf8");
  const pagina = src.slice(src.indexOf("const resolverFonte = useCallback"), src.indexOf("const downloadDoPlayer"));
  assert.match(pagina, /abrirSessao\(finalidade, liberar\)/);
  assert.match(pagina, /ponte\.extractStream!\(embedUrl\)/);
  const player = src.slice(src.indexOf("const downloadDoPlayer"));
  assert.match(player, /extractStreamForDownload/);
  assert.doesNotMatch(player, /\.extractStream[!(]/);
});
