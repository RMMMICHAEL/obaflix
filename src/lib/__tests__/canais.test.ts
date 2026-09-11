/**
 * Testes de segurança dos canais ao vivo.
 *
 * O que se prova aqui não é que o vídeo toca — é que ele **não** toca para quem
 * não devia, e que o upstream não sai por nenhuma das saídas.
 *
 * A divisão segue as camadas:
 *
 *   1. acesso      — a escala ordenada de níveis
 *   2. autorização — a rota de concessão, por injeção de dependência
 *   3. catálogo    — o que sai e o que não sai na listagem
 *   4. resolver    — SSRF, allowlist, protocolo
 *   5. assinatura  — expiração, adulteração, escopo, dono
 *   6. HLS         — nenhuma URL de upstream sobrevive à reescrita
 */

import assert from "node:assert/strict";
import test from "node:test";
import { NextRequest } from "next/server";

import { autorizarCanal, nivelAlcanca } from "../canais/acesso";
import { extrairCandidatosDeMidia } from "../canais/resolver";
import { hostDeMidiaPermitido, ehIdDeProviderValido, montarUrlDoPlayer } from "../canais/providers";
import { materialAssinado } from "../canais/assinatura";
import { reescreverManifesto, vazaUpstream } from "../canais/hls";
import { createPlayCanalHandler, type CanalDoBanco } from "../../app/api/canais/[id]/play/route";
import { createCanaisCatalogoHandler } from "../../app/api/canais/route";

// ── 1. Acesso: a escala ordenada ─────────────────────────────────────────────

test("nivelAlcanca respeita a ordem nenhum < gratuito < plus < premium", () => {
  assert.equal(nivelAlcanca("premium", "plus"), true);
  assert.equal(nivelAlcanca("premium", "premium"), true);
  assert.equal(nivelAlcanca("plus", "premium"), false);
  assert.equal(nivelAlcanca("gratuito", "plus"), false);
  assert.equal(nivelAlcanca("nenhum", "gratuito"), false);
  // Valor fora do domínio nunca permite — nem como concedido, nem como exigido.
  assert.equal(nivelAlcanca("deus", "premium"), false);
  assert.equal(nivelAlcanca("premium", "inexistente"), false);
  assert.equal(nivelAlcanca("", ""), false);
});

