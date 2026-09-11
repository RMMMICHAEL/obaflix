/**
 * Testes de segurança dos canais ao vivo.
 *
 * O que se prova aqui não é que o vídeo toca — é que ele **não** toca para quem
 * não devia, e que o upstream não sai por nenhuma das saídas.
 *
 * A divisão segue as camadas:
 *
 *   1. acesso      — a escala ordenada, e os dois domínios que não são o mesmo
 *   2. autorização — a rota de concessão, por injeção de dependência
 *   3. catálogo    — o que sai e o que não sai na listagem
 *   4. resolver    — SSRF, allowlist, protocolo
 *   5. assinatura  — expiração, adulteração, escopo, nonce, segredo próprio
 *   6. sessão      — renovação, dono, canal, teto absoluto
 *   7. HLS         — nenhuma URL de upstream sobrevive à reescrita
 */

// O segredo de assinatura é próprio, e não o NEXTAUTH_SECRET. Precisa existir
// antes do import de `sessao.ts`, que o lê na derivação da chave.
process.env.CANAIS_MEDIA_SIGNING_SECRET ||= "segredo-de-canais-para-teste";

import assert from "node:assert/strict";
import test from "node:test";
import { NextRequest } from "next/server";

import {
  autorizarCanal,
  ehNivelMinimoDeCanal,
  nivelAlcanca,
  niveisAlcancadosPor,
  NIVEIS_MINIMOS_DE_CANAL,
} from "../canais/acesso";
import { extrairCandidatosDeMidia } from "../canais/resolver";
import { hostDeMidiaPermitido, ehIdDeProviderValido, montarUrlDoPlayer } from "../canais/providers";
import {
  desempacotarRecurso,
  empacotarRecurso,
  materialAssinado,
  mesmaOrigem,
} from "../canais/assinatura";
import { reescreverManifesto, vazaUpstream } from "../canais/hls";
import {
  assinar,
  assinaturaConfere,
  criarSessaoDeCanal,
  derivarSub,
  lerSessao,
  renovarSessaoDeCanal,
  chaveDoLockDeRenovacao,
  TTL_LOCK_DE_RENOVACAO_S,
  TTL_GRANT_S,
} from "../canais/sessao";
import { getRedis } from "../redis";
import { createPlayCanalHandler, type CanalDoBanco } from "../../app/api/canais/[id]/play/route";
import { createCanaisCatalogoHandler } from "../../app/api/canais/route";

// ── 1. Acesso: a escala, e os dois domínios ──────────────────────────────────

test("nivelAlcanca respeita a ordem nenhum < gratuito < plus < premium", () => {
  assert.equal(nivelAlcanca("premium", "plus"), true);
  assert.equal(nivelAlcanca("premium", "premium"), true);
  assert.equal(nivelAlcanca("plus", "premium"), false);
  assert.equal(nivelAlcanca("gratuito", "plus"), false);
  assert.equal(nivelAlcanca("gratuito", "gratuito"), true);
});

test('"nenhum" na conta nunca alcança canal algum — nem um marcado "nenhum"', () => {
  // O bug que isto tranca: a comparação por índice fazia 0 >= 0 e uma conta sem
  // direito a canal algum recebia autorização para um canal marcado "nenhum".
  assert.equal(nivelAlcanca("nenhum", "nenhum"), false);
  assert.equal(nivelAlcanca("nenhum", "gratuito"), false);
  assert.equal(nivelAlcanca("nenhum", "plus"), false);
  assert.equal(nivelAlcanca("nenhum", "premium"), false);
  assert.deepEqual(niveisAlcancadosPor("nenhum"), []);
});

test('"nenhum" não é nível mínimo válido de canal', () => {
  assert.deepEqual([...NIVEIS_MINIMOS_DE_CANAL], ["gratuito", "plus", "premium"]);
  assert.equal(ehNivelMinimoDeCanal("nenhum"), false);
  assert.equal(ehNivelMinimoDeCanal("gratuito"), true);
  // Nenhuma conta, nem a premium, alcança um canal com nível fora do domínio.
  assert.equal(nivelAlcanca("premium", "nenhum"), false);
  assert.equal(nivelAlcanca("premium", "vip"), false);
  assert.equal(nivelAlcanca("premium", ""), false);
});

test("niveisAlcancadosPor devolve exatamente o que a conta abre", () => {
  assert.deepEqual(niveisAlcancadosPor("premium"), ["gratuito", "plus", "premium"]);
  assert.deepEqual(niveisAlcancadosPor("plus"), ["gratuito", "plus"]);
  assert.deepEqual(niveisAlcancadosPor("gratuito"), ["gratuito"]);
  // Fora do domínio é lista vazia, que quer dizer catálogo vazio — nunca
  // catálogo inteiro.
  assert.deepEqual(niveisAlcancadosPor("vip"), []);
  assert.deepEqual(niveisAlcancadosPor(""), []);
});

