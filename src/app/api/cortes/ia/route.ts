export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/authSession";
import { checkRateLimit, clientIp, headerMatchesHost, readJsonBody } from "@/lib/requestSecurity";
import { isIpBlocked, recordAbuseAttempt } from "@/lib/playTokens";
import { audit } from "@/lib/auditLog";
import { entitlementsDoUsuario } from "@/lib/entitlements";
import { configCortesAi, cortesAceitos, custoMicroUsd, FalhaCortesAi, gastoDoMes, impressaoDaLegenda, lerLegenda, LIMITES_CORTES_AI, pedirCortes, registrarGasto, type Fala } from "@/lib/cortesAi";
import { getRedis } from "@/lib/redis";
import { buscarLegenda, configLegendasAutomaticas, identificarConteudo, type Alvo, type LegendaEncontrada } from "@/lib/legendasAutomaticas";

const NO_STORE = { "Cache-Control": "no-store, no-cache, must-revalidate, private" };
const negar = (status: number, codigo: string, error: string) =>
  NextResponse.json({ error, codigo }, { status, headers: NO_STORE });

interface Corpo { conteudoId?: unknown; temporada?: unknown; episodio?: unknown; duracaoVideo?: unknown; tema?: unknown; legenda?: unknown }

/**
 * POST /api/cortes/ia — sugere cortes a partir do texto de uma legenda. Ordem:
 * configuração → origem → sessão → direito `ia` → pedido → legenda autorizada
 * (SHA-256) ou conteúdo identificado no catálogo → teto mensal de gasto → limite diário → busca da
 * legenda no provedor (modo automático) → uma chamada ao Gemini → validação.
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
  const tema = typeof corpo.tema === "string" ? corpo.tema.trim() : "";
  if (tema.length < LIMITES_CORTES_AI.temaMin || tema.length > LIMITES_CORTES_AI.temaMax) {
    return negar(400, "tema_invalido", `Escreva o pedido com ${LIMITES_CORTES_AI.temaMin} a ${LIMITES_CORTES_AI.temaMax} caracteres`);
  }

  // Dois modos. Com `legenda` no corpo: só a legenda própria/licenciada cuja
  // impressão SHA-256 está registrada no servidor. Sem `legenda`: o servidor
  // identifica o conteúdo no catálogo e busca a legenda ele mesmo (desligado por
  // padrão) — o texto nunca vem do cliente.
  let falas: Fala[] | null = null;
  let alvo: Alvo | null = null;
  const automaticas = configLegendasAutomaticas();
  if (typeof corpo.legenda === "string") {
    const legenda = corpo.legenda;
    const autorizada = config.legendas.get(conteudoId);
    if (!autorizada || impressaoDaLegenda(legenda) !== autorizada) {
      audit("cortes_ai_negado", { userId, ip, ua, detail: "legenda_nao_autorizada" });
      return negar(403, "legenda_nao_autorizada", "A legenda deste título não está liberada para o Cortes AI");
    }
    falas = lerLegenda(legenda);
    if (falas.length < LIMITES_CORTES_AI.falasMin || falas.length > LIMITES_CORTES_AI.falasMax) {
      return negar(422, "legenda_invalida", "A legenda deste título não pôde ser lida");
    }
  } else {
    if (!automaticas.ativo) {
      audit("cortes_ai_negado", { userId, ip, ua, detail: "legenda_automatica_desligada" });
      return negar(403, "legenda_nao_autorizada", "A legenda deste título não está liberada para o Cortes AI");
    }
    try {
      alvo = await identificarConteudo(conteudoId, corpo.temporada, corpo.episodio);
    } catch {
      return negar(503, "catalogo_indisponivel", "Serviço temporariamente indisponível");
    }
    if (!alvo) return negar(404, "conteudo_nao_identificado", "Não encontramos este título para buscar a legenda");
  }

  // Teto de gasto do mês, por usuário (CORTES_AI_TETO_USD_MES). Sem leitura, não analisa.
  let gasto: number;
  try {
    gasto = await gastoDoMes(getRedis(), userId);
  } catch {
    return negar(503, "limite_indisponivel", "Serviço temporariamente indisponível");
  }
  if (gasto >= config.tetoMicroUsdMes) {
    audit("cortes_ai_negado", { userId, ip, ua, detail: "teto_mensal" });
    return negar(429, "teto_mensal", "Você atingiu o limite mensal do Cortes AI. Ele volta no próximo mês.");
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

  // Duração real do vídeo no player: só limita os cortes devolvidos, nunca autoriza.
  const duracaoCliente = Number(corpo.duracaoVideo);
  const duracaoVideo = duracaoCliente >= 60 && duracaoCliente <= 6 * 3600 ? duracaoCliente : undefined;

  // Legenda automática: depois do limite, porque cada busca gasta downloads no provedor.
  let origemLegenda = "enviada";
  if (alvo && automaticas.base) {
    // Só para escolher a legenda (filtro de duração), nunca para autorizar.
    const duracao = alvo.duracaoSeg ?? duracaoVideo;
    let encontrada: LegendaEncontrada | null;
    try {
      encontrada = await buscarLegenda(alvo, automaticas.base, duracao);
    } catch {
      audit("cortes_ai_falhou", { userId, ip, ua, detail: "legenda_provedor" });
      return negar(502, "legenda_indisponivel", "Não foi possível buscar a legenda agora. Tente de novo mais tarde.");
    }
    if (!encontrada) return negar(404, "legenda_nao_encontrada", "Não encontramos uma legenda compatível para este título");
    falas = encontrada.falas;
    origemLegenda = `auto sub:${encontrada.subId} idioma:${encontrada.idioma} confiavel:${encontrada.confiavel} sha:${encontrada.impressao.slice(0, 16)} downloads:${encontrada.downloads}`;
  }
  if (!falas) return negar(422, "legenda_invalida", "A legenda deste título não pôde ser lida");

  const t0 = Date.now();
  try {
    const { cortes, tokens } = await pedirCortes(falas, tema, config.chave);
    const { aceitos, rejeitados } = cortesAceitos(cortes, falas, duracaoVideo);
    const custo = custoMicroUsd(tokens);
    // A análise já foi paga: falha ao registrar não tira o resultado do usuário.
    await registrarGasto(getRedis(), userId, custo).catch(() => audit("cortes_ai_falhou", { userId, ip, ua, detail: "registro_de_gasto" }));
    audit("cortes_ai_analise", {
      userId, ip, ua,
      detail: `conteudo:${conteudoId} fonte:${origemLegenda} falas:${falas.length} aceitos:${aceitos.length} rejeitados:${rejeitados} tokens:${tokens.entrada}+${tokens.saida} usd:${(custo / 1e6).toFixed(4)} ms:${Date.now() - t0}`,
    });
    return NextResponse.json({ cortes: aceitos, rejeitados }, { headers: NO_STORE });
  } catch (e) {
    const f = e instanceof FalhaCortesAi ? e : null;
    audit("cortes_ai_falhou", { userId, ip, ua, detail: `${f?.codigo ?? "erro"}${f?.status ? `:${f.status}` : ""}` });
    return negar(502, "ia_indisponivel", "O Cortes AI não respondeu. Tente de novo mais tarde.");
  }
}
