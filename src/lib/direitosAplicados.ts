/**
 * Quais direitos de `Plano` o backend **de fato aplica**, e quais só estão
 * gravados.
 *
 * Existe porque a diferença entre "gravado" e "aplicado" é invisível no schema e
 * cara de descobrir tarde. `Plano.downloads = false` numa linha do banco parece
 * uma trava; se nenhuma rota lê aquela coluna, é texto de vitrine.
 *
 * ## Por que um registro em código, e não um parágrafo na documentação
 *
 * Documentação envelhece em silêncio. Este mapa é lido por
 * `src/lib/__tests__/direitosAplicados.test.ts`, que falha quando:
 *
 *   - um direito novo entra em `DireitosDoPlano` e ninguém o classifica aqui;
 *   - um direito sai de `DireitosDoPlano` e a entrada fica órfã;
 *   - alguém marca `aplicado` sem que o arquivo citado mencione o campo.
 *
 * A terceira é a que dá dentes ao mapa: não dá para promover um direito a
 * "aplicado" só editando esta linha.
 *
 * ## O que "aplicado" significa aqui
 *
 * Que existe código nosso que **nega** alguma coisa por causa do valor. Não
 * significa que a negação seja inviolável — `downloads` é decidido no servidor e
 * obedecido no cliente, e isso está dito na própria entrada. Significa que o
 * valor sai do banco e muda o comportamento.
 */

import type { DireitosDoPlano } from "./planos";

export type EstadoDeAplicacao =
  /** Existe código que nega por causa deste valor. */
  | "aplicado"
  /** O valor é gravado e lido, e nenhum caminho o usa para negar nada. */
  | "nao_aplicado";

export interface AplicacaoDoDireito {
  estado: EstadoDeAplicacao;
  /**
   * O arquivo onde a aplicação acontece — conferido pelo teste. Vazio quando
   * `nao_aplicado`, e o teste também confere isso.
   */
  onde: string;
  /** O que falta, quando falta. Só para quem for implementar. */
  nota: string;
}

/**
 * O mapa, direito a direito.
 *
 * A chave é `keyof DireitosDoPlano`: o TypeScript obriga a listar todos, e o
 * teste obriga a não listar nada a mais.
 */
export const APLICACAO_DOS_DIREITOS: Record<keyof DireitosDoPlano, AplicacaoDoDireito> = {
  filmes: {
    estado: "aplicado",
    onde: "src/lib/playbackAuthorization.ts",
    nota: "Nega a criação de sessão em POST /api/player/fontes, atrás de MONETIZACAO_ATIVA.",
  },
  series: {
    estado: "aplicado",
    onde: "src/lib/playbackAuthorization.ts",
    nota: "Mesmo caminho de `filmes`.",
  },

  telasMax: {
    estado: "aplicado",
    onde: "src/lib/playTokens.ts",
    nota:
      "Limite de streams simultâneos no sorted set do Redis. Atrás de " +
      "MONETIZACAO_ATIVA: com a flag desligada vale MAX_CONCURRENT, que é o " +
      "comportamento anterior. Enforcement real de servidor — o cliente não " +
      "participa da decisão nem consegue contorná-la.",
  },

  downloads: {
    estado: "aplicado",
    onde: "src/lib/playbackAuthorization.ts",
    nota:
      "Decidido no servidor e devolvido em POST /api/player/fontes; o player só " +
      "oferece download quando vem `true`. **É decisão de servidor obedecida no " +
      "cliente, não uma fronteira criptográfica**: o download do Electron vai do " +
      "app direto ao CDN, sem passar por nós, então um cliente modificado ainda " +
      "consegue salvar o que já está reproduzindo. Fechar isso de verdade exigiria " +
      "gatear o IPC em desktop/electron/main.js — e ainda assim quem tem a mídia " +
      "tocando tem os bytes. Ver docs/monetizacao-arquitetura.md 5.3.",
  },

  canaisNivel: {
    estado: "nao_aplicado",
    onde: "",
    nota:
      "A camada que aplica existe (src/lib/canais/acesso.ts, consumida por " +
      "/api/canais e /api/canais/[id]/play) mas vive na branch " +
      "feat/canais-todas-plataformas e ainda não está em main. Enquanto não " +
      "estiver, o valor é gravado e ninguém o lê. Promover a `aplicado` quando a " +
      "branch entrar.",
  },

  resolucaoMax: {
    estado: "nao_aplicado",
    onde: "",
    nota:
      "Nenhuma rota limita qualidade. O player recebe o manifesto que a fonte " +
      "entrega, com as variantes que ela tiver. Aplicar exigiria filtrar as " +
      "variantes do manifesto HLS no proxy — e o Electron e o Android não passam " +
      "pelo nosso proxy no caminho nativo, então a aplicação seria desigual " +
      "entre os três ambientes.",
  },

  tvNivel: {
    estado: "nao_aplicado",
    onde: "",
    nota:
      "Nenhuma rota lê. O app de TV autentica por Bearer e recebe o mesmo " +
      "catálogo do site. Aplicar significa decidir a política da TV (D-10) e " +
      "gatear /api/tv/* por ela.",
  },

  perfisMax: {
    estado: "nao_aplicado",
    onde: "",
    nota: "Perfis não existem no schema (D-5). Campo reservado; nada a aplicar.",
  },

  anunciosObrigatorios: {
    estado: "nao_aplicado",
    onde: "",
    nota:
      "A fase de anúncios não foi escrita, e nenhum plano de hoje exige anúncio " +
      "— os quatro estão em `false`. Aplicar depende da concessão de anúncio e " +
      "do SSV da rede (D-1, D-9).",
  },
  episodiosPorAnuncio: {
    estado: "nao_aplicado",
    onde: "",
    nota:
      "O `N` da regra de séries. `null` em todos os planos de hoje, porque sem " +
      "`anunciosObrigatorios` não há o que contar. Mesma fase de anúncios.",
  },
  janelaAnuncioHoras: {
    estado: "nao_aplicado",
    onde: "",
    nota:
      "Janela do contador de episódios. Irrelevante enquanto nenhum plano exigir " +
      "anúncio; entra junto de `episodiosPorAnuncio`.",
  },
};

/** Os direitos que negam alguma coisa hoje. */
export function direitosAplicados(): (keyof DireitosDoPlano)[] {
  return (Object.keys(APLICACAO_DOS_DIREITOS) as (keyof DireitosDoPlano)[]).filter(
    (k) => APLICACAO_DOS_DIREITOS[k].estado === "aplicado",
  );
}

/** Os direitos gravados sem consumidor. Vitrine, não trava. */
export function direitosNaoAplicados(): (keyof DireitosDoPlano)[] {
  return (Object.keys(APLICACAO_DOS_DIREITOS) as (keyof DireitosDoPlano)[]).filter(
    (k) => APLICACAO_DOS_DIREITOS[k].estado === "nao_aplicado",
  );
}
