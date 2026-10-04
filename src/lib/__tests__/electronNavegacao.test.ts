import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";
import ts from "typescript";
import { executarFluxoDeAnuncio } from "../ads/fluxoDoCliente";
import { controlarMidia } from "../prepararDownload";

const ler = (arquivo: string) => readFileSync(join(process.cwd(), arquivo), "utf8");
const player = ler("src/components/player/CustomPlayer.tsx");
test("grid e continuar assistindo usam páginas que montam player com progresso e identidade próprios", () => {
  assert.ok(ler("src/app/serie/[id]/EpisodeGrid.tsx").includes('href={`/assistir/serie/${serieId}/t${ep.temporada}/ep${ep.numeroEp}`}'));
  const continuar = ler("src/components/ui/ContinuarAssistindo.tsx");
  assert.ok(continuar.includes('`/assistir/filme/${item.id}`'));
  assert.ok(continuar.includes('`/assistir/serie/${item.id}/t${item.temporada}/ep${item.numeroEp}`'));
  const serie = ler("src/app/assistir/serie/[id]/[temp]/[ep]/page.tsx");
  const filme = ler("src/app/assistir/filme/[id]/page.tsx");
  assert.ok(serie.includes('key={episodio.id}'));
  assert.ok(filme.includes('key={filme.id}'));
  for (const pagina of [serie, filme]) assert.ok(pagina.includes('initialProgressoSeg={historico?.progressoSeg ?? 0}'));
});
test("anterior, próximo, contador e auto-next dos dois players usam a transição central", () => {
  assert.equal((player.match(/navegarEpisodioRef\.current\(url\)/g) ?? []).length, 2, "auto-next JW e vídeo nativo");
  assert.equal((player.match(/navegarEpisodioRef\.current\(nextUrl\)/g) ?? []).length, 3, "próximo cabeçalho, controle e contador");
  assert.ok(player.includes('navegarEpisodioRef.current(prevUrl)'));
  assert.ok(player.includes('saveProgressRef.current().catch(() => {}).then(() => router.push(url)).catch(() => {})'));
  assert.ok(player.includes('setNavegandoEpisodio(true)'));
  assert.ok(player.includes('const [carregamentoInicial, setCarregamentoInicial] = useState(true)'));
  assert.ok(player.includes('1000 - (Date.now() - entradaEmRef.current)'));
});
test("mídia só abre depois do fluxo; recuperação permanece em memória", () => {
  const trecho = player.slice(player.indexOf('const abrirSessao = useCallback'), player.indexOf('abrirSessaoRef.current = abrirSessao'));
  assert.ok(trecho.indexOf('await executarFluxoDeAnuncio') < trecho.indexOf('await fetch("/api/player/fontes"'));
  assert.ok(trecho.includes('instanciaDaChamada === instanciaPlaybackRef.current'));
  assert.ok(player.includes('recuperacaoPlaybackRef.current = null'));
  assert.ok(!/localStorage[^\n]*(recuperacao|instancia)/.test(player));
  assert.ok(player.includes('if (retry) iniciarDownload(retry.operacao.modo, true)'));
  assert.ok(ler("src/components/player/useAnuncio.tsx").includes('if (resolverRef.current !== resolve) return'));
});

