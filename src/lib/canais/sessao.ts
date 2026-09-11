/**
 * Sessão de reprodução de canal: o que o cliente recebe, e o que ele nunca vê.
 *
 * ## As duas metades
 *
 * **Privada (Redis).** Tudo que serve para buscar a mídia — canal, upstream
 * resolvido, página que arma o grant, dono da sessão. Nunca sai numa resposta.
 * Vive num id opaco e aleatório, com TTL curto.
 *
 * **Pública (URL assinada).** O id opaco, uma expiração e um HMAC. Não carrega
 * upstream, nem provider, nem host de CDN, nem userId, nem o nonce — nada que
 * se decifre. Um cliente que leia a própria URL aprende que existe uma sessão,
 * e só.
 *
 * ## Segredo próprio, e não o `NEXTAUTH_SECRET`
 *
 * A chave sai de `CANAIS_MEDIA_SIGNING_SECRET`, que existe para isto e para
 * mais nada. O mesmo valor vive no backend e no Worker.
 *
 * Reaproveitar o `NEXTAUTH_SECRET` juntava dois raios de impacto que não têm
 * por que se tocar: o Worker roda em infra de terceiro, com outra superfície de
 * deploy e outra lista de quem pode ler secrets, e um vazamento ali passaria a
 * comprometer a assinatura de sessão de autenticação do produto inteiro. Com
 * chave própria, o pior caso de um comprometimento do Worker é: emitir URL de
 * mídia válida. Ruim, e limitado.
 *
 * ## O handoff entre gerações
 *
 * Renovar rotaciona o nonce, e rotacionar o nonce derruba toda URL emitida
 * antes. Feito sem mais nada, isso mata a reprodução em curso: no instante da
 * renovação, o manifesto e os segmentos que o player está usando param de
 * conferir, e ele recebe 403 antes de ver a concessão nova.
 *
 * Por isso a sessão guarda **duas gerações**:
 *
 * | Campo | O que é |
 * |---|---|
 * | `nonce` | geração corrente; toda URL nova é assinada com ele |
 * | `noncePrevio` | geração anterior, aceita **só** enquanto `graceAte` não passou |
 * | `graceAte` | fim da janela de handoff (`GRACE_HANDOFF_S`) |
 *
 * O que isso compra, em ordem:
 *
 *   1. a renovação devolve uma `manifestUrl` nova, assinada com o nonce novo;
 *   2. o cliente migra o player para ela — de verdade, trocando a fonte, e não
 *      guardando a URL numa variável;
 *   3. enquanto ele migra, as URLs da geração anterior continuam valendo;
 *   4. passada a janela, a geração anterior morre.
 *
 * E uma propriedade que faz o handoff quase invisível: durante a grace, servir
 * a URL **antiga** de manifesto devolve segmentos assinados com o nonce
 * **novo**. O player continua tocando mesmo antes de trocar a fonte.
 *
 * **Apagar a sessão não tem grace.** `encerrarSessao` remove a chave, e as duas
 * gerações morrem no mesmo instante — é o caminho de logout, revogação e perda
 * de entitlement.
 *
 * ## Por que Redis, e não KV
 *
 * O estado aqui decide autorização. KV da Cloudflare é eventualmente
 * consistente: uma revogação levaria até um minuto para valer em todos os
 * pontos, e é exatamente nesse minuto que um replay funciona. Se algum dia for
 * preciso estado fortemente consistente *dentro* da Cloudflare, o caminho é
 * Durable Objects — não KV.
 *
 * ## As validades
 *
 * | | Quanto | Segura |
 * |---|---|---|
 * | `TTL_GRANT_S` | 5 min | URL de manifesto capturada morre rápido |
 * | `TTL_SEGMENTO_S` | 90 s | link de segmento não sobrevive ao instante em que foi útil |
 * | `GRACE_HANDOFF_S` | 60 s | janela em que as duas gerações convivem |
 * | `VIDA_MAXIMA_DA_SESSAO_S` | 2 h | força re-resolução, e com ela o provider volta a ser consultado |
 *
 * A renovação **não** re-resolve no provider: reaproveita o upstream da sessão.
 * Sem isso, um espectador de uma hora custaria doze buscas na página do player.
 */

