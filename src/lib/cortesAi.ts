/**
 * Cortes AI: o Gemini sugere cortes a partir só do TEXTO da legenda (SRT/VTT),
 * guiado pelo pedido do usuário. Sem vídeo, sem áudio. Portado do experimento
 * isolado (teste-legendas.mjs), que validou o pedido e a validação abaixo.
 *
 * Tudo atrás de configuração do servidor, desligado por padrão:
 *   CORTES_AI_ATIVO=1, GEMINI_API_KEY, CORTES_AI_LEGENDAS_AUTORIZADAS
 *   ("conteudoId:sha256" separados por vírgula — a impressão de cada legenda
 *   própria ou licenciada), CORTES_AI_LIMITE_DIA e CORTES_AI_TETO_USD_MES.
 * A chave só existe no servidor; nunca vai ao cliente nem a log.
 */

import { createHash, randomUUID } from "node:crypto";
import type { RedisClient } from "./redis";

export const MODELO_CORTES_AI = "gemini-3.5-flash-lite";
export const MAX_CORTES = 5;
/** Falas citadas pela IA: o corte final ganha contexto em volta (comContexto). */
const CORTE_MIN_S = 1, CORTE_MAX_S = 90;
/** Duração do corte entregue ao editor, já com o contexto antes e depois das falas. */
export const DURACAO_CORTE = { min: 20, max: 90 };
/** Respiro antes da primeira e depois da última fala citada. */
const CONTEXTO_S = 3;
/** Folga entre o horário devolvido e o da fala citada (arredondamento). */
const FOLGA_S = 1.5;
export const LIMITES_CORTES_AI = { legendaBytes: 600 * 1024, falasMin: 5, falasMax: 4000, temaMin: 3, temaMax: 1000 };

export interface Fala { id: number; inicio: number; fim: number; texto: string }
export interface CorteSugerido {
  inicio_segundos: number;
  fim_segundos: number;
  falas: number[];
  titulo_sugerido: string;
  o_que_e_dito?: string;
  motivo?: string;
  confianca?: string;
}

// ── Configuração ─────────────────────────────────────────────────────────────

export function configCortesAi(env: Record<string, string | undefined> = process.env) {
  const limite = Number(env.CORTES_AI_LIMITE_DIA);
  return {
    ativo: env.CORTES_AI_ATIVO === "1" && !!env.GEMINI_API_KEY,
    chave: env.GEMINI_API_KEY ?? "",
    legendas: new Map((env.CORTES_AI_LEGENDAS_AUTORIZADAS ?? "").split(",")
      .map((par) => par.trim().split(":").map((s) => s.trim()))
      .filter(([id, hash]) => id && /^[0-9a-f]{64}$/.test(hash ?? ""))
      .map(([id, hash]) => [id, hash] as const)),
    limiteDia: Number.isInteger(limite) && limite > 0 ? limite : 5,
    tetoMicroUsdMes: Math.round((Number(env.CORTES_AI_TETO_USD_MES) > 0 ? Number(env.CORTES_AI_TETO_USD_MES) : 1) * 1_000_000),
  };
}

// ── Custo ────────────────────────────────────────────────────────────────────

/**
 * Preço do gemini-3.5-flash-lite na camada paga padrão (ai.google.dev/gemini-api/docs/pricing,
 * 2026-10): US$ por 1M tokens, que é o mesmo que micro-US$ por token. Mudou o
 * modelo ou a tabela do Google, mude aqui.
 */
const PRECO_MICRO_USD = { entrada: 0.3, saida: 2.5 };
type Tokens = { entrada: number; saida: number };
export const custoMicroUsd = (t: Tokens) =>
  Math.ceil(t.entrada * PRECO_MICRO_USD.entrada + t.saida * PRECO_MICRO_USD.saida);

/** Gasto de cada usuário por mês (UTC), em micro-US$; a chave expira sozinha depois do mês. */
const chaveGasto = (userId: string, agora: Date) => `cortesai:gasto:${userId}:${agora.toISOString().slice(0, 7)}`;

export async function gastoDoMes(redis: RedisClient, userId: string, agora = new Date()): Promise<number> {
  const raw = await redis.get(chaveGasto(userId, agora));
  const valor = raw === null ? 0 : Number(raw || NaN);
  if (!Number.isSafeInteger(valor) || valor < 0) throw new Error("Orçamento inválido");
  return valor;
}

