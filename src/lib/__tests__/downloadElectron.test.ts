import test from "node:test";
import assert from "node:assert/strict";
import { executarTentativaDownload, executarLoteDownload, podeRepetirDownload, JANELA_RETRY_DOWNLOAD_MS, type OperacaoDownload, type RetryDownload } from "../downloadElectron";

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

const cenas = (n: number): OperacaoDownload[] =>
  Array.from({ length: n }, (_, i) => ({ ...operacao, titulo: `0${i + 1}`, inicioSeg: i * 60, fimSeg: i * 60 + 30 }));

test("lote autorizado: UMA autorização cobre todas as cenas, baixadas em sequência", async () => {
  const ops = cenas(3);
  let autorizacoes = 0;
  const ordem: string[] = [];
  const resumo = await executarLoteDownload(ops, {
    autorizar: async () => { autorizacoes++; ordem.push("auth"); return true; },
    contextoValido: () => true,
    iniciar: async (op, i) => { ordem.push(`ipc${i}`); assert.equal(op, ops[i]); return { ok: true }; },
  });
  assert.deepEqual(resumo, { concluidas: 3, falhas: 0, total: 3, cancelado: false });
  assert.equal(autorizacoes, 1, "uma única autorização para o lote inteiro");
  assert.deepEqual(ordem, ["auth", "ipc0", "ipc1", "ipc2"], "autoriza antes do primeiro arquivo");
});
test("lote recusado/interrompido: não autoriza-e-baixa; recusa e throw não iniciam IPC", async () => {
  const ops = cenas(2);
  let iniciou = 0;
  const recusado = await executarLoteDownload(ops, {
    autorizar: async () => false, contextoValido: () => true,
    iniciar: async () => { iniciou++; return { ok: true }; },
  });
  assert.deepEqual(recusado, { concluidas: 0, falhas: 0, total: 2, cancelado: true });

  const interrompido = await executarLoteDownload(ops, {
    autorizar: async () => { throw new Error("anuncio interrompido"); },
    contextoValido: () => true, iniciar: async () => { iniciou++; return { ok: true }; },
  });
  assert.deepEqual(interrompido, { concluidas: 0, falhas: 0, total: 2, cancelado: true });
  assert.equal(iniciou, 0, "sem autorização nenhuma cena baixa");
});
test("lote cancelado: flag inicial e cancelamento de cena encerram sem baixar o resto", async () => {
  const ops = cenas(3);
  let autorizou = 0, iniciou = 0;
  const flagAntes = await executarLoteDownload(ops, {
    autorizar: async () => { autorizou++; return true; }, contextoValido: () => true,
    iniciar: async () => { iniciou++; return { ok: true }; },
    cancelado: () => true,
  });
  assert.deepEqual(flagAntes, { concluidas: 0, falhas: 0, total: 3, cancelado: true });
  assert.equal(autorizou, 0, "cancelado antes nem autoriza");
  assert.equal(iniciou, 0);

  const cancelaCena = await executarLoteDownload(ops, {
    autorizar: async () => true, contextoValido: () => true,
    iniciar: async (_op, i) => { iniciou++; return i === 1 ? { cancelado: true } : { ok: true }; },
  });
  assert.deepEqual(cancelaCena, { concluidas: 1, falhas: 0, total: 3, cancelado: true });
  assert.equal(iniciou, 2, "para na cena cancelada; não baixa a terceira");
});
test("lote: falha técnica de uma cena não encerra; contexto que muda interrompe", async () => {
  const ops = cenas(3);
  const comFalha = await executarLoteDownload(ops, {
    autorizar: async () => true, contextoValido: () => true,
    iniciar: async (_op, i) => (i === 1 ? { error: "rede" } : { ok: true }),
  });
  assert.deepEqual(comFalha, { concluidas: 2, falhas: 1, total: 3, cancelado: false });

  let iniciou = 0;
  const trocaFonte = await executarLoteDownload(ops, {
    autorizar: async () => true,
    contextoValido: () => iniciou < 2, // fonte/sessão muda depois da 2ª cena
    iniciar: async () => { iniciou++; return { ok: true }; },
  });
  assert.deepEqual(trocaFonte, { concluidas: 2, falhas: 0, total: 3, cancelado: true });

  // contexto já inválido logo após autorizar não baixa nada.
  let baixou = 0;
  const invalidoCedo = await executarLoteDownload(ops, {
    autorizar: async () => true, contextoValido: () => false,
    iniciar: async () => { baixou++; return { ok: true }; },
  });
  assert.equal(invalidoCedo.cancelado, true);
  assert.equal(baixou, 0);
});