test("autorizarCanal nega plano insuficiente, canal inativo e canal adulto", () => {
  const base = { nivelMinimo: "plus", ativo: true, adulto: false };

  assert.equal(autorizarCanal(base, "premium").situacao, "permitido");
  assert.equal(autorizarCanal(base, "plus").situacao, "permitido");
  assert.equal(autorizarCanal(base, "gratuito").situacao, "negado");
  assert.equal(autorizarCanal(base, "nenhum").situacao, "negado");

  assert.equal(autorizarCanal({ ...base, ativo: false }, "premium").situacao, "negado");
  assert.equal(autorizarCanal({ ...base, adulto: true }, "premium").situacao, "negado");

  // Nível de canal fora do domínio estreito é inconsistência de dado, não
  // resposta sobre a conta — e "nenhum" entra nesse caso.
  assert.equal(autorizarCanal({ ...base, nivelMinimo: "nenhum" }, "premium").situacao, "indeterminado");
  assert.equal(autorizarCanal({ ...base, nivelMinimo: "vip" }, "premium").situacao, "indeterminado");
  assert.equal(autorizarCanal(base, "vip").situacao, "indeterminado");
});

// ── 2. Autorização: a rota de concessão ──────────────────────────────────────

const FONTE = {
  streamUrl: "https://cdn.example.test/live/master.m3u8",
  paginaDoPlayer: "https://player.example.test/c.php?id=x",
  referer: null,
  userAgent: null,
  expiresAt: null,
};

const CANAL_PLUS: CanalDoBanco = {
  id: "canal-plus",
  slug: "plus",
  nome: "Canal Plus",
  nivelMinimo: "plus",
  ativo: true,
  adulto: false,
  fonte: { provider: "megafrix", providerChannelId: "abc" },
};

function play(over: Partial<Parameters<typeof createPlayCanalHandler>[0]> = {}, canal = CANAL_PLUS) {
  const chamadas = { resolveu: 0, sessoes: 0, renovacoes: 0 };
  const handler = createPlayCanalHandler({
    env: { CANAIS_MEDIA_BASE: "https://media.example.test" },
    clientIp: () => "1.2.3.4",
    isIpBlocked: async () => false,
    recordAbuseAttempt: async () => {},
    getUserFromRequest: async () => ({ userId: "u1" }),
    checkRateLimit: async () => ({ allowed: true }),
    lerCorpo: async () => ({}),
    buscarCanal: async (id) => (id === canal.id || id === canal.slug ? canal : null),
    nivelDaConta: async () => "premium",
    resolver: async () => {
      chamadas.resolveu++;
      return FONTE;
    },
    criarSessao: async () => {
      chamadas.sessoes++;
      return {
        sessionId: "s".repeat(32),
        geracao: 0,
        exp: 2_000_000_000,
        sig: "a".repeat(22),
        validoPorSegundos: TTL_GRANT_S,
      };
    },
    renovarSessao: async () => {
      chamadas.renovacoes++;
      return null;
    },
    audit: () => {},
    ...over,
  });
  const req = new NextRequest("http://local/api/canais/canal-plus/play", { method: "POST" });
  return {
    chamadas,
    run: (id = canal.id) => handler(req, { params: { id } }),
  };
}

test("sem sessão: playback negado, e nada é resolvido", async () => {
  const { run, chamadas } = play({ getUserFromRequest: async () => null });
  const r = await run();
  assert.equal(r.status, 401);
  assert.equal((await r.json()).erro, "nao_autenticado");
  assert.equal(chamadas.resolveu, 0);
});

test("canaisNivel=nenhum e plano abaixo do canal: negado, sem resolver", async () => {
  for (const nivel of ["nenhum", "gratuito"]) {
    const { run, chamadas } = play({ nivelDaConta: async () => nivel });
    const r = await run();
    assert.equal(r.status, 403, `nivel ${nivel}`);
    assert.equal((await r.json()).erro, "upgrade_necessario");
    assert.equal(chamadas.resolveu, 0);
  }
});

test('conta "nenhum" é negada mesmo num canal com nivelMinimo "nenhum"', async () => {
  // O banco recusa criar essa linha (CHECK), mas se ela existir — migration
  // revertida, escrita fora da ferramenta — a rota ainda nega.
  const canalQuebrado = { ...CANAL_PLUS, nivelMinimo: "nenhum" };
  const { run, chamadas } = play({ nivelDaConta: async () => "nenhum" }, canalQuebrado);
  const r = await run();
  assert.equal(r.status, 503);
  assert.equal((await r.json()).erro, "indeterminado");
  assert.equal(chamadas.resolveu, 0);
  assert.equal(chamadas.sessoes, 0);
});

test("plus tentando premium é negado; premium no canal premium é permitido", async () => {
  const canalPremium = { ...CANAL_PLUS, nivelMinimo: "premium" };

  const negado = play({ nivelDaConta: async () => "plus" }, canalPremium);
  assert.equal((await negado.run()).status, 403);
  assert.equal(negado.chamadas.resolveu, 0);

  const permitido = play({ nivelDaConta: async () => "premium" }, canalPremium);
  const r = await permitido.run();
  assert.equal(r.status, 200);
  assert.equal(permitido.chamadas.sessoes, 1);
});

test("channelId inexistente e channelId adulterado não elevam acesso", async () => {
  const { run } = play();
  assert.equal((await run("nao-existe")).status, 404);
  assert.equal((await run("../../etc/passwd")).status, 404);
  assert.equal((await run("x".repeat(200))).status, 404);

  const premium = { ...CANAL_PLUS, id: "canal-premium", slug: "premium", nivelMinimo: "premium" };
  const tentativa = play({ nivelDaConta: async () => "plus" }, premium);
  assert.equal((await tentativa.run("canal-premium")).status, 403);
});