const TTL_ORCAMENTO = 35 * 24 * 3600;
export interface ReservaGasto { chave: string; reserva: string; valor: number }

export async function reservarGasto(redis: RedisClient, userId: string, valor: number, teto: number, agora = new Date()): Promise<ReservaGasto | null> {
  const chave = chaveGasto(userId, agora);
  // O hash tag mantém a reserva no mesmo slot do contador legado, inclusive no Redis Cluster.
  const reserva = `cortesai:reserva:{${chave}}:${randomUUID()}`;
  return await redis.reserveBudget(chave, reserva, valor, teto, TTL_ORCAMENTO) ? { chave, reserva, valor } : null;
}

export async function liquidarGasto(redis: RedisClient, reserva: ReservaGasto, valor: number): Promise<void> {
  if (!await redis.settleBudget(reserva.chave, reserva.reserva, valor, TTL_ORCAMENTO)) throw new Error("Reserva indisponível");
}

// ── Legenda ──────────────────────────────────────────────────────────────────

/**
 * Impressão da legenda: SHA-256 do texto sem BOM e com quebras de linha
 * normalizadas (o player lê com fetch().text(), que já remove o BOM). O
 * servidor só aceita o texto cuja impressão bate com a legenda autorizada
 * daquele conteúdo — o cliente não consegue trocar o texto de um título liberado.
 */
export function impressaoDaLegenda(texto: string): string {
  return createHash("sha256").update(texto.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").trimEnd(), "utf8").digest("hex");
}

const RE_TEMPO = /(?:(\d{1,2}):)?(\d{1,2}):(\d{2})[.,](\d{1,3})/;
function segundos(t: string): number {
  const m = RE_TEMPO.exec(t);
  if (!m) return NaN;
  return Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4].padEnd(3, "0")) / 1000;
}
/** Texto limpo: sem tags HTML/VTT, sem comandos de posição do SRT ({\an8}). */
const limparTexto = (t: string) => t.replace(/<[^>]+>/g, "").replace(/\{\\[^}]*\}/g, "")
  .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/\s+/g, " ").trim();

/** Falas de um SRT ou VTT: { id, inicio, fim, texto }, em ordem, sem vazias. */
export function lerLegenda(conteudo: string): Fala[] {
  const linhas = conteudo.replace(/^\uFEFF/, "").replace(/\r/g, "").split("\n");
  const falas: Fala[] = [];
  for (let i = 0; i < linhas.length; i++) {
    if (!linhas[i].includes("-->")) continue;
    const [a, b] = linhas[i].split("-->");
    const inicio = segundos(a), fim = segundos(b);
    const texto: string[] = [];
    for (i++; i < linhas.length && linhas[i].trim() !== ""; i++) texto.push(linhas[i]);
    const limpo = limparTexto(texto.join(" "));
    if (Number.isFinite(inicio) && Number.isFinite(fim) && fim > inicio && limpo) falas.push({ id: falas.length + 1, inicio, fim, texto: limpo });
  }
  return falas;
}

/**
 * Confere um corte contra as falas: horários numéricos, dentro da legenda, duração
 * plausível, falas citadas existentes e horários batendo com elas. Um corte sem
 * fala que o sustente é rejeitado (a IA não pode inventar cena que o texto não mostra).
 */
export function validarCorte(c: Partial<CorteSugerido>, falas: Fala[], duracaoVideo?: number): string[] {
  const p: string[] = [];
  const fimLegenda = falas.at(-1)?.fim ?? 0;
  const ini = c.inicio_segundos, fim = c.fim_segundos;
  if (typeof ini !== "number" || typeof fim !== "number" || !Number.isFinite(ini) || !Number.isFinite(fim)) return ["horário ausente ou não numérico"];
  if (ini < 0 || fim > fimLegenda + FOLGA_S) p.push("fora da legenda");
  if (duracaoVideo && fim > duracaoVideo + FOLGA_S) p.push("fora do vídeo");
  const dur = fim - ini;
  if (dur < CORTE_MIN_S || dur > CORTE_MAX_S) p.push("duração fora do limite");
  const citadas = (Array.isArray(c.falas) ? c.falas : []).map((id) => falas.find((f) => f.id === id));
  if (!citadas.length) p.push("sem falas que sustentem o corte");
  else if (citadas.some((f) => !f)) p.push("cita fala inexistente");
  else {
    const primeira = Math.min(...citadas.map((f) => f!.inicio)), ultima = Math.max(...citadas.map((f) => f!.fim));
    if (ini > primeira + FOLGA_S || fim < ultima - FOLGA_S) p.push("horário não cobre as falas citadas");
  }
  if (!String(c.titulo_sugerido ?? "").trim()) p.push("sem título");
  return p;
}

