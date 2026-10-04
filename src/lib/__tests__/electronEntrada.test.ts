import test from "node:test";
import assert from "node:assert/strict";
import { POST as authorize } from "@/app/api/playback/authorize/route";
import { POST as complete } from "@/app/api/ads/complete/route";
import { PLANO_GRATUITO, PLANO_PREMIUM } from "../planos";
import { emitirRecuperacaoElectron, validarRecuperacaoElectron, consumirConcessao, marcarPago, estaPago } from "../ads/concessoes";
import { getRedis } from "../redis";
import type { Entitlements } from "../entitlements";

const alvo = { tipo: "serie" as const, conteudoId: "serie", temporada: 1, episodio: 1 };
const instancia = "instancia-playback-0001";
const pedido = { conteudoTipo: "serie", conteudoId: "serie", temporada: 1, numeroEp: 1,
  plataforma: "electron", finalidade: "reproducao", instancia };
function req(corpo: unknown) {
  return new Request("https://obaflix.test/api/x", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(corpo) }) as Parameters<typeof authorize>[0];
}
function portas(userId: string, pago = false) {
  const plano = pago ? PLANO_PREMIUM : PLANO_GRATUITO;
  const { id, nome, descricao, ordem, ativo, ehPadrao, ...direitos } = plano;
  void [nome, descricao, ordem, ativo, ehPadrao];
  return {
    getUserFromRequest: async () => ({ userId, role: "user", origem: "cookie" as const, deviceId: null }),
    monetizacaoAtiva: () => false, promocaoTvAtiva: () => false,
    anuncioAndroidAtivo: () => false, anuncioElectronAtivo: () => true,
    entitlementsDoUsuario: async (): Promise<Entitlements> => ({ assinatura: { ativa: pago, planoId: id, expiraEm: null }, direitos }),
    isIpBlocked: async () => false, recordAbuseAttempt: async () => {},
  };
}
const uid = () => `entrada-${crypto.randomUUID()}`;

test("EP1, EP2, EP3, reentrada e continuar assistindo cobram sem contar episódios", async () => {
  const userId = uid();
  const handler = authorize.createForTest({ ...portas(userId),
    estaPago: async () => { throw Error("não pode ler ads:pago"); },
    registrarEpisodioDistinto: async () => { throw Error("não pode contar episódios"); } });
  for (const numeroEp of [1, 2, 3, 1, 1]) {
    const resposta = await (await handler(req({ ...pedido, numeroEp }))).json();
    assert.equal(resposta.decisao, "ANUNCIO_NECESSARIO");
    assert.ok(resposta.desafioId && resposta.directLink);
  }
});
test("marca legada persistente não dispensa novo anúncio Electron", async () => {
  const userId = uid();
  await marcarPago({ userId, finalidade: "reproducao", alvo });
  const h = authorize.createForTest(portas(userId));
  assert.equal((await (await h(req(pedido))).json()).decisao, "ANUNCIO_NECESSARIO");
});
test("filme novo e retomado exigem anúncio; pago não recebe desafio/directLink", async () => {
  for (const pago of [false, true]) {
    const h = authorize.createForTest(portas(uid(), pago));
    for (let i = 0; i < 2; i++) {
      const r = await (await h(req({ ...pedido, conteudoTipo: "filme" }))).json();
      assert.equal(r.decisao, pago ? "PERMITIDO" : "ANUNCIO_NECESSARIO");
      if (pago) { assert.equal(r.desafioId, undefined); assert.equal(r.directLink, undefined); }
    }
  }
});
test("complete Electron emite concessão pontual e não marca o alvo pago", async () => {
  const userId = uid();
  const auth = await (await authorize.createForTest(portas(userId))(req(pedido))).json();
  const h = complete.createForTest({ ...portas(userId), agora: () => Date.now() + 10_000,
    checkRateLimit: async () => ({ allowed: true, remaining: 19 }),
    marcarPago: async () => { throw Error("não deve marcar"); } });
  const resultado = await (await h(req({ desafioId: auth.desafioId, concluido: true }))).json();
  assert.ok(resultado.concessao);
  assert.equal(await estaPago({ userId, finalidade: "reproducao", alvo }), false);
  assert.equal(await consumirConcessao(resultado.concessao, userId, "download", alvo), false);
  assert.equal(await consumirConcessao(resultado.concessao, userId, "reproducao", { ...alvo, episodio: 2 }), false);
  assert.equal(await consumirConcessao(resultado.concessao, userId, "reproducao", alvo), true);
  assert.equal(await consumirConcessao(resultado.concessao, userId, "reproducao", alvo), false);
});
test("recuperação valida conta, instância, finalidade, conteúdo e TTL; passe também prende instância", async () => {
  const userId = uid();
  const escopo = { userId, instancia, alvo, finalidade: "reproducao" as const };
  const recuperacao = await emitirRecuperacaoElectron(escopo);
  assert.equal(await validarRecuperacaoElectron(recuperacao, escopo), true);
  for (const errado of [{ ...escopo, userId: uid() }, { ...escopo, instancia: "nova-instancia-0001" },
    { ...escopo, alvo: { ...alvo, episodio: 2 } }]) {
    assert.equal(await validarRecuperacaoElectron(recuperacao, errado), false);
  }
  const h = authorize.createForTest(portas(userId));
  const r = await (await h(req({ ...pedido, recuperacao }))).json();
  assert.equal(r.decisao, "PERMITIDO");
  assert.ok(r.passe);
  assert.equal(await consumirConcessao(r.passe, userId, "reproducao", alvo, "outra-instancia-0001"), false);
  assert.equal(await consumirConcessao(r.passe, userId, "download", alvo, instancia), false);
  assert.equal(await consumirConcessao(r.passe, userId, "reproducao", alvo, instancia), true);
  const nova = await (await h(req({ ...pedido, recuperacao, instancia: "nova-instancia-0001" }))).json();
  assert.equal(nova.decisao, "ANUNCIO_NECESSARIO");
  const renovar = await (await h(req({ ...pedido, recuperacao, renovar: true }))).json();
  assert.deepEqual(renovar, { decisao: "PERMITIDO" });
  await getRedis().del(`ads:playback:${recuperacao}`);
  assert.equal(await validarRecuperacaoElectron(recuperacao, escopo), false);
  assert.equal((await h(req({ ...pedido, recuperacao, renovar: true }))).status, 403);
});
test("download sempre é nova ação de uso único, inclusive mesmo trecho", async () => {
  const userId = uid();
  const h = authorize.createForTest(portas(userId));
  const desafios = new Set<string>();
  for (let i = 0; i < 3; i++) {
    const r = await (await h(req({ ...pedido, finalidade: "download" }))).json();
    assert.equal(r.decisao, "ANUNCIO_NECESSARIO");
    desafios.add(r.desafioId);
  }
  assert.equal(desafios.size, 3);
});