test("canal inativo e canal adulto respondem 404, sem revelar qual dos dois", async () => {
  for (const canal of [
    { ...CANAL_PLUS, ativo: false },
    { ...CANAL_PLUS, adulto: true },
  ]) {
    const { run, chamadas } = play({ nivelDaConta: async () => "premium" }, canal);
    const r = await run();
    assert.equal(r.status, 404);
    assert.equal((await r.json()).erro, "canal_indisponivel");
    assert.equal(chamadas.resolveu, 0);
  }
});

test("IP bloqueado e rate limit negam antes de qualquer trabalho", async () => {
  const bloqueado = play({ isIpBlocked: async () => true });
  assert.equal((await bloqueado.run()).status, 429);
  assert.equal(bloqueado.chamadas.resolveu, 0);

  const limitado = play({ checkRateLimit: async () => ({ allowed: false }) });
  assert.equal((await limitado.run()).status, 429);
  assert.equal(limitado.chamadas.resolveu, 0);
});

test("a concessão devolve só URL do edge — nunca upstream, provider ou player", async () => {
  const { run } = play();
  const r = await run();
  const corpo = await r.json();
  const texto = JSON.stringify(corpo);

  assert.match(corpo.manifestUrl, /^https:\/\/media\.example\.test\/canal\/s+\/master\.m3u8\?e=\d+&k=/);
  for (const proibido of ["cdn.example.test", "player.example.test", "megafrix", "Referer", "cookie"]) {
    assert.equal(texto.includes(proibido), false, `vazou "${proibido}" na concessão`);
  }
  assert.equal(texto.includes("abc"), false, "vazou o providerChannelId");
  assert.equal(r.headers.get("Cache-Control")?.includes("no-store"), true);
});

test("renovação reautoriza e não volta ao provider", async () => {
  const { run, chamadas } = play({
    lerCorpo: async () => ({ sessionId: "S".repeat(32) }),
    renovarSessao: async () => {
      chamadas.renovacoes++;
      return {
        sessionId: "S".repeat(32),
        geracao: 1,
        exp: 2_000_000_000,
        sig: "b".repeat(22),
        validoPorSegundos: TTL_GRANT_S,
      };
    },
  });

  const r = await run();
  assert.equal(r.status, 200);
  assert.equal(chamadas.renovacoes, 1);
  // O ponto da renovação: entitlement foi reconferido, provider não foi tocado.
  assert.equal(chamadas.resolveu, 0);
  assert.equal(chamadas.sessoes, 0);
});

test("renovação recusada cai para o caminho completo, sem erro para o cliente", async () => {
  const { run, chamadas } = play({
    lerCorpo: async () => ({ sessionId: "S".repeat(32) }),
    // `null` é o que `renovarSessaoDeCanal` devolve para sessão de outra conta,
    // de outro canal, sumida ou passada do teto absoluto.
    renovarSessao: async () => null,
  });
  const r = await run();
  assert.equal(r.status, 200);
  assert.equal(chamadas.resolveu, 1);
  assert.equal(chamadas.sessoes, 1);
});

test("renovação não escapa da checagem de entitlement", async () => {
  let renovou = 0;
  const { run } = play({
    nivelDaConta: async () => "gratuito",
    lerCorpo: async () => ({ sessionId: "S".repeat(32) }),
    renovarSessao: async () => {
      renovou++;
      return { sessionId: "x", geracao: 1, exp: 1, sig: "y", validoPorSegundos: 1 };
    },
  });
  const r = await run();
  assert.equal(r.status, 403);
  // A renovação nem chega a ser tentada: o plano já não alcança o canal.
  assert.equal(renovou, 0);
});

test("sessionId malformado no corpo é ignorado, não confiado", async () => {
  for (const ruim of ["../outro", "a b", "x".repeat(200), "", 42, null, { a: 1 }]) {
    let renovou = 0;
    const { run } = play({
      lerCorpo: async () => ({ sessionId: ruim }),
      renovarSessao: async () => {
        renovou++;
        return null;
      },
    });
    const r = await run();
    assert.equal(r.status, 200);
    assert.equal(renovou, 0, `tentou renovar com sessionId ${JSON.stringify(ruim)}`);
  }
});

test("sem CANAIS_MEDIA_BASE a rota falha em vez de entregar o upstream", async () => {
  const { run } = play({ env: {} });
  const r = await run();
  assert.equal(r.status, 503);
  assert.equal((await r.json()).erro, "midia_indisponivel");
});

test("falha de resolução não conta ao cliente o que o provider respondeu", async () => {
  const { run } = play({
    resolver: async () => {
      throw new Error("midia_nao_encontrada no host cdn.example.test");
    },
  });
  const r = await run();
  assert.equal(r.status, 503);
  const texto = JSON.stringify(await r.json());
  assert.equal(texto.includes("cdn.example.test"), false);
  assert.equal(texto.includes("nao_encontrada"), false);
});

// ── 3. Catálogo ──────────────────────────────────────────────────────────────