import crypto from "crypto";
import { getRedis } from "../redis";
import { audit } from "../auditLog";
import {
  chaveDaBase,
  chaveDaSessao,
  materialAssinado,
  materialDaChave,
  materialDoIdDaBase,
  semanaDaChave,
  TAMANHO_DA_ASSINATURA,
  TAMANHO_DO_ID_DE_BASE,
  type RecursoAssinado,
} from "./assinatura";
import type { FonteDeCanalResolvida } from "./resolver";

// ── Parâmetros ───────────────────────────────────────────────────────────────

/** Validade da URL de manifesto entregue ao cliente. */
export const TTL_GRANT_S = 5 * 60;

/** Validade de cada URL de segmento cunhada dentro de um manifesto. */
export const TTL_SEGMENTO_S = 90;

/**
 * Janela em que a geração anterior ainda é aceita, após uma renovação.
 *
 * Precisa cobrir o tempo entre o servidor girar o nonce e o player estar
 * tocando pela concessão nova — incluindo os segmentos que ele já tinha na
 * fila. Um minuto é folga larga para os dois; mais do que isso só aumentaria a
 * janela em que uma URL capturada antes da renovação continua servindo.
 */
export const GRACE_HANDOFF_S = 60;

/**
 * TTL da sessão no Redis. Maior que o grant, para a renovação ter folga: o
 * cliente pede a próxima antes de a atual vencer, e a sessão precisa estar viva
 * nesse instante.
 */
export const TTL_SESSAO_S = 7 * 60;

/**
 * Teto absoluto de uma sessão, independente de quantas renovações houve.
 *
 * Existe porque a janela deslizante sozinha é imortal: quem continua pedindo
 * continua tendo. Passando daqui, `/play` resolve de novo no provider — o que
 * também pega o caso de o provider ter trocado a mídia do canal.
 */
export const VIDA_MAXIMA_DA_SESSAO_S = 2 * 3600;

/**
 * TTL do mapa id→base. Generoso porque o mapa é imutável e compartilhado: o id
 * deriva do valor, então reescrever é idempotente e perder uma entrada só custa
 * uma redescoberta.
 */
export const TTL_BASE_S = 6 * 3600;

// ── Chave e assinatura (o mesmo dos dois lados) ──────────────────────────────

function derivarChave(semanaN: number): Buffer {
  const secret = process.env.CANAIS_MEDIA_SIGNING_SECRET;
  if (!secret) throw new Error("CANAIS_MEDIA_SIGNING_SECRET não configurado");
  return crypto.createHash("sha256").update(materialDaChave(secret, semanaN)).digest();
}

function hmac(p: RecursoAssinado, semanaN: number): string {
  return crypto
    .createHmac("sha256", derivarChave(semanaN))
    .update(materialAssinado(p))
    .digest("base64url")
    .slice(0, TAMANHO_DA_ASSINATURA);
}

export function assinar(p: RecursoAssinado): string {
  return hmac(p, semanaDaChave(Date.now()));
}

