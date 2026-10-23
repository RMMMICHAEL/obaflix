export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/authSession";
import { checkRateLimit, clientIp, headerMatchesHost, readJsonBody } from "@/lib/requestSecurity";
import { isIpBlocked, recordAbuseAttempt } from "@/lib/playTokens";
import { audit } from "@/lib/auditLog";
import { entitlementsDoUsuario } from "@/lib/entitlements";
import { configCortesAi, cortesAceitos, FalhaCortesAi, impressaoDaLegenda, lerLegenda, LIMITES_CORTES_AI, pedirCortes } from "@/lib/cortesAi";

const NO_STORE = { "Cache-Control": "no-store, no-cache, must-revalidate, private" };
const negar = (status: number, codigo: string, error: string) =>
  NextResponse.json({ error, codigo }, { status, headers: NO_STORE });

interface Corpo { conteudoId?: unknown; tema?: unknown; legenda?: unknown }

/**
 * POST /api/cortes/ia — sugere cortes a partir do texto da legenda que o player
 * já carregou. Ordem: configuração → origem → sessão → direito `ia` → legenda
 * autorizada → corpo válido → limite diário → uma chamada ao Gemini → validação.
 * Nenhuma recusa consome o limite; nenhuma resposta leva a chave ou o corpo do provedor.
 */
export async function POST(req: NextRequest) {
  const ip = clientIp(req);
  const ua = req.headers.get("user-agent") || "unknown";
  const config = configCortesAi();
  if (!config.ativo) return negar(503, "cortes_ai_indisponivel", "Cortes AI indisponível");

  if (await isIpBlocked(ip)) return negar(429, "bloqueado", "Acesso negado");
  const origin = req.headers.get("origin");
  const host = req.headers.get("host");
  if (origin && host && !headerMatchesHost(origin, host)) {
    await recordAbuseAttempt(ip);
    audit("origin_rejected", { ip, ua, detail: "/cortes/ia" });
    return negar(403, "origem_invalida", "Acesso negado");
  }

  const usuario = await getUserFromRequest(req);
  if (!usuario?.userId) {
    audit("auth_failure", { ip, ua, detail: "/cortes/ia sem sessão" });
    return negar(401, "sem_sessao", "Acesso negado");
  }
  const userId = usuario.userId;

  try {
    const { direitos } = await entitlementsDoUsuario(userId);
    if (direitos.cortesNivel !== "ia") {
      audit("cortes_ai_negado", { userId, ip, ua, detail: "sem_direito" });
      return negar(403, "cortes_ai_sem_direito", "Seu plano não inclui o Cortes AI");
    }
  } catch {
    audit("entitlements_indisponiveis", { userId, ip, ua, detail: "/cortes/ia" });
    return negar(503, "entitlements_indisponiveis", "Serviço temporariamente indisponível");
  }

  let corpo: Corpo;
  try {
    corpo = await readJsonBody<Corpo>(req, LIMITES_CORTES_AI.legendaBytes + 4096);
  } catch {
    return negar(400, "corpo_invalido", "Parâmetros inválidos");
  }
  const conteudoId = typeof corpo.conteudoId === "string" ? corpo.conteudoId : "";
  const legenda = typeof corpo.legenda === "string" ? corpo.legenda : "";
  // Só legenda própria ou licenciada vai ao Gemini: o texto recebido precisa ser
  // exatamente a legenda autorizada daquele conteúdo (impressão registrada no servidor).
  const autorizada = config.legendas.get(conteudoId);
  if (!autorizada || impressaoDaLegenda(legenda) !== autorizada) {
    audit("cortes_ai_negado", { userId, ip, ua, detail: "legenda_nao_autorizada" });
    return negar(403, "legenda_nao_autorizada", "A legenda deste título não está liberada para o Cortes AI");
  }
  const tema = typeof corpo.tema === "string" ? corpo.tema.trim() : "";
  if (tema.length < LIMITES_CORTES_AI.temaMin || tema.length > LIMITES_CORTES_AI.temaMax) {
    return negar(400, "tema_invalido", `Escreva o pedido com ${LIMITES_CORTES_AI.temaMin} a ${LIMITES_CORTES_AI.temaMax} caracteres`);
  }
  const falas = lerLegenda(legenda);
  if (falas.length < LIMITES_CORTES_AI.falasMin || falas.length > LIMITES_CORTES_AI.falasMax) {
    return negar(422, "legenda_invalida", "A legenda deste título não pôde ser lida");
  }

  let limite: { allowed: boolean };
  try {
    limite = await checkRateLimit(`cortesai:dia:${userId}`, config.limiteDia, 24 * 3600);
  } catch {
    return negar(503, "limite_indisponivel", "Serviço temporariamente indisponível");
  }
  if (!limite.allowed) {
    audit("rate_limited", { userId, ip, ua, detail: "/cortes/ia limite diário" });
    return negar(429, "limite_diario", "Você atingiu o limite diário do Cortes AI");
  }

  const t0 = Date.now();
  try {
    const { cortes, tokens } = await pedirCortes(falas, tema, config.chave);
    const { aceitos, rejeitados } = cortesAceitos(cortes, falas);
    audit("cortes_ai_analise", {
      userId, ip, ua,
      detail: `conteudo:${conteudoId} falas:${falas.length} aceitos:${aceitos.length} rejeitados:${rejeitados} tokens:${tokens.entrada}+${tokens.saida} ms:${Date.now() - t0}`,
    });
    return NextResponse.json({ cortes: aceitos, rejeitados }, { headers: NO_STORE });
  } catch (e) {
    const f = e instanceof FalhaCortesAi ? e : null;
    audit("cortes_ai_falhou", { userId, ip, ua, detail: `${f?.codigo ?? "erro"}${f?.status ? `:${f.status}` : ""}` });
    return negar(502, "ia_indisponivel", "O Cortes AI não respondeu. Tente de novo mais tarde.");
  }
}
