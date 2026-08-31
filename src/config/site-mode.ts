/**
 * Quem entra por onde.
 *
 * O Obaflix serve três públicos pelo mesmo deploy, e eles não podem ver a mesma
 * coisa em `/`:
 *
 *   - **navegador comum** → landing de download. O streaming web está fechado;
 *   - **Android** (WebView do APK) → a interface Android completa, em `/android`;
 *   - **Electron** (exe Windows) → a interface web completa, em `/desktop`.
 *
 * Android e Electron *são* o site: os dois navegam pelas mesmas páginas de
 * catálogo, detalhe, busca, perfil e player. Fechar o site para eles seria
 * fechar o produto. Por isso o fechamento não é por rota — é por ambiente.
 *
 * O que este arquivo NÃO faz, de propósito:
 *   - não desliga nada em `/api/*`. Auth, sessão, login, pareamento, catálogo,
 *     player, progresso e favoritos continuam idênticos para todo mundo;
 *   - não é autenticação. User-Agent e header são **roteamento**, não segredo:
 *     dizem qual interface entregar, nunca quem a pessoa é nem o que ela pode
 *     acessar. Quem protege dado continua sendo sessão, token e as próprias
 *     rotas — exatamente como antes desta mudança.
 *
 * Para reabrir o streaming na web inteira, uma variável: `WEB_STREAMING_ENABLED=true`.
 */

/** `true` reabre o site de streaming para navegador comum, e `/` volta a ser a home. */
export const WEB_STREAMING_ENABLED = process.env.WEB_STREAMING_ENABLED === "true";

export type Ambiente = "android" | "desktop" | "navegador";

/** Entrada dedicada de cada aplicativo. */
export const ENTRADA: Record<Exclude<Ambiente, "navegador">, string> = {
  android: "/android",
  desktop: "/desktop",
};

/**
 * Header que os clientes oficiais enviam. Existe para tornar a identificação
 * explícita em vez de depender só do formato do User-Agent, que muda quando o
 * WebView ou o Chromium do Electron sobe de versão.
 *
 * Não é credencial. Qualquer um pode enviá-lo — e tudo que ganha é escolher
 * qual interface recebe, o mesmo que já se ganha trocando o User-Agent.
 */
export const HEADER_CLIENTE = "x-obaflix-client";

const UA_ANDROID = /ObaflixApp\//i;
const UA_DESKTOP = /ObaflixDesktop\//i;

/**
 * De qual ambiente veio a requisição.
 *
 * O header vem primeiro por ser o sinal deliberado; o User-Agent é o que
 * segura as versões já instaladas, que não conhecem o header.
 */
export function detectarAmbiente(
  userAgent: string | null | undefined,
  headerCliente: string | null | undefined,
): Ambiente {
  const declarado = (headerCliente ?? "").trim().toLowerCase();
  if (declarado === "android" || declarado === "desktop") return declarado;

  const ua = userAgent ?? "";
  if (UA_ANDROID.test(ua)) return "android";
  if (UA_DESKTOP.test(ua)) return "desktop";
  return "navegador";
}

/**
 * Caminhos que ficam abertos para todo mundo, em qualquer ambiente.
 *
 * É allowlist de propósito: rota pública nova nasce fechada para navegador.
 * Esquecer de liberar é visível e reversível; esquecer de fechar não seria.
 */
const PUBLICO = [
  "/parear",
  "/login",
  "/cadastro",
  "/admin",
  "/api",
  "/robots.txt",
  "/sitemap",
  "/manifest",
  "/favicon.ico",
  "/opensearch.xml",
];

const dentroDe = (pathname: string, base: string) =>
  pathname === base || pathname.startsWith(`${base}/`);

export type Decisao =
  /** Serve a rota pedida, sem mexer. */
  | { tipo: "segue" }
  /** Entrega outra rota sem mudar a URL na barra (compatibilidade com apps antigos). */
  | { tipo: "reescreve"; para: string }
  /** Manda para a landing: este ambiente não tem o que fazer aqui. */
  | { tipo: "landing" };

/**
 * A decisão de roteamento, num lugar só. O middleware apenas executa o que sai
 * daqui — assim o comportamento é testável sem subir o Next e não existe uma
 * segunda regra escondida em outro arquivo.
 */
export function decidirRota(pathname: string, ambiente: Ambiente): Decisao {
  // Site reaberto: ninguém é desviado de lugar nenhum.
  if (WEB_STREAMING_ENABLED) return { tipo: "segue" };

  if (PUBLICO.some((base) => dentroDe(pathname, base))) return { tipo: "segue" };

  // As entradas internas só respondem para o ambiente a que pertencem. Saber a
  // URL não é o que dá acesso: um navegador em `/android` volta para a landing.
  if (dentroDe(pathname, ENTRADA.android)) {
    return ambiente === "android" ? { tipo: "segue" } : { tipo: "landing" };
  }
  if (dentroDe(pathname, ENTRADA.desktop)) {
    return ambiente === "desktop" ? { tipo: "segue" } : { tipo: "landing" };
  }

  // A raiz é o ponto onde os três se cruzam. Versões já instaladas do Android e
  // do Electron abrem `/` direto e não podem cair na landing — daí a reescrita
  // interna, que as leva à entrada certa sem exigir atualização do aplicativo.
  if (pathname === "/") {
    if (ambiente === "navegador") return { tipo: "segue" };
    return { tipo: "reescreve", para: ENTRADA[ambiente] };
  }

  // Todo o resto é a interface de streaming: liberada para os aplicativos,
  // fechada para navegador.
  return ambiente === "navegador" ? { tipo: "landing" } : { tipo: "segue" };
}