function iguaisEmTempoConstante(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

/**
 * Confere contra a chave da semana corrente e a da anterior. Não existe aqui
 * atalho por `===`: comparar assinatura com igualdade de string vaza o prefixo
 * correto por tempo de resposta.
 */
export function assinaturaConfere(
  p: RecursoAssinado,
  sig: string,
  agoraMs: number = Date.now(),
): boolean {
  const w = semanaDaChave(agoraMs);
  for (const semanaN of [w, w - 1]) {
    if (iguaisEmTempoConstante(hmac(p, semanaN), sig)) return true;
  }
  return false;
}

/** Id determinístico e opaco de uma base upstream. Ver `assinatura.ts`. */
export function idDaBase(base: string): string {
  return crypto
    .createHmac("sha256", derivarChave(semanaDaChave(Date.now())))
    .update(materialDoIdDaBase(base))
    .digest("base64url")
    .slice(0, TAMANHO_DO_ID_DE_BASE);
}

// ── Estado privado da sessão ─────────────────────────────────────────────────

/**
 * O que vive no Redis. Nenhum campo daqui tem caminho para uma resposta HTTP.
 *
 * **As bases não moram mais aqui.** Elas têm chave própria
 * (`canal:base:<id>`), porque guardá-las neste documento fazia duas descobertas
 * concorrentes disputarem o mesmo `SET` — e o perdedor sumia, ou pior, um
 * índice passava a apontar para a base do outro. Com chave própria e id
 * determinístico, escrever é idempotente e independente.
 */
export interface SessaoDeCanal {
  canalId: string;
  /**
   * Sub opaco do dono, derivado por HMAC — não é o `userId` e não é reversível.
   *
   * **Quem confere é o backend, na renovação**, onde a requisição vem
   * autenticada: é o que impede alguém renovar a sessão de outra conta com um
   * `sessionId` capturado.
   *
   * O edge **não** confere, e não teria como: a requisição do player não carrega
   * credencial nossa. Quem protege lá é a assinatura presa ao nonce. Está dito
   * aqui para o campo não ser lido como uma garantia que ele não dá.
   */
  sub: string;
  /** URL de mídia resolvida. O cliente nunca a recebe. */
  upstream: string;
  /** Página que arma o grant do provider. O edge busca antes da mídia. */
  paginaDoPlayer: string;
  referer: string | null;
  userAgent: string | null;
  /** Geração corrente. Toda URL nova é assinada com este. */
  nonce: string;
  /** Geração anterior, aceita só até `graceAte`. `null` antes da 1ª renovação. */
  noncePrevio: string | null;
  /** Fim da janela de handoff, em ms. `0` quando não há geração anterior. */
  graceAte: number;
  criadaEm: number;
  /** Fim da janela deslizante. */
  expiraEm: number;
  /** Teto absoluto. Não se move em renovação nenhuma. */
  expiraDefinitivamenteEm: number;
}

export function derivarSub(userId: string): string {
  return crypto
    .createHmac("sha256", derivarChave(semanaDaChave(Date.now())))
    .update(`canal:sub:${userId}`)
    .digest("base64url")
    .slice(0, 16);
}

export interface Concessao {
  sessionId: string;
  exp: number;
  sig: string;
  /** Segundos até a URL vencer. O cliente renova antes disso. */
  validoPorSegundos: number;
}

function assinarMaster(sessionId: string, nonce: string, agoraMs: number): Concessao {
  const exp = Math.floor(agoraMs / 1000) + TTL_GRANT_S;
  return {
    sessionId,
    exp,
    sig: assinar({ escopo: "m", sessionId, nonce, recurso: "master", exp }),
    validoPorSegundos: TTL_GRANT_S,
  };
}

/**
 * Cria a sessão e devolve o que o cliente pode ver.
 *
 * O `sessionId` são 24 bytes de `randomBytes` — não deriva de userId, canalId
 * nem timestamp. Adivinhar um id não é um ataque viável, e ainda assim a
 * assinatura teria de bater.
 */
export async function criarSessaoDeCanal(entrada: {
  userId: string;
  canalId: string;
  fonte: FonteDeCanalResolvida;
}): Promise<Concessao> {
  const { userId, canalId, fonte } = entrada;
  const sessionId = crypto.randomBytes(24).toString("base64url");
  const agora = Date.now();
  const nonce = crypto.randomBytes(8).toString("base64url");

  const sessao: SessaoDeCanal = {
    canalId,
    sub: derivarSub(userId),
    upstream: fonte.streamUrl,
    paginaDoPlayer: fonte.paginaDoPlayer,
    referer: fonte.referer,
    userAgent: fonte.userAgent,
    nonce,
    noncePrevio: null,
    graceAte: 0,
    criadaEm: agora,
    expiraEm: agora + TTL_SESSAO_S * 1000,
    expiraDefinitivamenteEm: agora + VIDA_MAXIMA_DA_SESSAO_S * 1000,
  };

  await getRedis().set(chaveDaSessao(sessionId), JSON.stringify(sessao), { ex: TTL_SESSAO_S });

  audit("canal_sessao_criada", { userId, detail: `canal ${canalId}` });

  return assinarMaster(sessionId, nonce, agora);
}

/**
 * Renova uma concessão sem voltar ao provider, abrindo a janela de handoff.
 *
 * Devolve `null` — e quem chamou resolve do zero — quando a sessão sumiu, é de
 * outra conta, é de outro canal, ou passou do teto absoluto. Nenhum desses
 * casos é erro: são o caminho normal de volta para a resolução completa.
 *
 * O `sub` confere aqui, e só aqui, porque é o único ponto do fluxo em que se
 * sabe quem está pedindo.
 */
export async function renovarSessaoDeCanal(entrada: {
  userId: string;
  canalId: string;
  sessionId: string;
}): Promise<Concessao | null> {
  const { userId, canalId, sessionId } = entrada;
  const sessao = await lerSessao(sessionId);
  if (!sessao) return null;
  if (sessao.canalId !== canalId) return null;

  // Sem comparação em tempo constante de propósito: `sub` não é segredo, é
  // derivado de um id que o dono já conhece. O que ele impede é renovar a
  // sessão de outra conta com um `sessionId` capturado.
  if (sessao.sub !== derivarSub(userId)) return null;

  const agora = Date.now();
  if (agora >= sessao.expiraDefinitivamenteEm) return null;

  // Geração nova, e a anterior entra em grace. Sem a grace, as URLs que o
  // player está usando neste exato instante parariam de conferir.
  const nonce = crypto.randomBytes(8).toString("base64url");
  const renovada: SessaoDeCanal = {
    ...sessao,
    nonce,
    noncePrevio: sessao.nonce,
    graceAte: agora + GRACE_HANDOFF_S * 1000,
    expiraEm: agora + TTL_SESSAO_S * 1000,
  };

  await getRedis().set(chaveDaSessao(sessionId), JSON.stringify(renovada), { ex: TTL_SESSAO_S });

  return assinarMaster(sessionId, nonce, agora);
}

export async function lerSessao(sessionId: string): Promise<SessaoDeCanal | null> {
  const bruto = await getRedis().get(chaveDaSessao(sessionId));
  if (!bruto) return null;
  try {
    const s = JSON.parse(bruto) as SessaoDeCanal;
    if (typeof s.upstream !== "string" || typeof s.sub !== "string") return null;
    if (typeof s.nonce !== "string" || !s.nonce) return null;
    const agora = Date.now();
    if (s.expiraEm < agora) return null;
    if (typeof s.expiraDefinitivamenteEm !== "number" || s.expiraDefinitivamenteEm < agora) {
      return null;
    }
    return s;
  } catch {
    return null;
  }
}

/**
 * Encerra a sessão. Logout, revogação, troca de canal, entitlement perdido.
 *
 * **Sem grace.** Apagar a chave mata as duas gerações no mesmo instante: a
 * janela de handoff existe para a renovação, que é um evento nosso e esperado,
 * e não para a revogação, que é o oposto disso.
 */
export async function encerrarSessao(sessionId: string): Promise<void> {
  await getRedis().del(chaveDaSessao(sessionId));
}

/**
 * Persiste o mapa id→base. Idempotente: o id deriva do valor.
 *
 * Existe no backend para testes e para uma eventual pré-carga; em produção quem
 * grava é o edge, no momento em que reescreve o manifesto — e lá a gravação é
 * **obrigatória**, não best-effort. Ver `workers/media-proxy/src/canais.ts`.
 */
export async function registrarBase(base: string): Promise<string> {
  const id = idDaBase(base);
  await getRedis().set(chaveDaBase(id), base, { ex: TTL_BASE_S });
  return id;
}

export async function lerBase(id: string): Promise<string | null> {
  return getRedis().get(chaveDaBase(id));
}
