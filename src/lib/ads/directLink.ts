/**
 * O Direct Link do Electron — a URL que abre no navegador externo.
 *
 * ## Por que ela não está no repositório, e não pode estar
 *
 * A URL da rede de anúncios carrega o identificador da conta de publisher. Quem
 * a tem consegue gerar impressões fora do aplicativo, e tráfego artificial não
 * dá receita: dá suspensão da conta. Então ela é **configuração de produção**,
 * lida do ambiente do servidor, e o repositório nunca a vê.
 *
 * Três consequências disso, todas deliberadas:
 *
 *  - **Nunca em `NEXT_PUBLIC_`.** Uma variável com esse prefixo entra no bundle
 *    do cliente e vira parte do código público do site.
 *  - **Nunca em log.** `ObaLog`/`console` recebem no máximo o host, e só quando
 *    há diagnóstico ligado. A querystring é onde mora o identificador.
 *  - **Só sai do servidor quando faz sentido.** A rota de autorização devolve a
 *    URL apenas para quem realmente precisa ver anúncio, e apenas no Electron.
 *    Um assinante nunca recebe este campo — não é escondido na interface, é
 *    ausente da resposta.
 *
 * O nome é neutro (`ANUNCIO_DIRECT_LINK_URL`) porque o nome da rede também é
 * informação: `docs/environment.md` documenta a variável sem valor.
 */

/** O que o servidor conseguiu resolver. */
export type ResolucaoDoDirectLink =
  | { situacao: "ok"; url: string }
  /** Não configurado, ou configurado com valor inaceitável. */
  | { situacao: "indisponivel" };

/**
 * Lê e valida a URL do ambiente.
 *
 * `https:` obrigatório: `shell.openExternal` no Electron abre o que receber, e
 * um `http:` aqui exporia o identificador de publisher em texto claro na rede do
 * usuário. Qualquer outro esquema — `file:`, `javascript:` — seria pior ainda, e
 * a checagem de protocolo fecha os três de uma vez.
 *
 * Devolve `indisponivel` em vez de lançar: falta de configuração da rede de
 * anúncios não deve derrubar a rota de autorização inteira. Quem chama decide o
 * que fazer, e o que ele faz é liberar a reprodução — ver a nota em
 * `/api/playback/authorize` sobre por que a falta do Direct Link não pode virar
 * conteúdo bloqueado.
 */
export function resolverDirectLink(
  env: Record<string, string | undefined> = process.env,
): ResolucaoDoDirectLink {
  const bruta = env.ANUNCIO_DIRECT_LINK_URL;
  if (typeof bruta !== "string" || bruta.trim() === "") return { situacao: "indisponivel" };

  let url: URL;
  try {
    url = new URL(bruta.trim());
  } catch {
    return { situacao: "indisponivel" };
  }
  if (url.protocol !== "https:") return { situacao: "indisponivel" };

  return { situacao: "ok", url: url.toString() };
}

/**
 * O que pode ir para o log sobre uma URL de Direct Link: o host, e só.
 *
 * O identificador de publisher vive na querystring e no caminho. Registrar a URL
 * inteira colocaria a credencial da rede no Vercel Logs, que é exatamente o que
 * a variável de ambiente existe para evitar.
 */
export function hostParaLog(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "invalido";
  }
}