/**
 * Corte final: as falas citadas mais um respiro antes e depois; uma fala vizinha
 * que ficaria cortada ao meio entra inteira; se ainda ficar curto, cresce para os
 * dois lados até o mínimo. Sempre dentro de [0, limite] e até o máximo quando
 * as falas citadas cabem nele.
 */
export function comContexto(ini: number, fim: number, falas: Fala[], limite: number): { inicio: number; fim: number } {
  const { min, max } = DURACAO_CORTE;
  const respiro = Math.max(0, Math.min(CONTEXTO_S, (max - (fim - ini)) / 2));
  let a = Math.max(0, ini - respiro), b = Math.min(limite, fim + respiro);
  const cortada = (t: number) => falas.find((f) => f.inicio < t && t < f.fim);
  const fa = cortada(a);
  if (fa && b - fa.inicio <= max) a = fa.inicio;
  const fb = cortada(b);
  if (fb && fb.fim <= limite && fb.fim - a <= max) b = fb.fim;
  if (b - a < min) {
    a = Math.max(0, a - (min - (b - a)) / 2);
    b = Math.min(limite, a + min);
    a = Math.max(0, b - min);
  }
  return { inicio: a, fim: b };
}

// ── Pedido ao Gemini ─────────────────────────────────────────────────────────

export function montarPrompt(falas: Fala[], tema: string): string {
  // Falas numeradas: a IA cita os números e o horário é conferido contra elas.
  const transcricao = falas.map((f) => `[${f.id}] ${f.inicio.toFixed(1)}-${f.fim.toFixed(1)} ${f.texto}`).join("\n");
  return [
    `Tema ou roteiro do criador: "${tema}".`,
    "Abaixo está a legenda de um vídeo, uma fala por linha no formato [número] início-fim(segundos) texto.",
    `Sugira até ${MAX_CORTES} cortes de ${DURACAO_CORTE.min} a ${DURACAO_CORTE.max} segundos que sirvam ao tema, do mais forte para o mais fraco.`,
    "Cada corte deve ser um momento completo, que se entenda sozinho: inclua as falas de contexto antes (a situação, a pergunta)",
    "e depois (a reação, a conclusão), sem começar nem terminar no meio de uma ideia.",
    "Baseie-se SÓ no que está escrito nas falas. Não descreva imagens, ações ou cenários que o texto não confirma;",
    "se algo visual for provável mas não confirmado, diga isso no motivo e use confiança baixa.",
    "Cada corte deve citar os números de todas as falas que ele contém; o início é o da primeira fala citada e o fim o da última.",
    "Se nada servir ao tema, devolva a lista vazia.",
    "",
    transcricao,
  ].join("\n");
}

const ESQUEMA = {
  type: "OBJECT",
  properties: {
    cortes: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          inicio_segundos: { type: "NUMBER" },
          fim_segundos: { type: "NUMBER" },
          falas: { type: "ARRAY", items: { type: "INTEGER" } },
          titulo_sugerido: { type: "STRING" },
          o_que_e_dito: { type: "STRING" },
          motivo: { type: "STRING" },
          confianca: { type: "STRING", enum: ["alta", "media", "baixa"] },
        },
        required: ["inicio_segundos", "fim_segundos", "falas", "titulo_sugerido", "o_que_e_dito", "motivo", "confianca"],
      },
    },
  },
  required: ["cortes"],
};

const MAX_TOKENS_SAIDA = 4096;
const corpoGemini = (falas: Fala[], tema: string) => JSON.stringify({
  contents: [{ parts: [{ text: montarPrompt(falas, tema) }] }],
  generationConfig: { responseMimeType: "application/json", responseSchema: ESQUEMA, maxOutputTokens: MAX_TOKENS_SAIDA },
});

