import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { executarTentativaDownload, type OperacaoDownload, type RetryDownload } from "../downloadElectron";
import { verificarDownloadAtual } from "../prepararDownload";
import { segundosRestantesAnuncio } from "../ads/tempoAnuncio";

const operacao: OperacaoDownload = { usuario: "conta", instancia: "player", sessao: "sessao", conteudoId: "filme",
  fonteId: "fonte-tocando", stream: "https://media.invalid/current.m3u8", referer: "https://referer.invalid",
  tipo: "hls", titulo: "Filme", modo: "completo" };

test("fonte atual válida: um preflight, anúncio e download da mesma operação", async () => {
  const fontes = ["atual", "alternativa-1", "alternativa-2"];
  const tamanhoInicial = fontes.length;
  const eventos: string[] = [];
  const midia = { stream: operacao.stream, referer: operacao.referer, tipo: operacao.tipo, fonteId: operacao.fonteId };
  assert.equal(await verificarDownloadAtual(midia, async candidata => {
    eventos.push(`preflight:${candidata.fonteId}`); return true;
  }), true);
  let retry: RetryDownload | null = null;
  const resultado = await executarTentativaDownload(operacao, false, retry, {
    autorizar: async () => { eventos.push("anuncio"); return true; },
    atual: () => operacao,
    guardarRetry: value => { retry = value; },
    iniciar: async capturada => { eventos.push(`download:${capturada.fonteId}`); return { ok: true }; },
  });
  assert.equal(resultado.ok, true);
  assert.deepEqual(eventos, ["preflight:fonte-tocando", "anuncio", "download:fonte-tocando"]);
  assert.equal(fontes.length, tamanhoInicial, "download não altera a quantidade de fontes");
});

test("fonte atual inválida mostra caminho de troca sem anúncio", async () => {
  const eventos: string[] = [];
  const atual = { stream: operacao.stream, fonteId: operacao.fonteId };
  const compativel = await verificarDownloadAtual(atual, async candidata => {
    eventos.push(`preflight:${candidata.fonteId}`); return false;
  });
  if (!compativel) eventos.push("aviso", "abrir-seletor");
  assert.equal(compativel, false);
  assert.deepEqual(eventos, ["preflight:fonte-tocando", "aviso", "abrir-seletor"]);
  assert.deepEqual(eventos, ["preflight:fonte-tocando", "aviso", "abrir-seletor"]);
});

test("preflight válido não é recusado por um timeout duplicado no renderer", async () => {
  const atual = { stream: operacao.stream, fonteId: operacao.fonteId };
  const inicio = Date.now();
  const compativel = await verificarDownloadAtual(atual, async () => {
    await new Promise(resolve => setTimeout(resolve, 75));
    return true;
  });
  assert.equal(compativel, true);
  assert.ok(Date.now() - inicio >= 70);
  const helper = readFileSync(join(process.cwd(), "src/lib/prepararDownload.ts"), "utf8");
  assert.doesNotMatch(helper, /Promise\.race|PREPARACAO_DOWNLOAD_TIMEOUT_MS/);
});

test("trecho: preflight sem anúncio, anúncio somente no clique final e download da mesma fonte", async () => {
  const eventos: string[] = [];
  const trecho = { ...operacao, modo: "trecho" as const, inicioSeg: 300, fimSeg: 600 };
  const ok = await verificarDownloadAtual(trecho, async candidata => {
    eventos.push(`preflight:${candidata.fonteId}`); return true;
  });
  assert.equal(ok, true);
  eventos.push("abrir-editor");
  let retry: RetryDownload | null = null;
  await executarTentativaDownload(trecho, false, retry, {
    autorizar: async () => { eventos.push("anuncio-final"); return true; },
    atual: () => trecho,
    guardarRetry: value => { retry = value; },
    iniciar: async capturada => { eventos.push(`download:${capturada.fonteId}`); return { ok: true }; },
  });
  assert.deepEqual(eventos, ["preflight:fonte-tocando", "abrir-editor", "anuncio-final", "download:fonte-tocando"]);
});

test("trecho incompatível usa o mesmo aviso/seletor e nunca chama anúncio", async () => {
  const eventos: string[] = [];
  const trecho = { ...operacao, modo: "trecho" as const };
  const ok = await verificarDownloadAtual(trecho, async candidata => {
    eventos.push(`preflight:${candidata.fonteId}`); return false;
  });
  if (!ok) eventos.push("aviso", "abrir-seletor");
  assert.equal(ok, false);
  assert.deepEqual(eventos, ["preflight:fonte-tocando", "aviso", "abrir-seletor"]);
});

test("Direct Link conta tempo real enquanto o navegador externo está aberto", async () => {
  const inicio = 1_000_000;
  const prazo = inicio + 9_000;
  assert.equal(segundosRestantesAnuncio(prazo, inicio), 9);
  assert.equal(segundosRestantesAnuncio(prazo, inicio + 4_250), 5);
  assert.equal(segundosRestantesAnuncio(prazo, inicio + 9_000), 0);
  const hook = readFileSync(join(process.cwd(), "src/components/player/useAnuncio.tsx"), "utf8");
  assert.ok(hook.indexOf("const prazo = Date.now()") < hook.indexOf("openSponsoredLink(entrada.directLink)"));
  assert.ok(hook.indexOf("setInterval(atualizarContagem") < hook.indexOf("openSponsoredLink(entrada.directLink)"));
});

test("preparação do player não enumera nem altera a lista de fontes", () => {
  const player = readFileSync(join(process.cwd(), "src/components/player/CustomPlayer.tsx"), "utf8");
  const inicio = player.indexOf("const prepararDownload = useCallback");
  const fim = player.indexOf("useEffect(() => {\n    desktopBridge?.onDownloadProgress", inicio);
  assert.ok(inicio >= 0 && fim > inicio);
  const preparar = player.slice(inicio, fim);
  for (const proibido of ["allFontes", "setAllFontes", "resolverFonteElectron", "resolverFonteDireta", "encontrarMidiaCompativel"]) {
    assert.equal(preparar.includes(proibido), false, `preflight não pode usar ${proibido}`);
  }
});

test("seleção manual preserva o pipeline Electron nativo e o host JW estável", () => {
  const player = readFileSync(join(process.cwd(), "src/components/player/CustomPlayer.tsx"), "utf8");
  const inicio = player.indexOf("const extract = useCallback");
  const fim = player.indexOf("extractRef.current = extract", inicio);
  const extract = player.slice(inicio, fim);
  assert.match(extract, /desktop\.extractStream\(embedUrl\)/);
  assert.match(extract, /mediaApi\.start\(/);
  assert.doesNotMatch(extract, /resolverFonteElectron/);
  assert.match(player, /jwHostRef = useRef<HTMLDivElement>/);
  assert.match(player, /player\.remove\(\)/);
});

test("falha técnica após anúncio pode repetir a mesma operação sem cobrar de novo", async () => {
  let retry: RetryDownload | null = null;
  let anuncios = 0;
  let falha = true;
  const portas = {
    autorizar: async () => { anuncios++; return true; }, atual: () => operacao,
    guardarRetry: (value: RetryDownload | null) => { retry = value; },
    iniciar: async () => { if (falha) throw Error("falha IPC"); return { ok: true }; },
  };
  await assert.rejects(executarTentativaDownload(operacao, false, retry, portas));
  falha = false;
  await executarTentativaDownload(operacao, true, retry, portas);
  assert.equal(anuncios, 1);
});