const codigoSessao = ts.transpileModule(player.slice(player.indexOf("const abrirSessao = useCallback"), player.indexOf("  abrirSessaoRef.current = abrirSessao")), {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;
const codigoNavegacao = player.slice(player.indexOf("  navegarEpisodioRef.current = (url) =>"), player.indexOf("  // Carregamento inicial: a cada mudança"));
function adiado<T>() {
  let resolver!: (valor: T) => void;
  let rejeitar!: (erro: unknown) => void;
  const promessa = new Promise<T>((resolve, reject) => { resolver = resolve; rejeitar = reject; });
  return { promessa, resolver, rejeitar };
}
function montar() {
  const eventos: string[] = [];
  const ctrl = new AbortController();
  let agora = 2000;
  const contexto: any = {
    useCallback: (fn: unknown) => fn, executarFluxoDeAnuncio, controlarMidia,
    observarFaseNavegacao: (_nome: string, acao: () => unknown) => acao(), registrarFaseNavegacao: () => {},
    conteudoId: "serie", conteudoTipo: "serie", temporada: 1, numeroEp: 2, ambiente: "electron",
    montadoRef: { current: true }, unmountedRef: { current: false }, instanciaPlaybackRef: { current: "ep2" },
    recuperacaoPlaybackRef: { current: null }, entradaEmRef: { current: 2000 }, retryDownloadRef: { current: null },
    sessaoFontesRef: { current: null }, sessaoAbortRef: { current: ctrl }, prepararAbortRef: { current: null }, extractAbortRef: { current: null },
    urlNativaRef: { current: new Map() }, tentativaNativaRef: { current: new Map() }, totalTentativasRef: { current: new Map() }, ultimaReaberturaRef: { current: 0 },
    portasDeAnuncioRef: { current: {
      autorizar: async () => ({ decisao: "PERMITIDO" }),
      concluir: async () => "concessao",
      exibirAnuncio: async () => { eventos.push("modal"); return { concluido: true }; },
    } },
    Date: { now: () => agora },
    setTimeout: (fn: () => void, ms: number) => { eventos.push(`loading:${ms}`); agora += ms; queueMicrotask(fn); },
    setPodeBaixarPeloPlano: () => eventos.push("direitos"), setSessaoFontes: () => eventos.push("sessao"), setAllFontes: () => eventos.push("fontes"),
    setNavegandoEpisodio: () => eventos.push("blackout"),
    jwRef: { current: { pause: () => Promise.reject(new DOMException("cancelado", "AbortError")) } },
    videoRef: { current: { pause: () => { throw new DOMException("cancelado", "AbortError"); } } },
    saveProgressRef: { current: async () => { eventos.push("saveProgress"); } },
    router: { push: (url: string) => eventos.push(`push:${url}`) }, navegarEpisodioRef: { current: null },
    fetch: async () => ({ ok: true, json: async () => ({ sessao: "sessao", fontes: [{ id: "fonte" }] }) }),
    AnuncioRecusado: class extends Error { name = "AnuncioRecusado"; },
    AnuncioIndisponivel: class extends Error { name = "AnuncioIndisponivel"; },
  };
  vm.runInNewContext(`${codigoSessao}\nglobalThis.abrir = abrirSessao;\n${codigoNavegacao}`, contexto);
  return { contexto, eventos, ctrl };
}
for (const [acao, url] of [["Próximo manual", "/ep3"], ["auto-next", "/ep3"], ["anterior", "/ep1"]]) {
  test(`${acao}: autorização atrasada após navegação termina em null, sem modal/erro/rejeição`, async () => {
    const { contexto, eventos, ctrl } = montar();
    const autorizacao = adiado<any>();
    contexto.portasDeAnuncioRef.current.autorizar = () => autorizacao.promessa;
    const abrindo = contexto.abrir(ctrl.signal);
    contexto.navegarEpisodioRef.current(url);
    autorizacao.resolver({ decisao: "ANUNCIO_NECESSARIO", desafioId: "desafio", directLink: "https://anuncio.invalid" });
    assert.equal(await abrindo, null);
    await new Promise(r => setImmediate(r));
    assert.equal(ctrl.signal.aborted, true);
    assert.deepEqual(eventos.filter(e => !e.startsWith("loading:")), ["blackout", "saveProgress", `push:${url}`]);
    contexto.navegarEpisodioRef.current(url);
    assert.equal(eventos.filter(e => e.startsWith("push:")).length, 1, "clique duplicado ignorado");
    const proximo = montar();
    proximo.contexto.portasDeAnuncioRef.current.autorizar = async () => ({ decisao: "ANUNCIO_NECESSARIO", desafioId: "novo", directLink: "https://anuncio.invalid" });
    assert.ok(await proximo.contexto.abrir(proximo.ctrl.signal));
    assert.deepEqual(proximo.eventos, ["loading:1000", "modal", "direitos", "sessao", "fontes"]);
  });
}
test("fontes/json atrasados ou abortados após Próximo não publicam sessão nem lançam DOMException", async () => {
  for (const rejeitar of [false, true]) {
    const { contexto, eventos, ctrl } = montar();
    const json = adiado<any>();
    const lendo = adiado<boolean>();
    contexto.fetch = async () => ({ ok: true, json: () => { lendo.resolver(true); return json.promessa; } });
    const abrindo = contexto.abrir(ctrl.signal);
    await lendo.promessa;
    contexto.navegarEpisodioRef.current("/ep3");
    if (rejeitar) json.rejeitar(new DOMException("cancelado", "AbortError"));
    else json.resolver({ sessao: "obsoleta", fontes: [{ id: "obsoleta" }] });
    assert.equal(await abrindo, null);
    await new Promise(r => setImmediate(r));
    assert.equal(contexto.sessaoFontesRef.current, null);
    assert.ok(!eventos.includes("fontes"));
  }
});
test("cancelamento tipado não mascara recusa comercial, JSON inválido ou sessão ativa vazia", async () => {
  const comercial = montar();
  comercial.contexto.fetch = async () => ({ ok: false, status: 403, json: async () => ({ codigo: "conteudo_indisponivel_no_plano" }) });
  await assert.rejects(comercial.contexto.abrir(comercial.ctrl.signal), { name: "LiberacaoComercial", motivo: "conteudo_indisponivel_no_plano" });
  const invalida = montar();
  invalida.contexto.fetch = async () => ({ ok: true, json: async () => { throw new SyntaxError("json inválido"); } });
  await assert.rejects(invalida.contexto.abrir(invalida.ctrl.signal), { name: "SyntaxError" });
  const vazia = montar();
  vazia.contexto.fetch = async () => ({ ok: true, json: async () => ({ fontes: [] }) });
  assert.equal((await vazia.contexto.abrir(vazia.ctrl.signal)).length, 0);
  assert.ok(!player.includes('throw new DOMException("Aborted"'));
});
test("fetch abortado durante Próximo e JSON de instância substituída retornam null", async () => {
  const abortada = montar();
  const resposta = adiado<any>();
  const iniciou = adiado<boolean>();
  abortada.contexto.fetch = () => { iniciou.resolver(true); return resposta.promessa; };
  const carregando = abortada.contexto.abrir(abortada.ctrl.signal);
  await iniciou.promessa;
  abortada.contexto.navegarEpisodioRef.current("/ep3");
  resposta.rejeitar(new DOMException("fetch cancelado", "AbortError"));
  assert.equal(await carregando, null);
  const substituida = montar();
  const json = adiado<any>();
  const leu = adiado<boolean>();
  substituida.contexto.fetch = async () => ({ ok: true, json: () => { leu.resolver(true); return json.promessa; } });
  const antiga = substituida.contexto.abrir(substituida.ctrl.signal);
  await leu.promessa;
  substituida.contexto.instanciaPlaybackRef.current = "outra-instancia";
  json.resolver({ sessao: "antiga", fontes: [{ id: "antiga" }] });
  assert.equal(await antiga, null);
  assert.ok(!substituida.eventos.includes("fontes"));
});

test("teardown Electron remove uma única vez e cleanup antigo não remove a instância nova", () => {
  const codigo = ts.transpileModule(player.slice(player.indexOf("  const removerJWElectron = useCallback"), player.indexOf("  // Fluxo de anuncio.")), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  let remocoes = 0;
  const ref: any = { current: null };
  const contexto: any = { useCallback: (fn: unknown) => fn, jwRef: ref, controlarMidia,
    observarFaseNavegacao: (_nome: string, acao: () => unknown) => acao() };
  vm.runInNewContext(`${codigo}\nglobalThis.remover = removerJWElectron;`, contexto);
  const antigo = { remove: () => { remocoes++; contexto.remover(antigo); } };
  ref.current = antigo;
  contexto.remover(antigo);
  contexto.remover(antigo);
  assert.equal(remocoes, 1, "remove reentrante e cleanup duplicado são idempotentes");
  const novo = { remove: () => { remocoes++; } };
  ref.current = novo;
  contexto.remover(antigo);
  assert.equal(ref.current, novo);
  assert.equal(remocoes, 1);
  contexto.remover(novo);
  assert.equal(remocoes, 2);
});
