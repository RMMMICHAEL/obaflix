import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { autorizarPorAnuncio } from "../ads/enforcement";
import { resolverDirectLink, hostParaLog } from "../ads/directLink";
import { PLANO_GRATUITO, PLANO_PREMIUM } from "../planos";
import type { Entitlements } from "../entitlements";
import type { DireitosDoPlano, PlanoSemeado } from "../planos";

/**
 * O enforcement no ponto onde a sessão nasce, e as promessas estruturais.
 *
 * A primeira metade exercita `autorizarPorAnuncio` com portas injetadas — sem
 * Redis, sem banco. A segunda lê arquivos: é o que trava promessas que não têm
 * como ser exercitadas em runtime aqui, como "o Direct Link não está no
 * repositório" e "a TV não tem anúncio".
 */

const raiz = process.cwd();

function direitosDe(plano: PlanoSemeado): DireitosDoPlano {
  const { id, nome, descricao, ordem, ativo, ehPadrao, ...direitos } = plano;
  void [id, nome, descricao, ordem, ativo, ehPadrao];
  return direitos as DireitosDoPlano;
}

function entitlementsDe(plano: PlanoSemeado): Entitlements {
  return {
    assinatura: { ativa: true, planoId: plano.id, expiraEm: null },
    direitos: direitosDe(plano),
  };
}

/** Resolver que conta chamadas — é o que prova os bypasses. */
function resolverFalso(ent: Entitlements | Error) {
  let chamadas = 0;
  return {
    chamadas: () => chamadas,
    resolver: async () => {
      chamadas++;
      if (ent instanceof Error) throw ent;
      return ent;
    },
  };
}

/** Consumidor que registra o que recebeu. */
function consumidorFalso(devolve: boolean) {
  const vistos: { id: string; userId: string }[] = [];
  return {
    vistos,
    consumir: async (id: string, userId: string) => {
      vistos.push({ id, userId });
      return devolve;
    },
  };
}

// ── Bypass ───────────────────────────────────────────────────────────────────

describe("quem não precisa de anúncio não paga por esta camada", () => {
  test("flag desligada libera SEM resolver entitlements", async () => {
    const { resolver, chamadas } = resolverFalso(entitlementsDe(PLANO_GRATUITO));
    const { consumir, vistos } = consumidorFalso(true);

    const r = await autorizarPorAnuncio(
      { userId: "u1", tipo: "filme", concessao: null },
      { ativa: false, resolver, consumir },
    );

    assert.deepEqual(r, { liberado: true, via: "flag_desligada" });
    assert.equal(chamadas(), 0, "com a flag off nada pode ser consultado");
    assert.equal(vistos.length, 0);
  });

  /** Cenário 1, na camada que cobra: assinante passa sem tocar no Redis de anúncio. */
  test("assinante é liberado sem consumir concessão", async () => {
    const { resolver } = resolverFalso(entitlementsDe(PLANO_PREMIUM));
    const { consumir, vistos } = consumidorFalso(true);

    const r = await autorizarPorAnuncio(
      { userId: "u1", tipo: "filme", concessao: null },
      { ativa: true, resolver, consumir },
    );

    assert.deepEqual(r, { liberado: true, via: "sem_anuncios" });
    assert.equal(vistos.length, 0, "nem chegou a olhar concessão");
  });
});

// ── Cobrança ─────────────────────────────────────────────────────────────────

