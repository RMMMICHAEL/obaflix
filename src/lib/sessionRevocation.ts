/**
 * Revogação imediata de sessão por conta — o fecho do gap do JWT stateless.
 *
 * ## O problema
 *
 * A sessão do Obaflix é um JWT sem estado: `getUserFromRequest` e
 * `getServerSession` só **decodificam** a credencial, sem provar que a linha
 * `User` ainda existe. Um cookie de 30 dias (`SESSION_MAX_AGE`) ou um Bearer de
 * TV emitido ANTES da exclusão continuaria "autenticando" DEPOIS dela — e, com a
 * monetização desligada, `/api/playback/authorize` devolveria `PERMITIDO` sem
 * tocar no banco. Esperar o token expirar sozinho não é revogação.
 *
 * ## O modelo (temporal, por `iat`, sem PII)
 *
 * Em vez de guardar o token (cookie, e-mail ou qualquer PII), guarda-se um único
 * **cutoff**: o instante da revogação, em segundos. A chave contém só o `userId`
 * interno; o valor é só o timestamp.
 *
 *   - Toda credencial que o NextAuth emite carrega `iat` (verificado: tanto o
 *     cookie de sessão quanto o Bearer de TV o trazem).
 *   - Uma credencial com `iat <= cutoff` está revogada.
 *   - Uma credencial com `iat > cutoff` continua válida: é o login novo. Importa
 *     caso a transação de exclusão falhe DEPOIS de o cutoff ser gravado — a conta
 *     ainda existe e o usuário precisa poder entrar de novo sem esperar 30 dias.
 *
 * ## TTL — por que 31 dias
 *
 * O marcador só precisa viver enquanto algum token antigo daquela conta puder
 * sobreviver. Auditadas as duas vidas:
 *   - cookie de sessão (navegador / Electron / app móvel): `SESSION_MAX_AGE`,
 *     30 dias — a mais longa;
 *   - Bearer de TV: `ACCESS_TTL_SEG` em `tvPairing.ts`, 15 minutos — muito menor
 *     (o refresh de 60 dias é linha de banco, apagada na transação de exclusão,
 *     não um JWT que decodifique sozinho).
 * Logo o teto é 30 dias; somamos 1 dia de margem (clock skew entre instâncias
 * serverless e folga de processamento). `sessionRevocation.test.ts` trava que o
 * TTL nunca fica abaixo de `SESSION_MAX_AGE`.
 *
 * ## Fail-closed
 *
 * Em produção o Redis é infraestrutura obrigatória (ver `redis.ts`). Se a
 * consulta de revogação não puder CONFIRMAR que um token não foi revogado, o
 * caminho protegido recusa — nunca autoriza. Por isso `credencialRevogada` trata
 * erro de Redis, marcador corrompido e token sem `iat` confiável todos como
 * "revogado". Não há fallback local.
 */

import { getRedis, type RedisClient } from "@/lib/redis";

/** Teto do cookie de sessão. Mesmo valor de `SESSION_MAX_AGE` em `auth.ts`. */
const SESSION_MAX_AGE_SEG = 30 * 24 * 60 * 60;
/** Margem para clock skew entre instâncias e folga de processamento. */
const MARGEM_SEG = 24 * 60 * 60;

/** TTL finito do marcador: teto do token mais longevo + margem. */
export const REVOGACAO_TTL_SEG = SESSION_MAX_AGE_SEG + MARGEM_SEG;

/** Chave só com o id interno — nunca cookie, e-mail ou outra PII. */
export const chaveRevogacao = (userId: string): string => `session:revoked:${userId}`;

/**
 * Grava o cutoff de revogação da conta.
 *
 * Usada ANTES da transação destrutiva: se não persistir, a rota responde 503 e
 * NÃO apaga a conta. Por isso **lança** quando o Redis não confirma o `SET` —
 * deixar passar reabriria a janela que esta função existe para fechar.
 */
export async function revogarSessoesDoUsuario(
  userId: string,
  agoraSeg: number = Math.floor(Date.now() / 1000),
  redis?: Pick<RedisClient, "set">,
): Promise<void> {
  const client = redis ?? getRedis();
  const ok = await client.set(chaveRevogacao(userId), String(agoraSeg), { ex: REVOGACAO_TTL_SEG });
  if (ok !== "OK") throw new Error("revogacao_nao_persistida");
}

/**
 * `true` quando a credencial está revogada OU quando não foi possível confirmar
 * que ela não está (fail-closed). **Nunca lança**: erro de Redis vira revogado,
 * para o chamador poder apenas negar a sessão sem precisar tratar exceção.
 *
 * `iat` chega como vier do token decodificado (`unknown`): na ausência de
 * marcador é ignorado; com marcador presente, precisa ser um número finito e
 * posterior ao cutoff, senão a credencial é recusada.
 */
export async function credencialRevogada(
  userId: string,
  iat: unknown,
  redis?: Pick<RedisClient, "get">,
): Promise<boolean> {
  let cutoffRaw: string | null;
  try {
    const client = redis ?? getRedis();
    cutoffRaw = await client.get(chaveRevogacao(userId));
  } catch {
    return true; // Redis indisponível nunca autoriza.
  }
  if (cutoffRaw === null) return false; // Sem marcador: credencial legítima segue válida.
  const cutoff = Number(cutoffRaw);
  if (!Number.isFinite(cutoff)) return true; // Marcador corrompido: fecha.
  if (typeof iat !== "number" || !Number.isFinite(iat)) return true; // Sem iat confiável: fecha.
  return iat <= cutoff;
}
