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
 * ## O modelo (temporal, por `authTime`, sem PII)
 *
 * Em vez de guardar o token (cookie, e-mail ou qualquer PII), guarda-se um único
 * **cutoff**: um instante em segundos. A chave contém só o `userId` interno; o
 * valor é só o timestamp.
 *
 *   - A âncora é a claim própria **`authTime`**: o instante da autenticação REAL
 *     que originou a sessão. É IMUTÁVEL — gravada só quando um login de verdade
 *     cria a sessão (Credentials/Google) ou quando a TV emite um access token a
 *     partir do refresh, e PRESERVADA em todo re-encode.
 *   - Uma credencial com `authTime <= cutoff` está revogada.
 *   - Uma credencial com `authTime > cutoff` continua válida.
 *
 *   NÃO se usa `iat`: o NextAuth faz *rolling session* — a cada `GET
 *   /api/auth/session` ele decodifica o cookie, roda os callbacks e RE-ENCODA o
 *   token (`core/routes/session.ts` → `jwt.encode` → `jose.setIssuedAt()`), o que
 *   reescreve `iat` (e `exp`/`jti`) para agora. Ancorar em `iat` deixaria um
 *   cookie revogado "lavar" o próprio `iat` para depois do cutoff só por passar
 *   pelo endpoint de sessão, voltando a autenticar. `authTime` é uma claim nossa
 *   que o encoder padrão não toca, então sobrevive intacta aos re-encodes.
 *
 * ## A corrida — e por que o cutoff aponta para o FUTURO
 *
 * A exclusão grava o cutoff e só então roda a transação destrutiva, que leva
 * tempo (`maxDuration = 30 s`). Enquanto a conta e seus `TvRefreshToken` ainda
 * existem, uma requisição concorrente pode AUTENTICAR DE NOVO (Credentials/Google
 * login) ou RENOVAR a sessão da TV (`POST /api/tv/session` → `renovarSessao`) e
 * receber um JWT com `iat` já POSTERIOR ao instante em que o cutoff foi gravado.
 * Se o cutoff fosse "agora", esse token teria `iat > cutoff` e sobreviveria à
 * exclusão — autenticando uma conta que não existe mais.
 *
 * O fecho é gravar o cutoff ADIANTADO: `agora + JANELA_CORRIDA_SEG`, uma janela
 * que cobre com folga toda a duração possível da operação + clock skew. Assim
 * QUALQUER token emitido durante a exclusão também cai em `iat <= cutoff` e é
 * recusado. Não há segundo `SET` após o `User.delete` (um erro de Redis ali
 * deixaria a conta apagada com token concorrente vivo); há um só `SET`, antes de
 * tudo, e ele já cobre a janela inteira.
 *
 * Se a transação FALHAR e o `User` permanecer, nada de Redis precisa ser
 * desfeito: o cutoff é temporal, então assim que o relógio ultrapassa a janela um
 * login novo emite `iat > cutoff` e volta a valer. A espera máxima é
 * `JANELA_CORRIDA_SEG` — curta e explicitamente limitada —, nunca os 31 dias do
 * marcador.
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

// ── Janela da corrida ──────────────────────────────────────────────────────────
//
// O cutoff é gravado ADIANTADO em `agora + JANELA_CORRIDA_SEG` para cobrir todo
// token que uma requisição concorrente possa emitir ENQUANTO a transação de
// exclusão ainda não terminou. A janela é derivada, não arbitrária:

/**
 * Teto de duração da rota de exclusão: `export const maxDuration = 30` em
 * `src/app/api/user/account/route.ts`. A função serverless é encerrada aí, então
 * a transação comita, no mais tardar, `maxDuration` após o cutoff ser gravado —
 * depois disso nenhuma autenticação concorrente consegue mais ler `User`.
 */
const MAX_DURACAO_EXCLUSAO_SEG = 30;

/**
 * Folga sobre a janela de exclusão. Cobre, somados: clock skew bidirecional entre
 * instâncias serverless (o relógio que carimba o `iat` do token concorrente pode
 * adiantar-se ao relógio que grava o cutoff), o arredondamento do `iat` para
 * segundos e a latência entre a leitura do `User`/refresh e o carimbo do `iat`.
 * 15 s é folgado para instâncias sincronizadas por NTP (desvio típico < 1 s).
 */
const MARGEM_SKEW_SEG = 15;

/**
 * Janela da corrida: nenhum JWT emitido durante a exclusão escapa a `iat <= cutoff`,
 * e é o teto da espera para reautenticar caso a exclusão falhe. 30 + 15 = 45 s.
 */
export const JANELA_CORRIDA_SEG = MAX_DURACAO_EXCLUSAO_SEG + MARGEM_SKEW_SEG;

/** Chave só com o id interno — nunca cookie, e-mail ou outra PII. */
export const chaveRevogacao = (userId: string): string => `session:revoked:${userId}`;

/**
 * Carimbo de uma autenticação REAL, em segundos. Gravado na claim imutável
 * `authTime` no login (Credentials/Google) e na emissão do access token de TV;
 * NUNCA atualizado num re-encode de rolling. É a âncora que `credencialRevogada`
 * compara com o cutoff.
 */
export const carimboAutenticacaoSeg = (): number => Math.floor(Date.now() / 1000);

/**
 * Grava o cutoff de revogação da conta, ADIANTADO em `JANELA_CORRIDA_SEG` para
 * fechar a corrida com a emissão concorrente de credenciais (ver cabeçalho).
 *
 * Usada ANTES da transação destrutiva: se não persistir, a rota responde 503 e
 * NÃO apaga a conta. Por isso **lança** quando o Redis não confirma o `SET` —
 * deixar passar reabriria a janela que esta função existe para fechar.
 *
 * `agoraSeg` é o "agora" de referência (injetável nos testes); o cutoff gravado é
 * `agoraSeg + JANELA_CORRIDA_SEG`.
 */
export async function revogarSessoesDoUsuario(
  userId: string,
  agoraSeg: number = Math.floor(Date.now() / 1000),
  redis?: Pick<RedisClient, "set">,
): Promise<void> {
  const cutoff = agoraSeg + JANELA_CORRIDA_SEG;
  const client = redis ?? getRedis();
  const ok = await client.set(chaveRevogacao(userId), String(cutoff), { ex: REVOGACAO_TTL_SEG });
  if (ok !== "OK") throw new Error("revogacao_nao_persistida");
}

/**
 * `true` quando a credencial está revogada OU quando não foi possível confirmar
 * que ela não está (fail-closed). **Nunca lança**: erro de Redis vira revogado,
 * para o chamador poder apenas negar a sessão sem precisar tratar exceção.
 *
 * `authTime` é a claim imutável de nascimento da sessão, como vier do token
 * decodificado (`unknown`):
 *   - SEM marcador de revogação: a credencial é legítima e segue válida, mesmo
 *     que `authTime` esteja ausente — é o token legado anterior a este deploy,
 *     que não deve ser expulso sem motivo.
 *   - COM marcador: `authTime` precisa ser um número finito e posterior ao
 *     cutoff; ausente, inválido ou `<= cutoff` → recusa (fail-closed). Assim um
 *     token legado (sem a claim) de uma conta que pediu exclusão não passa.
 */
export async function credencialRevogada(
  userId: string,
  authTime: unknown,
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
  if (typeof authTime !== "number" || !Number.isFinite(authTime)) return true; // Sem claim confiável: fecha.
  return authTime <= cutoff;
}