describe("gratuito: a sessão só nasce com concessão", () => {
  /** Cenário 2, e o caso de quem pulou `/authorize` e chamou `/fontes` direto. */
  test("sem concessão, recusa", async () => {
    const { resolver } = resolverFalso(entitlementsDe(PLANO_GRATUITO));
    const { consumir, vistos } = consumidorFalso(true);

    const r = await autorizarPorAnuncio(
      { userId: "u1", tipo: "filme", concessao: null },
      { ativa: true, resolver, consumir },
    );

    assert.deepEqual(r, { liberado: false, motivo: "sem_concessao" });
    assert.equal(vistos.length, 0);
  });

  /** Cenário 3. */
  test("com concessão válida, libera e consome", async () => {
    const { resolver } = resolverFalso(entitlementsDe(PLANO_GRATUITO));
    const { consumir, vistos } = consumidorFalso(true);

    const r = await autorizarPorAnuncio(
      { userId: "u1", tipo: "filme", concessao: "c1" },
      { ativa: true, resolver, consumir },
    );

    assert.deepEqual(r, { liberado: true, via: "concessao" });
    assert.deepEqual(vistos, [{ id: "c1", userId: "u1" }]);
  });

  /** Cenários 4, 5 e 6 chegam aqui como a mesma recusa: o consumo falhou. */
  test("concessão recusada pelo consumo não libera", async () => {
    const { resolver } = resolverFalso(entitlementsDe(PLANO_GRATUITO));
    const { consumir } = consumidorFalso(false);

    const r = await autorizarPorAnuncio(
      { userId: "u1", tipo: "serie", concessao: "usada-ou-expirada" },
      { ativa: true, resolver, consumir },
    );

    assert.deepEqual(r, { liberado: false, motivo: "concessao_invalida" });
  });

  /** Fail-closed: não saber se a conta precisa de anúncio não vira "não precisa". */
  test("entitlements indisponíveis recusam", async () => {
    const { resolver } = resolverFalso(new Error("Redis fora"));
    const { consumir } = consumidorFalso(true);

    const r = await autorizarPorAnuncio(
      { userId: "u1", tipo: "filme", concessao: "c1" },
      { ativa: true, resolver, consumir },
    );

    assert.deepEqual(r, { liberado: false, motivo: "indeterminado" });
  });

  test("falha no consumo recusa, em vez de liberar", async () => {
    const { resolver } = resolverFalso(entitlementsDe(PLANO_GRATUITO));

    const r = await autorizarPorAnuncio(
      { userId: "u1", tipo: "filme", concessao: "c1" },
      {
        ativa: true,
        resolver,
        consumir: async () => {
          throw new Error("Redis fora no meio do consumo");
        },
      },
    );

    assert.deepEqual(r, { liberado: false, motivo: "indeterminado" });
  });
});

// ── Direct Link ──────────────────────────────────────────────────────────────

