/**
 * Pareamento de TV por QR Code.
 *
 * O problema: digitar e-mail e senha com controle remoto é ruim o bastante para
 * o usuário desistir. A saída é o celular autenticar em nome da TV.
 *
 * O princípio que organiza tudo aqui: **o QR Code não carrega segredo nenhum.**
 * Ele leva só o `userCode`, que é público e serve apenas para localizar o
 * pareamento. O segredo é o `deviceCode`, que nasce no servidor, vai direto para
 * a TV na resposta HTTP e nunca aparece na tela — ninguém fotografa o que não
 * está desenhado. Quem fotografa o QR de outra pessoa consegue, no máximo,
 * aprovar aquela TV para a *própria* conta, e a tela de aprovação diz qual
 * aparelho é, de onde e quando.
 *
 * Onde cada coisa vive:
 *
 *   Redis (TTL 10 min)  o pareamento em andamento. Some sozinho, não suja o
 *                       Postgres com tentativa abandonada — que é a maioria.
 *   Postgres            só o que precisa sobreviver: o aparelho e o refresh.
 *
 * Custo por pareamento típico está medido em `custoEstimado()`, no fim do
 * arquivo — o poll foi desenhado para caber em uma leitura de Redis por vez.
 */

import crypto from "crypto";
import { encode } from "next-auth/jwt";
import { getRedis } from "./redis";
import { prisma } from "./prisma";
import { audit } from "./auditLog";

// ── Parâmetros ───────────────────────────────────────────────────────────────

/** Vida do pareamento. Curta: é uma tela aberta, não uma sessão. */
export const PAREAMENTO_TTL_SEG = 10 * 60;

/** Access token curto — a TV renova sozinha com o refresh. */
const ACCESS_TTL_SEG = 15 * 60;

/** Refresh longo, mas rotativo e revogável a qualquer momento. */
const REFRESH_TTL_DIAS = 60;

/**
 * Alfabeto do código curto.
 *
 * Sem vogais, para nenhum código sortear uma palavra infeliz na tela de alguém.
 * Sem 0/O e 1/I/L, que são o que faz o usuário digitar errado e culpar o app.
 * Sobram 27 símbolos; 8 posições dão ~2,8 × 10¹¹ combinações, o que com o
 * limite de tentativas abaixo torna adivinhação inviável.
 */
const ALFABETO = "23456789BCDFGHJKMNPQRSTVWXZ";
const TAMANHO_CODIGO = 8;

// ── Chaves do Redis ──────────────────────────────────────────────────────────

const K = {
  /** O pareamento inteiro, indexado pelo código público. */
  par: (userCode: string) => `tv:pair:${userCode}`,
  /** Trava de aprovação: garante que só a primeira aprovação vale. */
  travaAprovar: (userCode: string) => `tv:pair:lock:${userCode}`,
  /** Trava de entrega: garante que o token sai uma vez só. */
  travaEntrega: (dch: string) => `tv:pair:claim:${dch}`,
  limiteInicio: (ip: string) => `tv:pair:rl:start:${ip}`,
  limiteAprovar: (userId: string) => `tv:pair:rl:approve:${userId}`,
  limiteCodigoErrado: (userId: string) => `tv:pair:rl:miss:${userId}`,
};

// ── Tipos ────────────────────────────────────────────────────────────────────

export type StatusPareamento = "pendente" | "aprovado" | "negado";

interface RegistroPareamento {
  /** SHA-256 do deviceCode. O segredo em si nunca é guardado. */
  dch: string;
  /** Hash da impressão do aparelho, do `start`. */
  fp: string;
  modelo: string;
  rede: string;
  criadoEm: number;
  status: StatusPareamento;
  /** Preenchido na aprovação. */
  userId?: string;
}

export interface Sessao {
  accessToken: string;
  refreshToken: string;
  expiraEmSeg: number;
  deviceId: string;
}

// ── Utilidades ───────────────────────────────────────────────────────────────

function sha256(v: string): string {
  return crypto.createHash("sha256").update(v).digest("hex");
}

function gerarCodigo(): string {
  let saida = "";
  for (let i = 0; i < TAMANHO_CODIGO; i++) {
    // randomInt é uniforme; `% ALFABETO.length` sobre randomBytes não seria,
    // e um alfabeto de 27 num byte de 256 enviesa de verdade.
    saida += ALFABETO[crypto.randomInt(ALFABETO.length)];
  }
  return saida;
}

/** Normaliza o que o usuário digitou: minúsculas, hífens e espaços não contam. */
export function normalizarCodigo(bruto: string): string {
  return bruto.toUpperCase().replace(/[^0-9A-Z]/g, "").slice(0, TAMANHO_CODIGO);
}