function catalogo(over: Partial<Parameters<typeof createCanaisCatalogoHandler>[0]> = {}) {
  return createCanaisCatalogoHandler({
    clientIp: () => "1.2.3.4",
    isIpBlocked: async () => false,
    getUserFromRequest: async () => ({ userId: "u1" }),
    nivelDaConta: async () => "gratuito",
    // Espelha o que `listarCanais` faz de verdade: filtra por nível na consulta
    // e projeta só os campos públicos.
    listarCanais: async ({ nivelDaConta }) =>
      [
        { nivelMinimo: "gratuito", item: { id: "c1", slug: "aberto", nome: "Aberto", categoria: "abertos", logoUrl: null, aoVivo: true } },
        { nivelMinimo: "premium", item: { id: "c2", slug: "pago", nome: "Pago", categoria: "esportes", logoUrl: null, aoVivo: true } },
      ]
        .filter((l) => niveisAlcancadosPor(nivelDaConta).includes(l.nivelMinimo as never))
        .map((l) => l.item),
    categoriasComCanais: async (nivelDaConta) =>
      nivelDaConta === "premium" ? ["todos", "abertos", "esportes"] : ["todos", "abertos"],
    ...over,
  });
}

test("catálogo exige sessão", async () => {
  const h = catalogo({ getUserFromRequest: async () => null });
  const r = await h(new NextRequest("http://local/api/canais"));
  assert.equal(r.status, 401);
});

test("catálogo não devolve canal que a conta não pode abrir", async () => {
  const gratuita = catalogo();
  const corpoGratuito = await (await gratuita(new NextRequest("http://local/api/canais"))).json();

  assert.deepEqual(corpoGratuito.canais.map((c: { slug: string }) => c.slug), ["aberto"]);
  // Nem o nome, nem a existência do canal premium chegam à conta gratuita.
  assert.equal(JSON.stringify(corpoGratuito).includes("Pago"), false);
  // E a categoria só dele também não, senão a ausência contaria a mesma coisa.
  assert.equal(JSON.stringify(corpoGratuito).includes("esportes"), false);

  const premium = catalogo({ nivelDaConta: async () => "premium" });
  const corpoPremium = await (await premium(new NextRequest("http://local/api/canais"))).json();
  assert.deepEqual(corpoPremium.canais.map((c: { slug: string }) => c.slug), ["aberto", "pago"]);
});

test('conta "nenhum" recebe catálogo vazio, não catálogo inteiro', async () => {
  const h = catalogo({ nivelDaConta: async () => "nenhum" });
  const corpo = await (await h(new NextRequest("http://local/api/canais"))).json();
  assert.deepEqual(corpo.canais, []);
});

test("catálogo não expõe HLS, player URL, provider, nível nem cookie", async () => {
  const h = catalogo({ nivelDaConta: async () => "premium" });
  const r = await h(new NextRequest("http://local/api/canais"));
  const texto = JSON.stringify(await r.json());

  for (const proibido of [
    ".m3u8", "media_url", "player_url", "megafrix", "providerChannelId",
    "Cookie", "referer",
    // O nível saiu da projeção: com o filtro por entitlement, todo canal da
    // lista é abrível, e o campo não tem mais uso na interface.
    "nivelMinimo", "liberado",
  ]) {
    assert.equal(texto.toLowerCase().includes(proibido.toLowerCase()), false, `vazou "${proibido}"`);
  }
  assert.equal(r.headers.get("Cache-Control")?.includes("no-store"), true);
});

test("entitlements indefinidos devolvem 503, nunca catálogo aberto", async () => {
  const h = catalogo({
    nivelDaConta: async () => {
      throw new Error("banco fora");
    },
  });
  const r = await h(new NextRequest("http://local/api/canais"));
  assert.equal(r.status, 503);
  assert.equal(Object.hasOwn(await r.json(), "canais"), false);
});

// ── 4. Resolver: SSRF, allowlist, protocolo ──────────────────────────────────

test("allowlist de mídia: vazia nega tudo, e sufixo não casa prefixo", () => {
  assert.equal(hostDeMidiaPermitido("cdn.example.test", {}), false);
  assert.equal(hostDeMidiaPermitido("cdn.example.test", { CANAIS_CDN_ALLOWLIST: "" }), false);

  const env = { CANAIS_CDN_ALLOWLIST: "example.test, outro.test" };
  assert.equal(hostDeMidiaPermitido("example.test", env), true);
  assert.equal(hostDeMidiaPermitido("cdn.example.test", env), true);
  assert.equal(hostDeMidiaPermitido("CDN.EXAMPLE.TEST", env), true);
  assert.equal(hostDeMidiaPermitido("malexample.test", env), false);
  assert.equal(hostDeMidiaPermitido("example.test.mal.com", env), false);
});

test("candidatos de mídia: só https, e o resolver recusa interno e não-HTTPS", () => {
  const html = `
    <script>
      var a = "http://127.0.0.1/live.m3u8";
      var b = "https://localhost/live.m3u8";
      source: "https://cdn.example.test/live/master.m3u8",
      file: 'https://cdn.example.test/outro.mp4'
      var c = "ftp://cdn.example.test/x.m3u8";
    </script>`;
  const achados = extrairCandidatosDeMidia(html);

  assert.equal(achados.some((u) => u.startsWith("http://")), false);
  assert.equal(achados.some((u) => u.startsWith("ftp:")), false);
  assert.equal(achados.includes("https://localhost/live.m3u8"), true);
  assert.equal(hostDeMidiaPermitido("localhost", { CANAIS_CDN_ALLOWLIST: "example.test" }), false);
  assert.equal(achados.includes("https://cdn.example.test/live/master.m3u8"), true);
});