test("autorizarCanal nega plano insuficiente, canal inativo e canal adulto", () => {
  const base = { nivelMinimo: "plus", ativo: true, adulto: false };

  assert.equal(autorizarCanal(base, "premium").situacao, "permitido");
  assert.equal(autorizarCanal(base, "plus").situacao, "permitido");
  assert.equal(autorizarCanal(base, "gratuito").situacao, "negado");
  assert.equal(autorizarCanal(base, "nenhum").situacao, "negado");

  // Canal fora do ar nega mesmo para premium.
  assert.equal(autorizarCanal({ ...base, ativo: false }, "premium").situacao, "negado");
  // Adulto nega mesmo ativo e mesmo para premium.
  assert.equal(autorizarCanal({ ...base, adulto: true }, "premium").situacao, "negado");

  // Nível fora do domínio é incidente, não resposta sobre a conta.
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
  const chamadas = { resolveu: 0, sessoes: 0 };
  const handler = createPlayCanalHandler({
    env: { CANAIS_MEDIA_BASE: "https://media.example.test" },
    clientIp: () => "1.2.3.4",
    isIpBlocked: async () => false,
    recordAbuseAttempt: async () => {},
    getUserFromRequest: async () => ({ userId: "u1" }),
    checkRateLimit: async () => ({ allowed: true }),
    buscarCanal: async (id) => (id === canal.id || id === canal.slug ? canal : null),
    nivelDaConta: async () => "premium",
    resolver: async () => {
      chamadas.resolveu++;
      return FONTE;
    },
    criarSessao: async () => {
      chamadas.sessoes++;
      return { sessionId: "s".repeat(32), exp: 2_000_000_000, sig: "a".repeat(22) };
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
  // A parte cara nunca é paga por quem não provou ser ninguém.
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
  // Id que não existe.
  assert.equal((await run("nao-existe")).status, 404);
  // Id absurdo/gigante: mesma recusa, sem exceção e sem consulta especial.
  assert.equal((await run("../../etc/passwd")).status, 404);
  assert.equal((await run("x".repeat(200))).status, 404);

  // Trocar o id para um canal premium com uma conta plus continua negando: o
  // direito sai da linha do banco, nunca do que o cliente digitou.
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
  // O host do CDN, o host do player, a chave do provider e o id dele no
  // provider — nenhum tem caminho para a resposta.
  for (const proibido of ["cdn.example.test", "player.example.test", "megafrix", "Referer", "cookie"]) {
    assert.equal(texto.includes(proibido), false, `vazou "${proibido}" na concessão`);
  }
  // `abc` é o providerChannelId. Testado à parte porque é curto o bastante para
  // casar por acidente dentro de um id de sessão aleatório — aqui a sessão é
  // fixa, então a asserção é honesta.
  assert.equal(texto.includes("abc"), false, "vazou o providerChannelId");
  assert.equal(r.headers.get("Cache-Control")?.includes("no-store"), true);
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
    listarCanais: async ({ nivelDaConta }) => [
      {
        id: "c1", slug: "aberto", nome: "Aberto", categoria: "abertos", logoUrl: null,
        aoVivo: true, nivelMinimo: "gratuito", liberado: nivelAlcanca(nivelDaConta, "gratuito"),
      },
      {
        id: "c2", slug: "pago", nome: "Pago", categoria: "esportes", logoUrl: null,
        aoVivo: true, nivelMinimo: "premium", liberado: nivelAlcanca(nivelDaConta, "premium"),
      },
    ],
    categoriasComCanais: async () => ["todos", "abertos", "esportes"],
    ...over,
  });
}

test("catálogo exige sessão", async () => {
  const h = catalogo({ getUserFromRequest: async () => null });
  const r = await h(new NextRequest("http://local/api/canais"));
  assert.equal(r.status, 401);
});

test("catálogo não expõe HLS, player URL, provider nem cookie", async () => {
  const h = catalogo();
  const r = await h(new NextRequest("http://local/api/canais"));
  const texto = JSON.stringify(await r.json());

  for (const proibido of [".m3u8", "media_url", "player_url", "megafrix", "providerChannelId", "Cookie", "referer"]) {
    assert.equal(texto.toLowerCase().includes(proibido.toLowerCase()), false, `vazou "${proibido}"`);
  }
  // O que o cliente precisa para desenhar o cadeado: nível e liberado.
  const corpo = JSON.parse(texto);
  assert.equal(corpo.canais[0].liberado, true);
  assert.equal(corpo.canais[1].liberado, false, "gratuito não pode ver premium como liberado");
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
  // Sem a variável, nada passa. Allowlist vazia que libera seria um SSRF.
  assert.equal(hostDeMidiaPermitido("cdn.example.test", {}), false);
  assert.equal(hostDeMidiaPermitido("cdn.example.test", { CANAIS_CDN_ALLOWLIST: "" }), false);

  const env = { CANAIS_CDN_ALLOWLIST: "example.test, outro.test" };
  assert.equal(hostDeMidiaPermitido("example.test", env), true);
  assert.equal(hostDeMidiaPermitido("cdn.example.test", env), true);
  assert.equal(hostDeMidiaPermitido("CDN.EXAMPLE.TEST", env), true);
  // O ataque clássico de sufixo sem ponto.
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

  // http:// e ftp:// nem chegam a ser candidatos — o padrão exige https.
  assert.equal(achados.some((u) => u.startsWith("http://")), false);
  assert.equal(achados.some((u) => u.startsWith("ftp:")), false);
  // localhost é candidato aqui, e é recusado adiante por `assertSafeUrl` e pela
  // allowlist. As duas portas são independentes de propósito.
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

test("o material assinado separa escopo, sessão, recurso e expiração", () => {
  const m = materialAssinado({ escopo: "s", sessionId: "sid", recurso: "0/seg.ts", exp: 42 });
  assert.equal(m, "s:sid:0/seg.ts:42");
  // Trocar o escopo muda o material: uma assinatura de manifesto não vale como
  // assinatura de segmento, e é isso que dá efeito ao TTL curto do segmento.
  assert.notEqual(m, materialAssinado({ escopo: "m", sessionId: "sid", recurso: "0/seg.ts", exp: 42 }));
  // Trocar qualquer campo muda o material.
  assert.notEqual(m, materialAssinado({ escopo: "s", sessionId: "sid2", recurso: "0/seg.ts", exp: 42 }));
  assert.notEqual(m, materialAssinado({ escopo: "s", sessionId: "sid", recurso: "1/seg.ts", exp: 42 }));
  assert.notEqual(m, materialAssinado({ escopo: "s", sessionId: "sid", recurso: "0/seg.ts", exp: 43 }));
});

test("assinar e conferir: adulteração, expiração e dono", async (t) => {
  process.env.NEXTAUTH_SECRET ||= "segredo-de-teste";
  const { assinar, assinaturaConfere, derivarSub } = await import("../canais/sessao");

  const p = { escopo: "m" as const, sessionId: "sid-1", recurso: "master", exp: 2_000_000_000 };
  const sig = assinar(p);

  await t.test("assinatura válida confere", () => {
    assert.equal(assinaturaConfere(p, sig), true);
  });

  await t.test("token alterado é recusado", () => {
    // Um caractere trocado.
    const adulterada = (sig[0] === "A" ? "B" : "A") + sig.slice(1);
    assert.equal(assinaturaConfere(p, adulterada), false);
    // Comprimento diferente também, sem lançar.
    assert.equal(assinaturaConfere(p, sig.slice(1)), false);
    assert.equal(assinaturaConfere(p, ""), false);
  });

  await t.test("recurso, sessão ou escopo diferentes não reaproveitam a assinatura", () => {
    assert.equal(assinaturaConfere({ ...p, recurso: "0/outro.ts" }, sig), false);
    assert.equal(assinaturaConfere({ ...p, sessionId: "sid-2" }, sig), false);
    assert.equal(assinaturaConfere({ ...p, escopo: "s" }, sig), false);
    // Esticar a expiração invalida: `exp` está dentro do material assinado.
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

// ── 6. HLS: o upstream não sobrevive à reescrita ─────────────────────────────

const assinadorFalso = async (escopo: "m" | "s", recurso: string, exp: number) =>
  `sig-${escopo}-${recurso.length}-${exp}`;

async function reescrever(manifesto: string, basesConhecidas: string[] = []) {
  return reescreverManifesto({
    manifesto,
    urlDoManifesto: "https://cdn.example.test/live/master.m3u8",
    sessionId: "sid",
    baseDoEdge: "https://media.example.test",
    basesConhecidas,
    expSegmento: 1111,
    expManifesto: 2222,
    assinar: assinadorFalso,
  });
}

test("segmentos absolutos de outro host são reescritos e o CDN não sobrevive", async () => {
  // A forma real medida na Fase A: segmentos absolutos, noutro host, com
  // extensão disfarçada.
  const entrada = [
    "#EXTM3U",
    "#EXT-X-VERSION:3",
    "#EXT-X-MEDIA-SEQUENCE:1271",
    "#EXTINF:10.0,",
    "https://segmentos.example.test/assets/abc123.css",
    "#EXTINF:10.0,",
    "https://segmentos.example.test/assets/def456.css",
  ].join("\n");

  const { manifesto, bases, basesMudaram } = await reescrever(entrada);

  assert.equal(vazaUpstream(manifesto, "https://media.example.test"), false);
  assert.equal(manifesto.includes("segmentos.example.test"), false);
  assert.equal(basesMudaram, true);
  assert.deepEqual(bases, ["https://segmentos.example.test/assets/"]);
  // O cliente vê índice e nome do arquivo, nunca o host.
  assert.match(manifesto, /media\.example\.test\/canal\/sid\/s\/0\/abc123\.css\?e=1111&k=/);
  // As tags são preservadas.
  assert.equal(manifesto.includes("#EXT-X-MEDIA-SEQUENCE:1271"), true);
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
  // A URI da chave continua sendo uma URI, só que nossa — e com escopo de
  // segmento, porque a chave é buscada uma vez como um segmento.
  assert.match(manifesto, /#EXT-X-KEY:METHOD=AES-128,URI="https:\/\/media\.example\.test\/canal\/sid\/s\//);
  assert.match(manifesto, /IV=0x00/, "o resto da tag precisa sobreviver");
  // Manifesto filho ganha rota e validade de manifesto, não de segmento.
  assert.match(manifesto, /\/canal\/sid\/v\/\d+\/variante-720\.m3u8\?e=2222&k=/);
  assert.match(manifesto, /\/canal\/sid\/v\/\d+\/pt\.m3u8\?e=2222&k=/);
  // Segmento relativo resolve contra a base do manifesto.
  assert.match(manifesto, /\/canal\/sid\/s\/\d+\/seg1\.ts\?e=1111&k=/);
});

test("URI que não pode ser reescrita com segurança é removida, nunca repassada", async () => {
  const entrada = [
    "#EXTM3U",
    // http:// simples: não vira URL do edge, e não pode sair como está.
    "http://inseguro.example.test/seg.ts",
    '#EXT-X-KEY:METHOD=AES-128,URI="http://inseguro.example.test/k.key"',
    "#EXTINF:4.0,",
    "bom.ts",
  ].join("\n");

  const { manifesto } = await reescrever(entrada);

  assert.equal(manifesto.includes("inseguro.example.test"), false);
  assert.equal(vazaUpstream(manifesto, "https://media.example.test"), false);
  assert.match(manifesto, /\/canal\/sid\/s\/\d+\/bom\.ts/);
});

test("vazaUpstream é a rede que não envelhece junto com a lista de tags", () => {
  const edge = "https://media.example.test";
  assert.equal(vazaUpstream("#EXTM3U\nhttps://media.example.test/canal/x/s/0/a.ts", edge), false);
  // Uma tag futura que a reescrita ainda não conheça é pega aqui.
  assert.equal(vazaUpstream('#EXT-X-FUTURO:URI="https://cdn.example.test/x"', edge), true);
  assert.equal(vazaUpstream("#EXTM3U\nseg.ts", edge), false, "relativo não é vazamento");
});

test("o teto de bases impede um upstream hostil de inflar a sessão", async () => {
  const linhas = ["#EXTM3U"];
  for (let i = 0; i < 30; i++) {
    linhas.push("#EXTINF:4.0,", `https://host${i}.example.test/a/seg.ts`);
  }
  const { manifesto, bases } = await reescrever(linhas.join("\n"));

  assert.ok(bases.length <= 8, `bases cresceu para ${bases.length}`);
  // Passando do teto, as linhas são descartadas — não repassadas.
  assert.equal(vazaUpstream(manifesto, "https://media.example.test"), false);
});