/** `ABCD-EFGH` — dois grupos são mais fáceis de ler em voz alta e de digitar. */
export function formatarCodigo(codigo: string): string {
  return `${codigo.slice(0, 4)}-${codigo.slice(4)}`;
}

/**
 * Reduz o IP a uma faixa. O usuário precisa reconhecer "é a minha casa", e para
 * isso o endereço inteiro é mais do que o necessário — guardar menos é a opção
 * certa quando as duas atendem.
 */
export function faixaDeRede(ip: string): string {
  if (ip.includes(":")) return ip.split(":").slice(0, 3).join(":") + "::";
  const partes = ip.split(".");
  return partes.length === 4 ? `${partes[0]}.${partes[1]}.${partes[2]}.x` : "desconhecida";
}

async function contar(chave: string, janelaSeg: number): Promise<number> {
  const redis = getRedis();
  const n = await redis.incr(chave);
  if (n === 1) await redis.expire(chave, janelaSeg);
  return n;
}

// ── 1. Início: a TV pede um pareamento ───────────────────────────────────────

export interface InicioPareamento {
  userCode: string;
  deviceCode: string;
  expiraEmSeg: number;
  intervaloSeg: number;
}

const LIMITE_INICIO_POR_HORA = 10;

export async function iniciarPareamento(args: {
  fingerprint: string;
  modelo: string;
  ip: string;
}): Promise<InicioPareamento | { erro: "rate_limited" }> {
  const tentativas = await contar(K.limiteInicio(sha256(args.ip).slice(0, 16)), 3600);
  if (tentativas > LIMITE_INICIO_POR_HORA) {
    audit("rate_limited", { ip: args.ip, detail: "tv/pair/start" });
    return { erro: "rate_limited" };
  }

  const userCode = gerarCodigo();
  const deviceCode = crypto.randomBytes(32).toString("base64url");

  const registro: RegistroPareamento = {
    dch: sha256(deviceCode),
    fp: args.fingerprint,
    modelo: args.modelo.slice(0, 60),
    rede: faixaDeRede(args.ip),
    criadoEm: Date.now(),
    status: "pendente",
  };

  await getRedis().set(K.par(userCode), JSON.stringify(registro), { ex: PAREAMENTO_TTL_SEG });

  // O deviceCode sai daqui uma única vez, na resposta para a TV. Não é logado.
  return {
    userCode,
    deviceCode,
    expiraEmSeg: PAREAMENTO_TTL_SEG,
    intervaloSeg: 3,
  };
}

// ── 2. Consulta: o celular quer saber que aparelho é esse ────────────────────

export interface AparelhoPendente {
  modelo: string;
  rede: string;
  criadoEm: number;
}

export async function descreverPareamento(userCode: string): Promise<AparelhoPendente | null> {
  const bruto = await getRedis().get(K.par(userCode));
  if (!bruto) return null;
  const r = JSON.parse(bruto) as RegistroPareamento;
  if (r.status !== "pendente") return null;
  return { modelo: r.modelo, rede: r.rede, criadoEm: r.criadoEm };
}

// ── 3. Aprovação: o celular autoriza, já autenticado ─────────────────────────

const LIMITE_APROVAR_POR_HORA = 12;
const LIMITE_CODIGO_ERRADO = 5;

export type ResultadoAprovacao =
  | { ok: true }
  | { ok: false; motivo: "expirado" | "ja_usado" | "rate_limited" | "bloqueado" };

export async function aprovarPareamento(
  userCode: string,
  userId: string,
): Promise<ResultadoAprovacao> {
  const redis = getRedis();

  if ((await contar(K.limiteAprovar(userId), 3600)) > LIMITE_APROVAR_POR_HORA) {
    audit("rate_limited", { userId, detail: "tv/pair/approve" });
    return { ok: false, motivo: "rate_limited" };
  }

  const bruto = await redis.get(K.par(userCode));
  if (!bruto) {
    // Código inexistente conta como tentativa de adivinhação. É este limite,
    // e não o tamanho do alfabeto sozinho, que fecha a força bruta.
    const erradas = await contar(K.limiteCodigoErrado(userId), 15 * 60);
    if (erradas > LIMITE_CODIGO_ERRADO) {
      audit("rate_limited", { userId, detail: "tv/pair: códigos inválidos" });
      return { ok: false, motivo: "bloqueado" };
    }
    return { ok: false, motivo: "expirado" };
  }

  // Uso único da aprovação: quem chegar depois encontra a trava posta.
  const primeira = await redis.set(K.travaAprovar(userCode), "1", {
    ex: PAREAMENTO_TTL_SEG,
    nx: true,
  });
  if (primeira !== "OK") return { ok: false, motivo: "ja_usado" };

  const r = JSON.parse(bruto) as RegistroPareamento;
  r.status = "aprovado";
  r.userId = userId;

  const restante = await redis.ttl(K.par(userCode));
  await redis.set(K.par(userCode), JSON.stringify(r), {
    ex: restante > 0 ? restante : PAREAMENTO_TTL_SEG,
  });

  audit("tv_paired", { userId, detail: "aprovado no celular" });
  return { ok: true };
}

