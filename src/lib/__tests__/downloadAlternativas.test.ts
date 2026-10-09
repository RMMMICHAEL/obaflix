import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  procurarFonteDeDownload,
  resolverCandidataExpandindo,
  type SessaoExpansivel,
  type EventoDeProcura,
} from "../androidMedia";

/**
 * A causa raiz do download que termina em `fim`: a procura fora do player só
 * via a lista base e nunca a fase `alternativas: true` que o player roda. Com a
 * base toda HLS (pulada) ou falhando, o MP4 baixável — que aparece só na lista
 * expandida — nunca era alcançado.
 *
 * Estes testes exercitam a procura real (`procurarFonteDeDownload`) ligada ao
 * novo `resolverCandidataExpandindo`, reproduzindo o cenário do runtime.
 */

type Cand = { id: string; tipoResolvido: "mp4" | "hls" | "falha" };
type Resolvida = { stream?: string; tipo?: string | null; servidor?: string; via?: string };

const hls = (id: string): Cand => ({ id, tipoResolvido: "hls" });
const falha = (id: string): Cand => ({ id, tipoResolvido: "falha" });
const mp4 = (id: string): Cand => ({ id, tipoResolvido: "mp4" });

function resolveCand(alvo: Cand): Resolvida {
  if (alvo.tipoResolvido === "mp4") return { stream: `https://cdn/${alvo.id}.mp4`, tipo: "mp4", servidor: alvo.id, via: "aparelho" };
  if (alvo.tipoResolvido === "hls") return { stream: `https://cdn/${alvo.id}.m3u8`, tipo: "hls", servidor: alvo.id, via: "aparelho" };
  throw new Error("fonte_falhou");
}

/**
 * Roda a procura exatamente como o cliente real: `resolverFonte` delega ao
 * `resolverCandidataExpandindo` sobre uma sessão que pode crescer uma vez.
 */
async function procurar(base: Cand[], expandirPara: Cand[] | null) {
  const sessao: SessaoExpansivel<Cand> = { candidatas: base, expandida: false };
  const sondadas: string[] = [];
  const eventos: EventoDeProcura[] = [];
  let expansoes = 0;

  const resultado = await procurarFonteDeDownload<Resolvida, { ok: boolean; tentarOutraFonte?: boolean }>({
    resolverFonte: (tentativa) =>
      resolverCandidataExpandindo<Cand, Resolvida>({
        tentativa,
        sessao,
        // A fase 2 nunca lança e nunca encolhe: devolve a lista crescida ou a base.
        expandir: async () => {
          expansoes++;
          return expandirPara ?? sessao.candidatas;
        },
        resolver: async (alvo) => resolveCand(alvo),
      }),
    sondar: async (fonte) => {
      sondadas.push(String(fonte.stream));
      return { ok: true };
    },
    registrar: (e) => eventos.push(e),
  });

  return { resultado, sondadas, eventos, expansoes, sessao };
}

