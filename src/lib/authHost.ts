import { AsyncLocalStorage } from "node:async_hooks";

/**
 * NextAuth (v4) monta redirect_uri, cookies de estado e redirecionamentos a partir de `NEXTAUTH_URL`
 * (Production: `https://obaflixbr.com`), que tem precedência sobre o host do pedido. Em operadoras que bloqueiam esse
 * domínio o login Google nunca volta. Os três domínios oficiais já estão autorizados no Google Cloud
 * (`/api/auth/callback/google`), então, para um pedido que chegou por um deles, o NextAuth precisa usar o PRÓPRIO host
 * desse pedido.
 *
 * Nenhuma variável de ambiente é escrita. `scripts/patch-next-auth-origin.cjs` (postinstall/build) faz o
 * `detectOrigin` do next-auth consultar antes este AsyncLocalStorage: dentro do contexto de um pedido de domínio oficial
 * ele devolve a origem desse pedido; fora, o comportamento é o de sempre. Pedidos concorrentes têm contextos isolados.
 *
 * A origem NUNCA é copiada de um cabeçalho: o cabeçalho só escolhe UM de três hosts de uma lista fechada, e só é
 * considerado quando o servidor roda na Vercel (onde a plataforma define `x-forwarded-host`; o cliente não o controla).
 */
export const HOSTS_OFICIAIS: ReadonlySet<string> = new Set(["obaflix.vercel.app", "obaflixbr.com", "obaflix.online"]);

type ComHeaders = { headers: { get(name: string): string | null } };
type Manipulador<A extends unknown[]> = (...args: A) => Promise<Response>;

type Contexto = { origem: string };
const GLOBAL = globalThis as unknown as { __obaflixAuthOrigin?: AsyncLocalStorage<Contexto> };
// Uma única instância por processo, mesmo que o módulo seja carregado duas vezes (bundles diferentes).
const contexto: AsyncLocalStorage<Contexto> = (GLOBAL.__obaflixAuthOrigin ??= new AsyncLocalStorage<Contexto>());

export function hostOficialDoPedido(
  req: ComHeaders,
  confiarNoProxy: boolean = process.env.VERCEL === "1",
): string | null {
  if (!confiarNoProxy) return null;
  const bruto = (req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? "").split(",")[0].trim().toLowerCase();
  return HOSTS_OFICIAIS.has(bruto) ? bruto : null;
}

export function comHostOficial<A extends [ComHeaders, ...unknown[]]>(
  manipulador: Manipulador<A>,
  confiarNoProxy?: boolean,
): Manipulador<A> {
  return (...args: A) => {
    const host = hostOficialDoPedido(args[0], confiarNoProxy);
    if (!host) return manipulador(...args);
    return contexto.run({ origem: `https://${host}` }, () => manipulador(...args));
  };
}