describe("Direct Link do Electron", () => {
  test("resolve a URL https homologada", () => {
    const r = resolverDirectLink({ ANUNCIO_DIRECT_LINK_URL: "https://omg10.com/4/11767843" });
    assert.equal(r.situacao, "ok");
  });

  test("recusa override https diferente do link homologado", () => {
    assert.equal(
      resolverDirectLink({ ANUNCIO_DIRECT_LINK_URL: "https://exemplo.invalido/outro" }).situacao,
      "indisponivel",
    );
  });

  /**
   * `shell.openExternal` abre o que receber. Um `http:` exporia o identificador
   * de publisher em claro na rede do usuário; `file:` e `javascript:` seriam
   * pior. A checagem de protocolo fecha os três.
   */
  test("recusa o que não for https", () => {
    for (const url of [
      "http://exemplo.invalido",
      "file:///etc/passwd",
      "javascript:alert(1)",
      "nao-e-url",
      "",
      "   ",
    ]) {
      assert.equal(
        resolverDirectLink({ ANUNCIO_DIRECT_LINK_URL: url }).situacao,
        "indisponivel",
        `${url} não pode ser aceito`,
      );
    }
  });

  test("ausente usa o Direct Link homologado", () => {
    assert.deepEqual(resolverDirectLink({}), {
      situacao: "ok",
      url: "https://omg10.com/4/11767843",
    });
  });

  /** O identificador de publisher vive na querystring — só o host vai ao log. */
  test("o log recebe só o host", () => {
    assert.equal(hostParaLog("https://rede.invalido/abc?publisher=SEGREDO&sub=123"), "rede.invalido");
    assert.equal(hostParaLog("nao-e-url"), "invalido");
  });

  /**
   * Cenário 15. A URL real é configuração de produção e o repositório nunca a
   * vê. Este teste falha se alguém "facilitar" colocando um default no código.
   */
  test("somente o Direct Link homologado aparece no servidor", () => {
    const fontes = [
      "src/lib/ads/directLink.ts",
      "src/lib/ads/concessoes.ts",
      "src/lib/ads/politica.ts",
      "src/lib/ads/enforcement.ts",
      "src/app/api/playback/authorize/route.ts",
      "src/app/api/ads/complete/route.ts",
    ];

    for (const arquivo of fontes) {
      const codigo = readFileSync(join(raiz, arquivo), "utf8")
        .split("\n")
        .filter((l) => {
          const t = l.trimStart();
          return !t.startsWith("*") && !t.startsWith("//") && !t.startsWith("/*");
        })
        .join("\n");

      // Só `exemplo.invalido` e afins podem aparecer, e mesmo isso não deve
      // estar em código de produção — nenhum literal https fora de comentário.
      const literais = codigo.match(/["'`]https:\/\/[^"'`]+["'`]/g) ?? [];
      const permitidos = arquivo === "src/lib/ads/directLink.ts"
        ? ['"https://omg10.com/4/11767843"']
        : [];
      assert.deepEqual(literais, permitidos, `${arquivo} tem URL literal não homologada`);
    }
  });

  /** Não pode virar variável de cliente: `NEXT_PUBLIC_` entra no bundle. */
  test("a variável não é NEXT_PUBLIC_", () => {
    const fonte = readFileSync(join(raiz, "src/lib/ads/directLink.ts"), "utf8");
    assert.ok(fonte.includes("ANUNCIO_DIRECT_LINK_URL"));
    assert.equal(/NEXT_PUBLIC_[A-Z_]*DIRECT/.test(fonte), false);

    assert.deepEqual(
      resolverDirectLink({ NEXT_PUBLIC_ANUNCIO_DIRECT_LINK_URL: "https://x.invalido" } as Record<string, string>),
      { situacao: "ok", url: "https://omg10.com/4/11767843" },
      "uma variável pública não pode substituir o Direct Link homologado",
    );
  });
});

// ── Promessas estruturais ────────────────────────────────────────────────────

describe("o que o servidor NÃO aceita como prova", () => {
  const rotaComplete = readFileSync(join(raiz, "src/app/api/ads/complete/route.ts"), "utf8");
  const codigoComplete = rotaComplete
    .split("\n")
    .filter((l) => {
      const t = l.trimStart();
      return !t.startsWith("*") && !t.startsWith("//") && !t.startsWith("/*");
    })
    .join("\n");

  /**
   * Cenário 16, e a regra mais importante desta rota: o `concluido` que o
   * cliente manda é registrado e **não decide**. Quem decide é o desafio (que o
   * servidor emitiu e consome uma vez) e o tempo mínimo (medido no nosso
   * relógio).
   */
  test("a concessão não é emitida por um booleano do cliente", () => {
    // Nenhum `if` sobre `concluido` governando a emissão.
    assert.equal(
      /if\s*\([^)]*\bconcluido\b[^)]*\)/.test(codigoComplete),
      false,
      "o campo do cliente não pode governar a emissão",
    );

    const posDesafio = codigoComplete.indexOf("await consumir(desafioId, userId)");
    const posTempo = codigoComplete.indexOf("TEMPO_MINIMO_DE_ANUNCIO_MS");
    const posEmite = codigoComplete.indexOf("await emitir({");

    assert.ok(posDesafio > -1 && posTempo > -1 && posEmite > -1);
    assert.ok(posDesafio < posEmite, "o desafio precisa ser consumido antes de emitir");
    assert.ok(posTempo < posEmite, "o tempo mínimo precisa ser conferido antes de emitir");
  });

  /**
   * Nenhuma das duas redes desta fase confirma fora de banda. A constante é
   * fixa no servidor de propósito: um campo do corpo que elevasse o nível seria
   * o próprio buraco.
   */
  test("a verificação é sempre soft, e o cliente não a escolhe", () => {
    assert.match(codigoComplete, /NivelDeVerificacao\s*=\s*"soft"/);
    assert.equal(
      /corpo\.\w*verificacao|corpo\.\w*nivel/.test(codigoComplete),
      false,
      "o cliente não pode informar o nível de verificação",
    );
  });

  test("desafio inválido não emite nada", () => {
    const posDesafio = codigoComplete.indexOf("const desafio = await consumir(");
    const bloco = codigoComplete.slice(posDesafio, posDesafio + 500);
    assert.ok(bloco.includes("if (!desafio)"));
    assert.ok(bloco.includes("403"));
  });
});

/**
 * Marcas de SDK/serviço de anúncios de terceiros.
 *
 * Coordenadas Gradle, pacotes Java/Kotlin, classes de entrada e chaves de
 * manifesto — o que aparece quando uma rede externa é incorporada. Não é uma
 * lista de palavras: "anuncio" e "ads" genéricos ficam de fora de propósito,
 * porque a TV tem o anúncio institucional próprio (vídeo do Obaflix servido
 * pelo nosso servidor, conclusão validada em `/api/ads/complete`).
 */
const SDKS_DE_ANUNCIO_DE_TERCEIROS: { rede: string; padrao: RegExp }[] = [
  { rede: "Unity Ads", padrao: /com\.unity3d\.ads|unity-ads|\bUnityAds\b|\bIUnityAds\w*/ },
  { rede: "Google Mobile Ads / AdMob", padrao: /play-services-ads|com\.google\.android\.gms\.ads|\bMobileAds\b|\bAdMob\b|gms\.ads\.APPLICATION_ID/i },
  { rede: "Google IMA", padrao: /com\.google\.ads\.interactivemedia|media3-exoplayer-ima|exoplayer\.ima\b|\bImaAdsLoader\b/ },
  { rede: "AppLovin", padrao: /com\.applovin|\bAppLovin\w*|applovin-sdk/i },
  { rede: "ironSource / LevelPlay", padrao: /com\.ironsource|com\.unity3d\.mediation|\bIronSource\b|\bLevelPlay\w*/i },
  { rede: "Meta Audience Network", padrao: /com\.facebook\.ads|audience-network-sdk|\bAudienceNetworkAds\b/ },
  { rede: "Pangle", padrao: /com\.bytedance\.sdk\.openadsdk|com\.pangle|\bPAGSdk\b/ },
  { rede: "Vungle / Liftoff", padrao: /com\.vungle/ },
  { rede: "Chartboost", padrao: /com\.chartboost/ },
  { rede: "InMobi", padrao: /com\.inmobi/ },
  { rede: "Mintegral", padrao: /com\.mbridge|com\.mintegral/ },
  { rede: "Start.io", padrao: /com\.startapp/ },
  { rede: "Yandex Ads", padrao: /com\.yandex\.mobile\.ads/ },
  { rede: "AdColony", padrao: /com\.adcolony/ },
  { rede: "Amazon Publisher Services", padrao: /com\.amazon\.device\.ads/ },
];

/** Arquivos do módulo em que um SDK se manifestaria. Imagens e vídeos não carregam SDK. */
const EXTENSOES_VARRIDAS = /\.(kt|kts|java|gradle|xml|pro|properties|toml|json)$/i;

function marcasDeSdkDeTerceiros(texto: string): string[] {
  return SDKS_DE_ANUNCIO_DE_TERCEIROS.filter(({ padrao }) => padrao.test(texto)).map(({ rede }) => rede);
}

describe("Android TV sem SDK de anúncios de terceiros", () => {
  /**
   * Cenário 17, na política atual: a TV pode exibir o anúncio institucional
   * próprio, mas não incorpora rede, SDK nem serviço de anúncios externo.
   * O teste lê o módulo `:tv` inteiro — build, manifesto, código e regras.
   */
  test("o build.gradle do :tv não depende de rede de anúncios", () => {
    const gradle = readFileSync(join(raiz, "android/tv/build.gradle"), "utf8");
    assert.deepEqual(marcasDeSdkDeTerceiros(gradle), [], ":tv não pode depender de SDK de anúncios de terceiros");
  });

  test("nenhum import, dependência ou identificador de SDK de terceiros no módulo :tv", async () => {
    const { readdirSync, statSync } = await import("node:fs");
    const encontrados: string[] = [];

    const varrer = (dir: string) => {
      for (const nome of readdirSync(dir)) {
        const caminho = join(dir, nome);
        if (statSync(caminho).isDirectory()) {
          if (nome !== "build") varrer(caminho);
        } else if (EXTENSOES_VARRIDAS.test(nome)) {
          for (const rede of marcasDeSdkDeTerceiros(readFileSync(caminho, "utf8"))) {
            encontrados.push(`${caminho}: ${rede}`);
          }
        }
      }
    };
    varrer(join(raiz, "android/tv"));

    assert.deepEqual(encontrados, [], "a TV não deve incorporar SDK de anúncios de terceiros");
  });

  test("o detector reconhece as redes e aceita o anúncio institucional próprio", () => {
    // Sem isto, um padrão quebrado deixaria o teste acima passando em silêncio.
    const proibidos = [
      `implementation 'com.unity3d.ads:unity-ads:4.9.2'`,
      `import com.unity3d.ads.UnityAds`,
      `implementation 'com.google.android.gms:play-services-ads:23.0.0'`,
      `import com.google.android.gms.ads.MobileAds`,
      `<meta-data android:name="com.google.android.gms.ads.APPLICATION_ID" />`,
      `implementation 'androidx.media3:media3-exoplayer-ima:1.3.1'`,
      `import com.applovin.sdk.AppLovinSdk`,
      `import com.ironsource.mediationsdk.IronSource`,
      `import com.facebook.ads.AudienceNetworkAds`,
      `import com.bytedance.sdk.openadsdk.api.init.PAGSdk`,
      `import com.vungle.ads.VungleAds`,
      `import com.chartboost.sdk.Chartboost`,
    ];
    for (const linha of proibidos) {
      assert.notDeepEqual(marcasDeSdkDeTerceiros(linha), [], `deveria detectar: ${linha}`);
    }

    const permitidos = [
      `package com.obaflix.tv.player`,
      `fun EscolhaFinalDoAnuncio(focoInicial: AlvoDaEscolha, aoEscolher: (AlvoDaEscolha) -> Unit)`,
      `R.drawable.anuncio_escolha_final`,
      `ApiObaflix.concluirPromocao(atual.desafioId) // "/api/ads/complete"`,
      `class AnuncioInstitucionalTest`,
      `import androidx.media3.exoplayer.ExoPlayer`,
      `val downloads = loads + uploads`,
    ];
    for (const linha of permitidos) {
      assert.deepEqual(marcasDeSdkDeTerceiros(linha), [], `não deveria detectar: ${linha}`);
    }
  });
});