test("providerChannelId fora do formato não monta URL de player", () => {
  assert.equal(ehIdDeProviderValido("cnnbrasil"), true);
  assert.equal(ehIdDeProviderValido("24h_chaves"), true);
  for (const mau of ["../../etc", "a/b", "a?b=1", "a b", "a#b", "", "x".repeat(65), "http://x"]) {
    assert.equal(ehIdDeProviderValido(mau), false, `aceitou "${mau}"`);
    assert.throws(() => montarUrlDoPlayer("megafrix", mau));
  }
});

// ── 5. Assinatura ────────────────────────────────────────────────────────────

test("o material assinado separa escopo, sessão, nonce, recurso e expiração", () => {
  const p = { escopo: "s" as const, sessionId: "sid", nonce: "n1", recurso: "0/seg.ts", exp: 42 };
  assert.equal(materialAssinado(p), "s:sid:n1:0/seg.ts:42");

  // Trocar qualquer campo muda o material — inclusive o nonce, que é o que dá
  // à renovação o poder de derrubar URLs já emitidas.
  for (const dif of [
    { ...p, escopo: "m" as const },
    { ...p, sessionId: "sid2" },
    { ...p, nonce: "n2" },
    { ...p, recurso: "1/seg.ts" },
    { ...p, exp: 43 },
  ]) {
    assert.notEqual(materialAssinado(p), materialAssinado(dif));
  }
});

test("assinar e conferir: adulteração, expiração, escopo e nonce", async (t) => {
  const p = {
    escopo: "m" as const,
    sessionId: "sid-1",
    nonce: "nonce-1",
    recurso: "master",
    exp: 2_000_000_000,
  };
  const sig = assinar(p);

  await t.test("assinatura válida confere", () => {
    assert.equal(assinaturaConfere(p, sig), true);
  });

  await t.test("token alterado é recusado", () => {
    const adulterada = (sig[0] === "A" ? "B" : "A") + sig.slice(1);
    assert.equal(assinaturaConfere(p, adulterada), false);
    assert.equal(assinaturaConfere(p, sig.slice(1)), false);
    assert.equal(assinaturaConfere(p, ""), false);
  });

  await t.test("nonce diferente não confere — é o que a renovação derruba", () => {
    assert.equal(assinaturaConfere({ ...p, nonce: "nonce-2" }, sig), false);
  });

  await t.test("recurso, sessão, escopo ou exp diferentes não reaproveitam", () => {
    assert.equal(assinaturaConfere({ ...p, recurso: "0/outro.ts" }, sig), false);
    assert.equal(assinaturaConfere({ ...p, sessionId: "sid-2" }, sig), false);
    assert.equal(assinaturaConfere({ ...p, escopo: "s" }, sig), false);
    assert.equal(assinaturaConfere({ ...p, exp: p.exp + 3600 }, sig), false);
  });

  await t.test("a chave da semana anterior vale; a de duas semanas atrás não", () => {
    const UMA_SEMANA = 7 * 24 * 3600 * 1000;
    assert.equal(assinaturaConfere(p, sig, Date.now() + UMA_SEMANA), true);
    assert.equal(assinaturaConfere(p, sig, Date.now() + 3 * UMA_SEMANA), false);
  });

  await t.test("o sub é derivado, não o userId, e separa usuários", () => {
    const a = derivarSub("usuario-a");
    const b = derivarSub("usuario-b");
    assert.notEqual(a, b);
    assert.equal(a.includes("usuario-a"), false);
    assert.equal(derivarSub("usuario-a"), a, "derivação precisa ser estável");
  });
});

test("a chave de canais é própria, e não o NEXTAUTH_SECRET", () => {
  const original = process.env.CANAIS_MEDIA_SIGNING_SECRET;
  const p = { escopo: "m" as const, sessionId: "s", nonce: "n", recurso: "master", exp: 9 };
  const comSegredo = assinar(p);

  // Mexer no NEXTAUTH_SECRET não pode mudar nada aqui: são chaves separadas,
  // e é essa separação que impede um vazamento no Worker alcançar a
  // autenticação do produto.
  process.env.NEXTAUTH_SECRET = "outro-valor-qualquer";
  assert.equal(assinar(p), comSegredo);

  // Sem o segredo próprio, falha alto em vez de assinar com algo derivado.
  delete process.env.CANAIS_MEDIA_SIGNING_SECRET;
  assert.throws(() => assinar(p), /CANAIS_MEDIA_SIGNING_SECRET/);
  process.env.CANAIS_MEDIA_SIGNING_SECRET = original;
});

const ID_FALSO = "aBcDeFgH12345678";

