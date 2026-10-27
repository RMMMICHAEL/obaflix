/**
 * Cortes AI — legenda automática: o servidor identifica o conteúdo pelo catálogo
 * (TMDB/IMDb, temporada e episódio) e busca a legenda no addon de legendas já
 * testado. O player não envia texto de legenda neste modo; o servidor não confia
 * em nada que venha dele além do id do conteúdo, que é conferido no banco.
 *
 * Desligado por padrão: CORTES_AI_LEGENDAS_AUTOMATICAS=1 e CORTES_AI_LEGENDAS_ADDON
 * (URL base do addon, sem /manifest.json). Só os hosts de HOSTS_PERMITIDOS, por
 * HTTPS, com SSRF conferido em cada redirecionamento, prazo e teto de tamanho.
 */
import { prisma } from "@/lib/prisma";
import { safeGet } from "@/lib/ssrf";
import { getIdsExternos } from "@/lib/tmdb";
import { impressaoDaLegenda, lerLegenda, LIMITES_CORTES_AI, type Fala } from "@/lib/cortesAi";

/** O addon responde num host e redireciona a lista e os arquivos para o outro. */
export const HOSTS_PERMITIDOS = new Set(["opensubtitlesv3-pro.dexter21767.com", "opensubtitles.stremio.homes"]);
const IDIOMAS = ["pt-br", "pt", "en"];
const MAX_DOWNLOADS = 3;
const LISTA_MAX_BYTES = 512 * 1024;
const PRAZO_MS = 10_000;

const hostPermitido = (u: URL) => u.protocol === "https:" && HOSTS_PERMITIDOS.has(u.hostname);

export function configLegendasAutomaticas(env: Record<string, string | undefined> = process.env) {
  let base: string | null = null;
  try {
    const u = new URL(env.CORTES_AI_LEGENDAS_ADDON ?? "");
    if (hostPermitido(u) && !u.username && !u.password && !u.search) base = u.toString().replace(/\/(manifest\.json)?$/, "");
  } catch { /* sem base válida = desligado */ }
  return { ativo: env.CORTES_AI_LEGENDAS_AUTOMATICAS === "1" && !!base, base };
}

// ── Conteúdo ─────────────────────────────────────────────────────────────────

export interface Alvo { tipo: "filme" | "serie"; imdb: string; temporada?: number; episodio?: number; duracaoSeg?: number }
interface Banco {
  filme: { findUnique(a: unknown): Promise<{ tmdbId: string | null; imdbId: string | null; duracao: number | null } | null> };
  serie: { findUnique(a: unknown): Promise<{ tmdbId: string | null; imdbId: string | null } | null> };
  episodio: { findFirst(a: unknown): Promise<{ id: string } | null> };
}

const imdbValido = (v: unknown) => (typeof v === "string" && /^tt\d{5,10}$/.test(v) ? v : null);

/** Conteúdo pelo catálogo, nunca pelo que o cliente diz: o id precisa existir, e o episódio também. */
export async function identificarConteudo(
  conteudoId: string, temporada: unknown, episodio: unknown,
  deps: { db?: Banco; ids?: typeof getIdsExternos } = {},
): Promise<Alvo | null> {
  const db = deps.db ?? (prisma as unknown as Banco);
  const ids = deps.ids ?? getIdsExternos;
  const filme = await db.filme.findUnique({ where: { id: conteudoId }, select: { tmdbId: true, imdbId: true, duracao: true } });
  if (filme) {
    const imdb = imdbValido(filme.imdbId) ?? (filme.tmdbId ? imdbValido((await ids("filme", filme.tmdbId))?.imdb_id) : null);
    return imdb ? { tipo: "filme", imdb, duracaoSeg: filme.duracao ? filme.duracao * 60 : undefined } : null;
  }
  const t = Number(temporada), e = Number(episodio);
  if (!Number.isInteger(t) || !Number.isInteger(e) || t < 0 || e < 1) return null;
  const serie = await db.serie.findUnique({ where: { id: conteudoId }, select: { tmdbId: true, imdbId: true } });
  if (!serie) return null;
  if (!(await db.episodio.findFirst({ where: { serieId: conteudoId, temporada: t, numeroEp: e }, select: { id: true } }))) return null;
  const imdb = imdbValido(serie.imdbId) ?? (serie.tmdbId ? imdbValido((await ids("serie", serie.tmdbId))?.imdb_id) : null);
  return imdb ? { tipo: "serie", imdb, temporada: t, episodio: e } : null;
}