describe("expansão da sessão de download (fase alternativas)", () => {
  test("1. base só HLS + alternativa MP4 → encontra o MP4 e sonda", async () => {
    const base = [hls("h1"), hls("h2"), hls("h3"), falha("f1")];
    const { resultado, sondadas, eventos, expansoes } = await procurar(base, [...base, mp4("m1")]);

    assert.equal(resultado.ok, true);
    // Só o MP4 chega à sondagem; nenhum HLS é sondado.
    assert.deepEqual(sondadas, ["https://cdn/m1.mp4"]);
    // HLS continua pulado, o servidor que falha é "falhou", e o MP4 é aceito.
    assert.deepEqual(eventos.map((e) => e.resultado), ["pulada_hls", "pulada_hls", "pulada_hls", "falhou", "aceita"]);
    assert.equal(eventos.filter((e) => e.resultado === "pulada_hls").length, 3);
    assert.equal(expansoes, 1);
  });

  test("2. fase alternativas falha → cai de volta na base, sem crash", async () => {
    const base = [hls("h1"), hls("h2")];
    // expandir devolvendo a própria base simula !ok/timeout/lista vazia.
    const { resultado, sondadas, expansoes, eventos } = await procurar(base, null);

    assert.equal(resultado.ok, false);
    assert.equal(resultado.ok === false && resultado.motivo, "download_indisponivel"); // viu HLS
    assert.deepEqual(sondadas, []);
    assert.equal(expansoes, 1); // tentou expandir uma vez
    assert.equal(eventos.at(-1)?.resultado, "fim");
  });

  test("3+4. uma única sessão e uma única expansão em toda a procura", async () => {
    const base = [hls("h1"), falha("f1")];
    const { expansoes, resultado } = await procurar(base, [...base]); // expande mas não cresce
    // Mesmo percorrendo várias tentativas vazias, expande no máximo uma vez.
    assert.equal(expansoes, 1);
    assert.equal(resultado.ok, false);
  });

  test("5. base já com MP4 não expande (nenhuma ação/!custo extra)", async () => {
    const base = [mp4("m0")];
    const { resultado, sondadas, expansoes } = await procurar(base, [...base, mp4("m1")]);
    assert.equal(resultado.ok, true);
    assert.deepEqual(sondadas, ["https://cdn/m0.mp4"]);
    assert.equal(expansoes, 0); // base bastou: nenhuma fase 2
  });

  test("6+7. MP4 da lista expandida é o único que chega à sondagem", async () => {
    const base = [hls("h1")];
    const { sondadas } = await procurar(base, [hls("h1"), hls("h2"), mp4("m1")]);
    assert.deepEqual(sondadas, ["https://cdn/m1.mp4"]);
  });

  test("resolverCandidataExpandindo não expande quando a candidata existe", async () => {
    const sessao: SessaoExpansivel<Cand> = { candidatas: [mp4("m0")], expandida: false };
    let expandiu = false;
    const r = await resolverCandidataExpandindo<Cand, Resolvida>({
      tentativa: 0,
      sessao,
      expandir: async () => { expandiu = true; return sessao.candidatas; },
      resolver: async (alvo) => resolveCand(alvo),
    });
    assert.equal(expandiu, false);
    assert.equal(r?.tipo, "mp4");
    assert.equal(sessao.expandida, false);
  });
});

describe("a expansão reusa a sessão, sem anúncio nem concessão", () => {
  const raiz = process.cwd();
  const hook = readFileSync(join(raiz, "src/components/android/useFonteParaMidia.ts"), "utf8");
  const rota = readFileSync(join(raiz, "src/app/api/player/fontes/route.ts"), "utf8");

  test("8+9. expandirFontes chama /fontes com alternativas na MESMA sessão", () => {
    const ini = hook.indexOf("const expandirFontes");
    const fim = hook.indexOf("return useCallback", ini); // callback de resolução vem depois
    const trecho = hook.slice(ini, fim);
    assert.ok(ini > -1 && fim > ini, "expandirFontes precisa existir antes do resolvedor");
    assert.ok(trecho.includes('"/api/player/fontes"'));
    assert.ok(trecho.includes("alternativas: true"));
    assert.ok(trecho.includes("sessao: atual.sessao"), "usa a sessão existente");
    assert.ok(trecho.includes('ambiente: "android"'));
    // Sem segunda liberação: nada de anúncio, concessão ou finalidade nesta fase.
    assert.ok(!/liberar|concessao|finalidade/.test(trecho), "fase 2 não pede anúncio/concessão");
    // Não abre sessão nova.
    assert.ok(!trecho.includes("abrirSessao"));
  });

  test("10. o ramo alternativas do servidor não consome concessão nem mostra anúncio", () => {
    const ini = rota.indexOf("corpo.alternativas === true");
    assert.ok(ini > -1);
    // Até o fim do handler (primeira fase começa logo depois deste ramo).
    const fim = rota.indexOf("// ── Primeira fase", ini);
    const trecho = rota.slice(ini, fim > ini ? fim : undefined);
    assert.ok(trecho.includes("diagnosticarSessao(sessao, userId)"), "confere o dono da sessão");
    assert.ok(trecho.includes("acrescentarFontes"), "é aditiva");
    assert.ok(!trecho.includes("autorizarPorAnuncio"), "sem anúncio/concessão na fase 2");
  });
});