test("recurso empacotado sobrevive a query string e recusa saída de diretório", () => {
  // O caso que quebrava: `?` colado no caminho misturaria a query do provider
  // com a nossa, e do outro lado o pathname não conteria o que foi assinado.
  const comQuery = empacotarRecurso(ID_FALSO, "seg.ts?token=abc&x=1");
  assert.equal(comQuery.includes("?"), false, "a query tem de sair encodada");
  assert.equal(comQuery.includes("&"), false);
  assert.deepEqual(desempacotarRecurso(comQuery), {
    idDaBase: ID_FALSO,
    caminhoComQuery: "seg.ts?token=abc&x=1",
  });

  assert.deepEqual(desempacotarRecurso(empacotarRecurso(ID_FALSO, "a.ts")), {
    idDaBase: ID_FALSO,
    caminhoComQuery: "a.ts",
  });

  // Entrada hostil: subir de diretório sairia da base e mudaria o alvo.
  assert.equal(desempacotarRecurso(empacotarRecurso(ID_FALSO, "../../etc/passwd")), null);
  assert.equal(desempacotarRecurso(empacotarRecurso(ID_FALSO, "/absoluto.ts")), null);
  for (const ruim of ["", "abc", "curto/x", "x/y", `${ID_FALSO}/`, `${ID_FALSO}/%ZZ`]) {
    assert.equal(desempacotarRecurso(ruim), null, `aceitou "${ruim}"`);
  }
});

test("a query do upstream é transporte, não sigilo — e isso está documentado", () => {
  // `encodeURIComponent` é reversível por qualquer um. O que se esconde é o
  // HOST, pelo id opaco da base; a query não é tratada como secreta neste
  // desenho, e um provider futuro que traga credencial nela precisa de
  // identificador opaco, como a base já tem.
  const recurso = empacotarRecurso(ID_FALSO, "seg.ts?token=SEGREDO");
  assert.equal(decodeURIComponent(recurso.split("/")[1]), "seg.ts?token=SEGREDO");
  // O host, esse sim, não sai: o id não contém nada do valor de origem.
  assert.equal(recurso.includes("example"), false);
});

test("mesmaOrigem não cai no truque do sufixo", () => {
  const base = "https://media.exemplo";
  assert.equal(mesmaOrigem("https://media.exemplo/canal/x", base), true);
  // O ataque que `startsWith` aceitava: o host hostil vem depois do prefixo.
  assert.equal(mesmaOrigem("https://media.exemplo.evil.example/x", base), false);
  assert.equal(mesmaOrigem("https://media.exemploevil.test/x", base), false);
  assert.equal(mesmaOrigem("http://media.exemplo/x", base), false, "esquema faz parte da origem");
  assert.equal(mesmaOrigem("https://media.exemplo:8443/x", base), false, "porta também");
  assert.equal(mesmaOrigem("não é url", base), false);
});

// ── 6. Sessão: renovação, dono, canal, teto ──────────────────────────────────

test("renovar rotaciona o nonce e invalida as URLs anteriores", async () => {
  const c1 = await criarSessaoDeCanal({ userId: "dono", canalId: "canal-1", fonte: FONTE });
  const sessao1 = await lerSessao(c1.sessionId);
  assert.ok(sessao1);

  const c2 = await renovarSessaoDeCanal({
    userId: "dono",
    canalId: "canal-1",
    sessionId: c1.sessionId,
  });
  assert.ok(c2, "a renovação legítima precisa funcionar");

  const sessao2 = await lerSessao(c1.sessionId);
  assert.ok(sessao2);
  assert.notEqual(sessao2.nonce, sessao1.nonce, "o nonce tem de girar");
  // A mesma sessão, e o mesmo upstream: renovar não volta ao provider.
  assert.equal(c2.sessionId, c1.sessionId);
  assert.equal(sessao2.upstream, sessao1.upstream);

  // A assinatura da concessão antiga para de conferir contra o nonce novo —
  // mesmo estando dentro do `exp`. É esta a mitigação de replay.
  const antiga = { escopo: "m" as const, sessionId: c1.sessionId, nonce: sessao2.nonce, recurso: "master", exp: c1.exp };
  assert.equal(assinaturaConfere(antiga, c1.sig), false);
  // E a nova confere.
  assert.equal(
    assinaturaConfere({ ...antiga, exp: c2.exp }, c2.sig),
    true,
  );
});

test("renovar recusa outra conta, outro canal e sessão inexistente", async () => {
  const c = await criarSessaoDeCanal({ userId: "dono", canalId: "canal-1", fonte: FONTE });

  assert.equal(
    await renovarSessaoDeCanal({ userId: "intruso", canalId: "canal-1", sessionId: c.sessionId }),
    null,
    "sessionId capturado não pode ser renovado por outra conta",
  );
  assert.equal(
    await renovarSessaoDeCanal({ userId: "dono", canalId: "outro-canal", sessionId: c.sessionId }),
    null,
    "a sessão é de um canal só",
  );
  assert.equal(
    await renovarSessaoDeCanal({ userId: "dono", canalId: "canal-1", sessionId: "nao-existe-aqui-1" }),
    null,
  );
});

test("o teto absoluto não se move com renovação", async () => {
  const c = await criarSessaoDeCanal({ userId: "dono", canalId: "canal-1", fonte: FONTE });
  const antes = (await lerSessao(c.sessionId))!.expiraDefinitivamenteEm;

  await renovarSessaoDeCanal({ userId: "dono", canalId: "canal-1", sessionId: c.sessionId });
  const depois = (await lerSessao(c.sessionId))!;

  assert.equal(depois.expiraDefinitivamenteEm, antes, "renovar não pode empurrar o teto");
  assert.ok(depois.expiraEm > Date.now(), "a janela deslizante, essa sim, anda");
  // O grant entregue ao cliente é curto — é o que força a volta ao backend.
  assert.equal(c.validoPorSegundos, TTL_GRANT_S);
  assert.ok(TTL_GRANT_S <= 10 * 60, "grant longo demais para ser reautorização");
});