// ── Escolha da legenda ───────────────────────────────────────────────────────

export interface Candidata { sub_id?: unknown; lang_code?: unknown; from_trusted?: unknown; ai_translated?: unknown; url?: unknown }

/** Português antes de inglês; dentro do idioma, fonte confiável e não traduzida por IA primeiro. */
export function ordenarCandidatas(lista: Candidata[]): Candidata[] {
  const idioma = (c: Candidata) => IDIOMAS.indexOf(String(c.lang_code ?? "").toLowerCase());
  return lista
    .map((c, i) => ({ c, i }))
    .filter(({ c }) => idioma(c) >= 0 && typeof c.url === "string")
    .sort((a, b) => idioma(a.c) - idioma(b.c)
      || Number(b.c.from_trusted === true) - Number(a.c.from_trusted === true)
      || Number(a.c.ai_translated === true) - Number(b.c.ai_translated === true)
      || a.i - b.i)
    .map(({ c }) => c);
}

/**
 * A última fala precisa terminar dentro do vídeo (até 5 s de folga) e não muito
 * antes do fim (créditos: até 15% ou 3 min). Sem duração conhecida, não filtra.
 * shortcut: só confere a duração, não a sincronia fala a fala — ver relatório.
 */
export function duracaoCompativel(falas: Fala[], duracaoSeg?: number): boolean {
  if (!duracaoSeg || !Number.isFinite(duracaoSeg)) return true;
  const fim = falas.at(-1)?.fim ?? 0;
  return fim <= duracaoSeg + 5 && fim >= duracaoSeg - Math.max(180, duracaoSeg * 0.15);
}

export type Obter = (url: string, maxBytes: number) => Promise<string>;

/** GET só nos hosts permitidos, por HTTPS, com SSRF a cada salto, prazo e teto de bytes. */
export const obterTexto: Obter = async (url, maxBytes) => {
  const r = await safeGet(url, { signal: AbortSignal.timeout(PRAZO_MS) }, 4, hostPermitido);
  if (!r.ok || !r.body) { r.body?.cancel().catch(() => {}); throw new Error(`http ${r.status}`); }
  const leitor = r.body.getReader();
  const pedacos: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await leitor.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) { await leitor.cancel(); throw new Error("grande demais"); }
    pedacos.push(value);
  }
  return new TextDecoder("utf-8").decode(Buffer.concat(pedacos));
};

export interface LegendaEncontrada { falas: Fala[]; subId: string; idioma: string; confiavel: boolean; impressao: string; downloads: number }

/** Lista do addon → até MAX_DOWNLOADS candidatas, na ordem → a primeira legível e compatível com a duração. */
export async function buscarLegenda(alvo: Alvo, base: string, duracaoSeg: number | undefined, obter: Obter = obterTexto): Promise<LegendaEncontrada | null> {
  const id = alvo.tipo === "serie" ? `${alvo.imdb}:${alvo.temporada}:${alvo.episodio}` : alvo.imdb;
  const lista = JSON.parse(await obter(`${base}/subtitles/${alvo.tipo === "serie" ? "series" : "movie"}/${id}.json`, LISTA_MAX_BYTES)) as { subtitles?: unknown };
  const candidatas = ordenarCandidatas(Array.isArray(lista.subtitles) ? lista.subtitles : []);
  let downloads = 0;
  for (const c of candidatas.slice(0, MAX_DOWNLOADS)) {
    downloads++;
    let texto: string;
    try { texto = await obter(String(c.url), LIMITES_CORTES_AI.legendaBytes); } catch { continue; }
    const falas = lerLegenda(texto);
    if (falas.length < LIMITES_CORTES_AI.falasMin || falas.length > LIMITES_CORTES_AI.falasMax) continue;
    if (!duracaoCompativel(falas, duracaoSeg)) continue;
    return { falas, subId: String(c.sub_id ?? ""), idioma: String(c.lang_code), confiavel: c.from_trusted === true, impressao: impressaoDaLegenda(texto), downloads };
  }
  return null;
}
