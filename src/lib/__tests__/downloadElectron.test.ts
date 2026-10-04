import test from "node:test";
import assert from "node:assert/strict";
import { executarTentativaDownload, podeRepetirDownload, JANELA_RETRY_DOWNLOAD_MS, type OperacaoDownload, type RetryDownload } from "../downloadElectron";

const operacao: OperacaoDownload = { usuario: "conta", instancia: "player", sessao: "sessao", conteudoId: "serie",
  temporada: 1, numeroEp: 1, fonteId: "fonte", stream: "https://midia.test/a", referer: "https://midia.test",
  tipo: "hls", titulo: "Série", modo: "trecho", inicioSeg: 679, fimSeg: 750 };
test("retry vale cinco minutos somente para a mesma operação", () => {
  const retry = { operacao, expiraEm: 100 + JANELA_RETRY_DOWNLOAD_MS };
  assert.equal(podeRepetirDownload(retry, { ...operacao }, 101), true);
  for (const mudanca of [{ usuario: "outra" }, { instancia: "outro" }, { sessao: "outra" }, { conteudoId: "outro" },
    { numeroEp: 2 }, { modo: "completo" as const }, { inicioSeg: 680 }, { fimSeg: 751 }, { fonteId: "outra" },
    { stream: "https://midia.test/b" }, { referer: "outro" }]) {
    assert.equal(podeRepetirDownload(retry, { ...operacao, ...mudanca }, 101), false);
  }
  assert.equal(podeRepetirDownload(retry, operacao, retry.expiraEm), false);
  assert.equal(podeRepetirDownload(null, operacao, 101), false);
});

test("concessão consumida antes do IPC; falha técnica permite retry e clique normal cobra novamente", async () => {
  let retry: RetryDownload | null = null;
  let autorizacoes = 0;
  const ordem: string[] = [];
  let falha = true;
  const portas = {
    autorizar: async () => { autorizacoes++; ordem.push("anuncio", "fontes-download-consumiu"); return true; },
    atual: () => operacao,
    guardarRetry: (r: RetryDownload | null) => { retry = r; },
    iniciar: async (capturada: OperacaoDownload) => {
      ordem.push("ipc"); assert.deepEqual(capturada, operacao);
      if (falha) throw Error("falha técnica IPC");
      return { ok: true, caminho: "Downloads/trecho.mp4" };
    },
  };
  await assert.rejects(executarTentativaDownload(operacao, false, retry, portas));
  assert.deepEqual(ordem, ["anuncio", "fontes-download-consumiu", "ipc"]);
  assert.ok(retry);
  falha = false;
  await executarTentativaDownload(operacao, true, retry, portas);
  assert.equal(autorizacoes, 1);
  assert.equal(retry, null, "sucesso invalida retry");
  await executarTentativaDownload(operacao, false, retry, portas);
  assert.equal(autorizacoes, 2);
});
test("cancelamento, planos, Direct Link/authorize/fontes recusados não iniciam IPC", async () => {
  for (const tipo of ["cancelar", "planos", "direct-link", "fontes"]) {
    let iniciou = false;
    const portas = {
      autorizar: async () => { if (tipo === "cancelar" || tipo === "planos") return false; throw Error(tipo); },
      atual: () => operacao, guardarRetry: () => {},
      iniciar: async () => { iniciou = true; return { ok: true }; },
    };
    await executarTentativaDownload(operacao, false, null, portas).catch(() => {});
    assert.equal(iniciou, false);
  }
});
test("retry expirado cobra; edição ou desmontagem durante anúncio cancela IPC", async () => {
  let anuncios = 0, ipc = 0;
  const portas = {
    autorizar: async () => { anuncios++; return true; },
    atual: (): OperacaoDownload | null => operacao, guardarRetry: () => {},
    iniciar: async () => { ipc++; return { ok: false, error: "rede" }; }, agora: () => 500,
  };
  await executarTentativaDownload(operacao, true, { operacao, expiraEm: 499 }, portas);
  assert.equal(anuncios, 1); assert.equal(ipc, 1);
  for (const atual of [null, { ...operacao, fimSeg: 900 }]) {
    const r = await executarTentativaDownload(operacao, false, null, { ...portas, atual: () => atual });
    assert.equal(r.cancelado, true);
  }
  assert.equal(ipc, 1);
});