test("lock expirado recupera o renew e unlock atrasado não apaga novo dono", async () => {
  const c = await criarSessaoDeCanal({ userId: "dono", canalId: "canal-lock", fonte: FONTE });
  const redis = getRedis();
  const lock = chaveDoLockDeRenovacao(c.sessionId);

  // Requisição A "morre" depois de adquirir: não há release, só o TTL.
  assert.equal(await redis.set(lock, "token-da-a", { nx: true, ex: 1 }), "OK");
  await new Promise((resolve) => setTimeout(resolve, 1_050));

  const recuperada = await renovarSessaoDeCanal({
    userId: "dono", canalId: "canal-lock", sessionId: c.sessionId,
  });
  assert.ok(recuperada, "depois do TTL uma nova requisição consegue renovar");
  assert.equal(recuperada.geracao, 1);

  // B já é dono de um lock novo. O unlock atrasado de A não pode apagá-lo.
  assert.equal(await redis.set(lock, "token-da-b", { nx: true, ex: TTL_LOCK_DE_RENOVACAO_S }), "OK");
  assert.equal(await redis.compareAndDelete(lock, "token-da-a"), 0);
  assert.equal(await redis.get(lock), "token-da-b");
  await redis.compareAndDelete(lock, "token-da-b");
});

test("write tardio de lock vencido não sobrescreve a rotação do novo dono", async () => {
  const c = await criarSessaoDeCanal({ userId: "dono", canalId: "canal-race", fonte: FONTE });
  const redis = getRedis();
  const lock = chaveDoLockDeRenovacao(c.sessionId);
  let liberarA!: () => void;
  let aAdquiriuLock!: () => void;
  const aPausada = new Promise<void>((resolve) => { liberarA = resolve; });
  const aAdquiriu = new Promise<void>((resolve) => { aAdquiriuLock = resolve; });

  // A adquire o lock e para imediatamente antes do commit atômico.
  const A = renovarSessaoDeCanal({
    userId: "dono", canalId: "canal-race", sessionId: c.sessionId,
    antesDePersistirParaTeste: async () => {
      aAdquiriuLock();
      await aPausada;
    },
  });
  await aAdquiriu;

  // Simula o Redis removendo a chave porque o TTL de A venceu. B adquire seu
  // próprio lock, escreve N+1/nonce-B e encerra normalmente.
  await redis.del(lock);
  const B = await renovarSessaoDeCanal({ userId: "dono", canalId: "canal-race", sessionId: c.sessionId });
  assert.ok(B);
  const depoisDeB = await lerSessao(c.sessionId);
  assert.ok(depoisDeB);

  // Quando A volta, o EVAL vê que token-A não é mais dono e recusa o SET.
  liberarA();
  const concessaoA = await A;
  assert.ok(concessaoA);
  const final = await lerSessao(c.sessionId);
  assert.ok(final);
  assert.equal(final.geracao, c.geracao + 1, "a geração final só sobe uma vez");
  assert.equal(final.nonce, depoisDeB.nonce, "o write tardio de A não troca o nonce de B");
  assert.equal(final.expiraDefinitivamenteEm, depoisDeB.expiraDefinitivamenteEm);

  for (const concessao of [B, concessaoA]) {
    assert.equal(concessao.geracao, final.geracao);
    assert.ok(assinaturaConfere({
      escopo: "m", sessionId: c.sessionId, nonce: final.nonce,
      recurso: "master", exp: concessao.exp,
    }, concessao.sig), "as concessões de A e B permanecem válidas");
  }
});

// ── 7. HLS: o upstream não sobrevive à reescrita ─────────────────────────────

const assinadorFalso = async (escopo: "m" | "s", recurso: string, exp: number) =>
  `sig-${escopo}-${recurso.length}-${exp}`;

/** Id determinístico e legível, para as asserções não dependerem do HMAC. */
const idFalsoDaBase = async (base: string) =>
  `b${[...base].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7).toString(36)}`.padEnd(8, "0");

async function reescrever(manifesto: string) {
  return reescreverManifesto({
    manifesto,
    urlDoManifesto: "https://cdn.example.test/live/master.m3u8",
    sessionId: "sid",
    baseDoEdge: "https://media.example.test",
    expSegmento: 1111,
    expManifesto: 2222,
    assinar: assinadorFalso,
    idDaBase: idFalsoDaBase,
  });
}

test("segmentos absolutos de outro host são reescritos e o CDN não sobrevive", async () => {
  const entrada = [
    "#EXTM3U",
    "#EXT-X-VERSION:3",
    "#EXT-X-MEDIA-SEQUENCE:1271",
    "#EXTINF:10.0,",
    "https://segmentos.example.test/assets/abc123.css",
    "#EXTINF:10.0,",
    "https://segmentos.example.test/assets/def456.css",
  ].join("\n");

  const { manifesto, basesUsadas } = await reescrever(entrada);

  assert.equal(vazaUpstream(manifesto, "https://media.example.test"), false);
  assert.equal(manifesto.includes("segmentos.example.test"), false);
  // A base sai listada para quem chama persistir ANTES de servir.
  assert.deepEqual(
    basesUsadas.map((b) => b.base),
    ["https://segmentos.example.test/assets/"],
  );
  const id = await idFalsoDaBase("https://segmentos.example.test/assets/");
  assert.ok(manifesto.includes(`/canal/sid/s/${id}/abc123.css?e=1111&k=`));
  assert.equal(manifesto.includes("#EXT-X-MEDIA-SEQUENCE:1271"), true);
});

