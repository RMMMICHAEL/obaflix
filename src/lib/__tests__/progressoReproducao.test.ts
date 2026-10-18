// Contrato do envio de /api/progress no CustomPlayer.
//
// O componente é React e vive com <video>/JW real, sem jsdom na suíte; então,
// como accountDeletion/releaseHardening, estes testes travam o comportamento
// pela fonte: as regras que economizam Redis/Supabase não podem regredir num
// refactor acidental. Nada aqui executa o player — só verifica as garantias.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const fonte = readFileSync(
  join(process.cwd(), "src/components/player/CustomPlayer.tsx"),
  "utf8",
);

const idx = (s: string) => fonte.indexOf(s);

describe("CustomPlayer · envio de progresso sem redundância", () => {
  test("deduplica por posição: não reenvia a mesma posição", () => {
    // Guard explícito antes do fetch.
    assert.ok(
      idx("if (pos === ultimaPosEnviadaRef.current) return;") !== -1,
      "faltou o guard de posição inalterada",
    );
    // O guard vem antes da chamada de rede.
    assert.ok(
      idx("if (pos === ultimaPosEnviadaRef.current) return;") <
        idx('await fetch("/api/progress"'),
      "o guard precisa barrar o envio antes do fetch",
    );
  });

  test("só marca enviado após a escrita bem-sucedida (preserva Continuar Assistindo)", () => {
    // A atribuição de ultimaPosEnviadaRef acontece depois do await fetch, dentro
    // do try: uma falha de rede não marca como enviado e o próximo gatilho reenvia.
    assert.ok(
      idx('await fetch("/api/progress"') < idx("ultimaPosEnviadaRef.current = pos;"),
      "ultimaPosEnviadaRef deve ser setado só após o fetch",
    );
    assert.ok(idx("} catch { /* mantém ultimaPosEnviadaRef") !== -1,
      "a falha de envio não pode marcar como enviado");
    // Uma única atribuição de 'enviado' no arquivo.
    assert.equal(fonte.split("ultimaPosEnviadaRef.current = pos;").length - 1, 1);
  });

  test("timer periódico: 30s e só durante reprodução ativa", () => {
    assert.ok(idx("}, 30000);") !== -1, "intervalo precisa ser 30s");
    assert.ok(
      idx("if (playingRef.current) saveProgress();") !== -1,
      "o timer não pode enviar com o vídeo pausado",
    );
    // O intervalo antigo de 15s não pode sobrar.
    assert.equal(idx("setInterval(saveProgress, 15000)"), -1);
  });

  test("salva ao sair/ocultar (sem duplicar: passa pela mesma dedup)", () => {
    assert.ok(idx('document.visibilitychange') !== -1 || idx('"visibilitychange"') !== -1);
    assert.ok(idx('"pagehide"') !== -1, "salvar ao sair da página");
  });

  test("salva ao pausar e ao buscar outra posição — nas duas engines", () => {
    // JW: pause já salvava; seek passa a salvar o destino.
    assert.ok(idx('player.on("seek"') !== -1, "JW precisa salvar no seek");
    assert.ok(idx("progressoRef.current = Math.floor(offset)") !== -1,
      "JW seek deve registrar o destino antes de salvar");
    // <video> nativo: pause já salvava; seeked passa a salvar.
    assert.ok(idx('video.addEventListener("seeked", onSeeked)') !== -1,
      "vídeo nativo precisa salvar no seeked");
    assert.ok(idx("const onSeeked = () => {") !== -1);
  });

  test("playingRef espelha play/pause nas duas engines", () => {
    // Pelo menos um true (play) e os falses de pause/complete.
    assert.ok(fonte.split("playingRef.current = true;").length - 1 >= 2,
      "play deve marcar playingRef nas duas engines");
    assert.ok(fonte.split("playingRef.current = false;").length - 1 >= 2,
      "pause deve limpar playingRef nas duas engines");
  });
});