// ── 4. Poll: a TV pergunta se já foi aprovada ────────────────────────────────

export type ResultadoPoll =
  | { estado: "pendente" }
  | { estado: "aprovado"; sessao: Sessao }
  | { estado: "expirado" }
  | { estado: "negado" };

/**
 * A TV manda os dois: o `userCode` (que ela exibe) localiza, o `deviceCode`
 * (que só ela tem) prova. Mandar os dois é o que deixa o poll em **uma** leitura
 * de Redis em vez de duas — e o poll é a operação que mais se repete no fluxo.
 */
export async function consultarPareamento(args: {
  userCode: string;
  deviceCode: string;
  fingerprint: string;
  ip: string;
  userAgent: string;
}): Promise<ResultadoPoll> {
  const redis = getRedis();
  const bruto = await redis.get(K.par(args.userCode));
  if (!bruto) return { estado: "expirado" };

  const r = JSON.parse(bruto) as RegistroPareamento;

  // Prova de posse. Comparação de tempo constante: o dch tem tamanho fixo, e
  // um vazamento por tempo aqui entregaria o segredo do pareamento.
  const esperado = Buffer.from(r.dch);
  const recebido = Buffer.from(sha256(args.deviceCode));
  if (esperado.length !== recebido.length || !crypto.timingSafeEqual(esperado, recebido)) {
    return { estado: "expirado" };
  }

  // O aparelho tem de ser o mesmo que começou. Sem isto, quem interceptasse o
  // deviceCode poderia resgatar a sessão de outro aparelho.
  if (r.fp !== args.fingerprint) return { estado: "expirado" };

  if (r.status === "negado") return { estado: "negado" };
  if (r.status !== "aprovado" || !r.userId) return { estado: "pendente" };

  // Entrega única: dois polls simultâneos não podem virar duas sessões.
  const ganhou = await redis.set(K.travaEntrega(r.dch), "1", {
    ex: PAREAMENTO_TTL_SEG,
    nx: true,
  });
  if (ganhou !== "OK") return { estado: "expirado" };

  let sessao: Sessao;
  try {
    sessao = await emitirSessao({
      userId: r.userId,
      fingerprint: r.fp,
      modelo: r.modelo,
      rede: r.rede,
      userAgent: args.userAgent,
    });
  } catch (erro) {
    // Devolve a trava: sem isto, uma falha passageira do Postgres deixaria a TV
    // presa em "expirado" para sempre, com o pareamento ainda aprovado no Redis.
    await redis.del(K.travaEntrega(r.dch));
    throw erro;
  }

  // O pareamento cumpriu seu papel; nada nele precisa sobreviver.
  await redis.del(K.par(args.userCode));

  audit("tv_paired", { userId: r.userId, ip: args.ip, detail: "sessao entregue a TV" });
  return { estado: "aprovado", sessao };
}

// ── 5. Emissão e rotação de sessão ───────────────────────────────────────────

async function emitirAccessToken(userId: string, role: string, deviceId: string): Promise<string> {
  const segredo = process.env.NEXTAUTH_SECRET;
  if (!segredo) throw new Error("NEXTAUTH_SECRET não configurado");
  // Mesmo formato e mesmo segredo da sessão do site: é o que permite existir um
  // só ponto de autorização no servidor. As claims `tv` e `did` são o que separa
  // as duas entradas — ver authSession.ts.
  return encode({ token: { id: userId, role, tv: true, did: deviceId }, secret: segredo, maxAge: ACCESS_TTL_SEG });
}

async function emitirSessao(args: {
  userId: string;
  fingerprint: string;
  modelo: string;
  rede: string;
  userAgent: string;
  familia?: string;
}): Promise<Sessao> {
  const nome = args.modelo ? `Obaflix TV · ${args.modelo}` : "Obaflix TV";

  const dispositivo = await prisma.tvDevice.upsert({
    where: { userId_fingerprint: { userId: args.userId, fingerprint: args.fingerprint } },
    create: {
      userId: args.userId,
      nome,
      modelo: args.modelo || null,
      fingerprint: args.fingerprint,
      ultimaRede: args.rede,
    },
    update: { ultimoUso: new Date(), ultimaRede: args.rede, revogadoEm: null, nome },
    select: { id: true, user: { select: { role: true } } },
  });

  const refreshToken = crypto.randomBytes(32).toString("base64url");
  await prisma.tvRefreshToken.create({
    data: {
      tokenHash: sha256(refreshToken),
      deviceId: dispositivo.id,
      familia: args.familia ?? crypto.randomUUID(),
      expiraEm: new Date(Date.now() + REFRESH_TTL_DIAS * 24 * 3600 * 1000),
    },
  });

  return {
    accessToken: await emitirAccessToken(args.userId, dispositivo.user.role, dispositivo.id),
    refreshToken,
    expiraEmSeg: ACCESS_TTL_SEG,
    deviceId: dispositivo.id,
  };
}

