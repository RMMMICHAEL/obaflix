/**
 * O cliente consegue conduzir um desafio "não sou robô"?
 *
 * `montarFontes` só oferece a fonte de desafio interativo em ambiente `android`
 * quando recebe `desafioInterativo: true` (ver `src/lib/fontes.ts`). A decisão
 * pertence ao aplicativo, não ao servidor: depende de a WebView do aparelho
 * conseguir remover o `X-Requested-With`, o que exige WebView 118+. Abaixo
 * disso o header vaza o pacote e o provedor responde acesso negado — a fonte
 * apareceria na lista só para entregar uma tela de erro.
 *
 * ## Por que não basta detectar "é Android"
 *
 * User-Agent, `platform` ou a classe `obaflix-android-app` dizem onde a página
 * está, nunca o que o aparelho consegue fazer. Navegador Android comum não tem
 * ponte nativa nenhuma: não há overlay para conduzir o desafio, e afirmar a
 * capacidade ali encheria a lista de um servidor que nunca abre. Por isso a
 * checagem exige as três coisas juntas — estar dentro do aplicativo, a ponte
 * declarar a capacidade, e os métodos do fluxo existirem de fato.
 *
 * ## Por que `suportaSuperflix` é exigido, e não deduzido
 *
 * Os métodos `prepareSuperflix`/`resolveSuperflix` existem na ponte desde antes
 * desta checagem, em qualquer versão de WebView — presença deles prova que há
 * ponte, não que o desafio é conduzível. Só o nativo sabe a segunda parte, e
 * responde por `suportaSuperflix`. Aplicativo antigo, que não declara o campo,
 * continua sem a fonte: é exatamente o comportamento de hoje, então site novo
 * com APK velho não regride nem passa a oferecer o que não funciona.
 */

/** Só o que esta decisão lê da ponte. */
type PonteComDesafio = {
  platform?: unknown;
  suportaSuperflix?: unknown;
  prepareSuperflix?: unknown;
  resolveSuperflix?: unknown;
};

/**
 * @param ponte `window.obaflixDesktop`, quando existe.
 *
 * Electron cai fora por `platform`: o preload não define o campo e a fonte já
 * chega por outro caminho (`!ehAndroid` em `montarFontes`), então nada muda lá.
 */
export function suportaDesafioInterativo(ponte: unknown): boolean {
  if (!ponte || typeof ponte !== "object") return false;
  const p = ponte as PonteComDesafio;
  return (
    p.platform === "android" &&
    p.suportaSuperflix === true &&
    typeof p.prepareSuperflix === "function" &&
    typeof p.resolveSuperflix === "function"
  );
}

/**
 * Mesma decisão, lendo a ponte da janela.
 *
 * Devolve `false` sem janela (render no servidor) e antes de o shim completo
 * entrar: o shim precoce só tem `onUpdateReady`/`installUpdate`, então o pedido
 * que saísse cedo demais pede a lista sem a fonte — o mesmo que hoje.
 */
export function desafioInterativoDisponivel(): boolean {
  if (typeof window === "undefined") return false;
  return suportaDesafioInterativo(
    (window as { obaflixDesktop?: unknown }).obaflixDesktop,
  );
}