test("segmento com query string vira um recurso só, e a query não escapa", async () => {
  const entrada = [
    "#EXTM3U",
    "#EXTINF:4.0,",
    "https://segmentos.example.test/a/seg1.ts?token=abc&expira=9",
  ].join("\n");

  const { manifesto, basesUsadas } = await reescrever(entrada);

  assert.equal(vazaUpstream(manifesto, "https://media.example.test"), false);
  assert.equal(manifesto.includes("token=abc"), false, "a query do provider não pode sair crua");
  // A base guarda o host e o diretório; a query viaja encodada no recurso.
  assert.deepEqual(basesUsadas.map((b) => b.base), ["https://segmentos.example.test/a/"]);
  const linha = manifesto.split("\n").find((l) => l.startsWith("https://media."))!;
  // Só a NOSSA query está presente: exatamente um `?`, e ele é o do `e=`.
  assert.equal(linha.split("?").length, 2);
  assert.match(linha, /\?e=1111&k=/);
});

test("chave AES, MAP, MEDIA e variantes também são reescritos", async () => {
  const entrada = [
    "#EXTM3U",
    '#EXT-X-KEY:METHOD=AES-128,URI="https://chaves.example.test/k/1.key",IV=0x00',
    '#EXT-X-MAP:URI="https://cdn.example.test/live/init.mp4"',
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",URI="audio/pt.m3u8"',
    "#EXT-X-STREAM-INF:BANDWIDTH=800000",
    "variante-720.m3u8",
    "#EXTINF:4.0,",
    "seg1.ts",
  ].join("\n");

  const { manifesto } = await reescrever(entrada);

  assert.equal(vazaUpstream(manifesto, "https://media.example.test"), false);
  assert.equal(manifesto.includes("chaves.example.test"), false);
  assert.equal(manifesto.includes("cdn.example.test"), false);
  assert.match(manifesto, /#EXT-X-KEY:METHOD=AES-128,URI="https:\/\/media\.example\.test\/canal\/sid\/s\//);
  assert.match(manifesto, /IV=0x00/, "o resto da tag precisa sobreviver");
  assert.match(manifesto, /\/canal\/sid\/v\/[A-Za-z0-9_-]+\/variante-720\.m3u8\?e=2222&k=/);
  assert.match(manifesto, /\/canal\/sid\/v\/[A-Za-z0-9_-]+\/pt\.m3u8\?e=2222&k=/);
  assert.match(manifesto, /\/canal\/sid\/s\/[A-Za-z0-9_-]+\/seg1\.ts\?e=1111&k=/);
});

test("URI que não pode ser reescrita com segurança é removida, nunca repassada", async () => {
  const entrada = [
    "#EXTM3U",
    "http://inseguro.example.test/seg.ts",
    '#EXT-X-KEY:METHOD=AES-128,URI="http://inseguro.example.test/k.key"',
    "#EXTINF:4.0,",
    "bom.ts",
  ].join("\n");

  const { manifesto } = await reescrever(entrada);

  assert.equal(manifesto.includes("inseguro.example.test"), false);
  assert.equal(vazaUpstream(manifesto, "https://media.example.test"), false);
  assert.match(manifesto, /\/canal\/sid\/s\/[A-Za-z0-9_-]+\/bom\.ts/);
});

test("vazaUpstream é a rede que não envelhece junto com a lista de tags", () => {
  const edge = "https://media.example.test";
  assert.equal(vazaUpstream("#EXTM3U\nhttps://media.example.test/canal/x/s/0/a.ts", edge), false);
  assert.equal(vazaUpstream('#EXT-X-FUTURO:URI="https://cdn.example.test/x"', edge), true);
  assert.equal(vazaUpstream("#EXTM3U\nseg.ts", edge), false, "relativo não é vazamento");
  // O sufixo hostil: `startsWith` deixaria passar, `mesmaOrigem` não.
  assert.equal(
    vazaUpstream("#EXTM3U\nhttps://media.example.test.evil.example/a.ts", edge),
    true,
  );
});

test("o teto de bases impede um upstream hostil de inflar a sessão", async () => {
  const linhas = ["#EXTM3U"];
  for (let i = 0; i < 30; i++) {
    linhas.push("#EXTINF:4.0,", `https://host${i}.example.test/a/seg.ts`);
  }
  const { manifesto, basesUsadas } = await reescrever(linhas.join("\n"));

  // O teto protege duas coisas: a sessão de inchar e, agora que a persistência
  // de base é obrigatória, uma resposta de virar milhares de gravações no Redis.
  assert.ok(basesUsadas.length <= 8, `bases cresceu para ${basesUsadas.length}`);
  assert.equal(vazaUpstream(manifesto, "https://media.example.test"), false);
});
