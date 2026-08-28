/**
 * Ponto único de autorização — navegador e TV.
 *
 * Motivo de existir: as rotas de reprodução e progresso resolvem a sessão com
 * `getServerSession(authOptions)`, que só enxerga cookie. O aplicativo de TV não
 * é um navegador: não tem armazenamento de cookie confiável em TV Box, e trazer
 * cookie para lá arrastaria junto CSRF, `SameSite` e `__Secure-` para um cliente
 * que não precisa de nada disso.
 *
 * A saída é usar o que o NextAuth já faz: `getToken` procura o cookie de sessão
 * e, se não achar, aceita `Authorization: Bearer <jwt>` — os dois decodificados
 * com o mesmo NEXTAUTH_SECRET. Ou seja, não existe um segundo caminho de
 * autorização para manter em sincronia; existe um só, com duas entradas.
 *
 * O que este módulo acrescenta por cima disso:
 *
 *  1. Fixa `secureCookie` no mesmo critério de `auth.ts`, para o nome do cookie
 *     bater em produção (`__Secure-next-auth.session-token`).
 *  2. Separa as duas entradas: um token de TV precisa ter sido emitido para TV.
 *     Um cookie de sessão do site copiado para o header `Authorization` é
 *     recusado — não vira credencial de dispositivo.
 *  3. Devolve o dispositivo de origem, que o pareamento (Fase 1) usa para
 *     revogar um aparelho sem derrubar os outros.
 */

import type { NextRequest } from "next/server";
import { getToken } from "next-auth/jwt";

/** Por onde a credencial chegou. */
export type OrigemSessao = "cookie" | "bearer";

export interface UsuarioRequisicao {
  userId: string;
  /**
   * Papel declarado no token.
   *
   * Serve para esconder o que é de admin, nunca para autorizar ação de admin:
   * o token é emitido no login e não acompanha uma mudança de papel no banco.
   * Quem decide acesso administrativo reconfirma no Postgres — é o que
   * `/api/player/fontes` já faz antes de devolver provider real e host.
   */
  role: string;
  origem: OrigemSessao;
  /** Aparelho que originou o token. Sempre null quando veio de cookie. */
  deviceId: string | null;
}

/** Mesmo critério de `auth.ts`, para o nome do cookie coincidir. */
const USA_COOKIE_SEGURO =
  process.env.NODE_ENV === "production" ||
  process.env.NEXTAUTH_URL?.startsWith("https://") === true;

const NOME_COOKIE = USA_COOKIE_SEGURO
  ? "__Secure-next-auth.session-token"
  : "next-auth.session-token";

/**
 * Claims que um token de TV carrega além das de sessão.
 *
 * `tv` é o que separa as duas entradas. Sem ele, qualquer cookie de sessão
 * roubado do navegador viraria credencial de dispositivo só por ser reenviado
 * no header `Authorization` — e aí revogar a TV não adiantaria nada, porque a
 * credencial não estaria presa a aparelho nenhum.
 */
export interface ClaimsTv {
  tv: true;
  /** Id do TvDevice. Existe para revogar um aparelho isoladamente. */
  did: string;
}

/**
 * Normaliza o token decodificado. Função pura — é o que os testes exercitam.
 *
 * `token` chega como o objeto que o NextAuth devolve; os campos vêm do callback
 * `jwt` em `auth.ts` (`id`, `role`) mais as claims de TV quando houver.
 */
export function normalizarToken(
  token: Record<string, unknown> | null,
  origem: OrigemSessao,
): UsuarioRequisicao | null {
  if (!token) return null;

  const userId = typeof token.id === "string" && token.id ? token.id : null;
  if (!userId) return null;

  const role = typeof token.role === "string" && token.role ? token.role : "user";

  if (origem === "cookie") {
    return { userId, role, origem, deviceId: null };
  }

  // Entrada Bearer: só aceita token emitido para TV, e com aparelho.
  if (token.tv !== true) return null;
  const deviceId = typeof token.did === "string" && token.did ? token.did : null;
  if (!deviceId) return null;

  return { userId, role, origem, deviceId };
}

/**
 * Resolve o usuário da requisição, venha por cookie (site, Electron, app móvel)
 * ou por Bearer (TV).
 *
 * Devolve null quando não há credencial válida — a rota decide o status. Nenhum
 * detalhe do motivo sai daqui: distinguir "token expirado" de "assinatura
 * inválida" na resposta entrega ao cliente um oráculo que ele não precisa ter.
 */
export async function getUserFromRequest(
  req: NextRequest,
): Promise<UsuarioRequisicao | null> {
  // O cookie tem precedência dentro do próprio getToken. Detectamos a origem
  // aqui para saber qual conjunto de regras aplicar na normalização.
  const temCookie = req.cookies.get(NOME_COOKIE)?.value !== undefined;
  const cabecalho = req.headers.get("authorization");
  const temBearer = cabecalho?.startsWith("Bearer ") === true;

  if (!temCookie && !temBearer) return null;

  const token = (await getToken({
    req: req as unknown as Parameters<typeof getToken>[0]["req"],
    secureCookie: USA_COOKIE_SEGURO,
    cookieName: NOME_COOKIE,
  })) as Record<string, unknown> | null;

  return normalizarToken(token, temCookie ? "cookie" : "bearer");
}