export type ResultadoRenovacao =
  | { ok: true; sessao: Sessao }
  | { ok: false; motivo: "invalido" | "expirado" | "revogado" | "reuso" };

/**
 * Troca o refresh por um par novo.
 *
 * Rotação com detecção de reuso: o token antigo morre no ato. Se um token já
 * usado voltar, existem duas cópias em circulação e não há como saber qual é a
 * do dono — então a família inteira cai e a TV precisa parear de novo. É
 * incômodo exatamente na medida em que é raro.
 */
export async function renovarSessao(args: {
  refreshToken: string;
  fingerprint: string;
  rede: string;
  userAgent: string;
}): Promise<ResultadoRenovacao> {
  const registro = await prisma.tvRefreshToken.findUnique({
    where: { tokenHash: sha256(args.refreshToken) },
    include: { device: true },
  });

  if (!registro) return { ok: false, motivo: "invalido" };

  if (registro.usadoEm) {
    await prisma.tvRefreshToken.updateMany({
      where: { familia: registro.familia, revogadoEm: null },
      data: { revogadoEm: new Date() },
    });
    audit("stream_rejected", {
      userId: registro.device.userId,
      detail: "tv refresh reutilizado — família revogada",
    });
    return { ok: false, motivo: "reuso" };
  }

  if (registro.revogadoEm || registro.device.revogadoEm) return { ok: false, motivo: "revogado" };
  if (registro.expiraEm.getTime() < Date.now()) return { ok: false, motivo: "expirado" };

  // O aparelho tem de continuar sendo o mesmo.
  if (registro.device.fingerprint !== args.fingerprint) {
    return { ok: false, motivo: "invalido" };
  }

  await prisma.tvRefreshToken.update({
    where: { id: registro.id },
    data: { usadoEm: new Date() },
  });

  const sessao = await emitirSessao({
    userId: registro.device.userId,
    fingerprint: registro.device.fingerprint,
    modelo: registro.device.modelo ?? "",
    rede: args.rede,
    userAgent: args.userAgent,
    familia: registro.familia,
  });

  return { ok: true, sessao };
}

// ── 6. Revogação ─────────────────────────────────────────────────────────────

/** Sair nesta TV. O access token sobrevive no máximo 15 min; o refresh, não. */
export async function revogarDispositivo(userId: string, deviceId: string): Promise<boolean> {
  const dispositivo = await prisma.tvDevice.findFirst({
    where: { id: deviceId, userId },
    select: { id: true },
  });
  if (!dispositivo) return false;

  const agora = new Date();
  await prisma.$transaction([
    prisma.tvRefreshToken.updateMany({
      where: { deviceId: dispositivo.id, revogadoEm: null },
      data: { revogadoEm: agora },
    }),
    prisma.tvDevice.update({ where: { id: dispositivo.id }, data: { revogadoEm: agora } }),
  ]);

  audit("tv_device_revoked", { userId, detail: "sessao encerrada no aparelho" });
  return true;
}

export async function listarDispositivos(userId: string) {
  return prisma.tvDevice.findMany({
    where: { userId, revogadoEm: null },
    orderBy: { ultimoUso: "desc" },
    select: { id: true, nome: true, ultimoUso: true, ultimaRede: true, criadoEm: true },
  });
}

// ── Custo ────────────────────────────────────────────────────────────────────

/**
 * Comandos de Redis num pareamento típico — usuário pega o celular e aprova em
 * torno de 40 s, com poll adaptativo de 3 s no primeiro minuto.
 *
 *   start     2  (incr + set; o expire só ocorre na primeira do IP na hora)
 *   poll     ~13 (1 get cada, ~13 polls em 40 s)
 *   approve   5  (incr + get + set nx + set + ttl)
 *   entrega   3  (set nx + 2 del)  — o poll que recebe a sessão
 *   auditoria 4  (audit() incrementa um contador por evento: 2 eventos × 2)
 *   ──────────
 *   total    ~27 comandos, e nenhuma escrita no Postgres antes da aprovação.
 *
 * O poll ficou em uma leitura porque a TV manda userCode e deviceCode juntos:
 * o primeiro localiza, o segundo prova. Um índice separado por deviceCode
 * dobraria esse número sem acrescentar segurança.
 */
export function custoEstimado() {
  return { redisPorPareamento: 27, postgresEscritasAntesDaAprovacao: 0 };
}