/** Bytes do pedido limitam os tokens de entrada; maxOutputTokens inclui raciocínio. */
export function custoMaximoAnalise(falas: Fala[], tema: string): number {
  const pedido = corpoGemini(falas, tema);
  // A normalização do tokenizer pode expandir caracteres; o pedido enviado não é alterado.
  const entrada = Math.max(Buffer.byteLength(pedido, "utf8"), Buffer.byteLength(pedido.normalize("NFKC"), "utf8"));
  return custoMicroUsd({ entrada, saida: MAX_TOKENS_SAIDA });
}

function tokensDoUso(uso?: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number }): Tokens | null {
  if (!uso) return null;
  const pensamentos = uso.thoughtsTokenCount === undefined ? 0 : uso.thoughtsTokenCount;
  const contagens = [uso.promptTokenCount, uso.candidatesTokenCount, pensamentos];
  if (contagens.some((n) => !Number.isSafeInteger(n) || n! < 0)) return null;
  // candidates não inclui pensamentos; totalTokenCount inclui a entrada e não deve ser somado.
  const saida = uso.candidatesTokenCount! + pensamentos;
  return Number.isSafeInteger(saida) ? { entrada: uso.promptTokenCount!, saida } : null;
}

export class FalhaCortesAi extends Error {
  constructor(public codigo: "timeout" | "http" | "resposta_invalida", public status?: number, public tokens: Tokens | null = null) { super(codigo); }
}

/**
 * Uma chamada, sem nova tentativa, com prazo. A chave vai só no header; o erro
 * carrega apenas o código e o status HTTP — nunca o corpo do provedor.
 */
export async function pedirCortes(
  falas: Fala[], tema: string, chave: string,
  opcoes: { fetch?: typeof fetch; prazoMs?: number } = {},
): Promise<{ cortes: Partial<CorteSugerido>[]; tokens: Tokens | null }> {
  const f = opcoes.fetch ?? fetch;
  let r: Response;
  try {
    r = await f(`https://generativelanguage.googleapis.com/v1beta/models/${MODELO_CORTES_AI}:generateContent`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": chave },
      body: corpoGemini(falas, tema),
      signal: AbortSignal.timeout(opcoes.prazoMs ?? 45_000),
    });
  } catch {
    throw new FalhaCortesAi("timeout");
  }
  if (!r.ok) throw new FalhaCortesAi("http", r.status);
  let tokens: Tokens | null = null;
  try {
    const dados = await r.json() as {
      candidates?: { content?: { parts?: { text?: string }[] } }[];
      usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number };
    };
    tokens = tokensDoUso(dados.usageMetadata);
    const texto = dados.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
    const cortes = (JSON.parse(texto) as { cortes?: unknown }).cortes;
    if (!Array.isArray(cortes)) throw new Error();
    return {
      cortes: cortes.slice(0, MAX_CORTES),
      tokens,
    };
  } catch {
    throw new FalhaCortesAi("resposta_invalida", undefined, tokens);
  }
}

/**
 * Só os cortes que passam na validação, já com contexto e dentro do vídeo, no
 * formato que o editor importa (parsearSugestoesIA).
 */
export function cortesAceitos(cortes: Partial<CorteSugerido>[], falas: Fala[], duracaoVideo?: number) {
  const limite = duracaoVideo ?? (falas.at(-1)?.fim ?? 0) + CONTEXTO_S;
  const aceitos = cortes.filter((c) => validarCorte(c, falas, duracaoVideo).length === 0).map((c) => {
    const corte = comContexto(c.inicio_segundos!, c.fim_segundos!, falas, limite);
    return {
      inicio_segundos: corte.inicio, fim_segundos: corte.fim, titulo_sugerido: String(c.titulo_sugerido).trim(),
      o_que_e_dito: typeof c.o_que_e_dito === "string" ? c.o_que_e_dito : "", motivo: typeof c.motivo === "string" ? c.motivo : "",
      confianca: typeof c.confianca === "string" ? c.confianca : "",
    };
  });
  return { aceitos, rejeitados: cortes.length - aceitos.length };
}
