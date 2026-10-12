export const dynamic = "force-dynamic";
export const maxDuration = 30;

import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/authSession";
import { prisma } from "@/lib/prisma";
import { checkRateLimit, clientIp, headerMatchesHost, readJsonBody } from "@/lib/requestSecurity";
import { audit } from "@/lib/auditLog";
import { invalidarEntitlements } from "@/lib/entitlements";
import {
  confirmacaoValida,
  excluirDadosDaConta,
  papelPodeExcluir,
  sessaoPodeExcluir,
} from "@/lib/account/deletion";

/**
 * `DELETE /api/user/account` — exclusão real e autosserviço da conta.
 *
 * A identidade vem **só da sessão**. Nenhum `userId` de corpo, query ou header é
 * lido: quem é excluído é sempre quem está autenticado, e tentar apagar a conta
 * de terceiro mandando o id dele não tem efeito nenhum porque esse id não é
 * consultado em lugar algum.
 *
 * Igual para navegador, APK direto e Play: o marcador `ObaflixPlay/` não entra
 * nesta rota — a loja exige que o app ofereça exclusão de conta, e negá-la ao
 * cliente Play reprovaria a publicação. A rota fina mora aqui (origem, sessão,
 * IP, limite, tamanho e forma do corpo); a decisão e a ordem da exclusão vivem
 * em `src/lib/account/deletion.ts`, onde os testes as alcançam.
 *
 * **Não existe outro verbo nesta rota.**
 */

const NO_STORE = { "Cache-Control": "no-store, no-cache, must-revalidate, private" };

/** `{ "confirmacao": "EXCLUIR" }` cabe de sobra. Nada maior tem o que fazer aqui. */
const LIMITE_DO_CORPO = 256;

// ── Limites ──────────────────────────────────────────────────────────────────
//
// Excluir conta é raro e irreversível: ninguém o faz três vezes por hora de
// boa-fé. O limite por conta corta a repetição acidental; o limite por IP corta
// quem automatiza tentativas contra várias contas. Os dois valem sempre.
const LIMITE_POR_CONTA = 3;
const LIMITE_POR_IP = 10;
const JANELA_SEGUNDOS = 3600;

/** Resposta curta, código estável, sem oráculo. Os detalhes ficam no log. */
function erro(status: number, codigo: string, mensagem: string) {
  return NextResponse.json({ error: mensagem, codigo }, { status, headers: NO_STORE });
}

export async function DELETE(req: NextRequest) {
  const ip = clientIp(req);
  const ua = req.headers.get("user-agent") || "unknown";

  // 1. Origem. Mesmo critério de `/api/billing/orders`: só confere quando o
  //    `Origin` existe — é o navegador que envia cookie automaticamente, e é por
  //    isso que uma mutação por cookie precisa desta checagem. Cliente nativo
  //    com Bearer não manda `Origin` (e é recusado logo adiante de qualquer jeito).
  const origin = req.headers.get("origin");
  const host = req.headers.get("host");
  if (origin && host && !headerMatchesHost(origin, host)) {
    audit("origin_rejected", { ip, ua, detail: "/user/account" });
    return erro(403, "acesso_negado", "Acesso negado");
  }

  // 2. Sessão humana. Sem credencial → 401; Bearer/TV → 403. Antes do banco.
  const usuario = await getUserFromRequest(req);
  const porta = sessaoPodeExcluir(usuario);
  if (!porta.ok) {
    audit("account_delete_rejected", { userId: usuario?.userId, ip, ua, detail: porta.codigo });
    return erro(porta.status, "acesso_negado", "Acesso negado");
  }
  const userId = usuario!.userId;

  // 3. Limite específico de exclusão. **Falha fechado**: Redis fora recusa, em
  //    vez de deixar passar uma operação irreversível.
  try {
    const [porConta, porIp] = await Promise.all([
      checkRateLimit(`account:delete:user:${userId}`, LIMITE_POR_CONTA, JANELA_SEGUNDOS),
      checkRateLimit(`account:delete:ip:${ip}`, LIMITE_POR_IP, JANELA_SEGUNDOS),
    ]);
    if (!porConta.allowed || !porIp.allowed) {
      audit("rate_limited", { userId, ip, ua, detail: "/user/account" });
      return erro(429, "muitas_tentativas", "Muitas tentativas. Tente mais tarde");
    }
  } catch {
    audit("account_delete_rejected", { userId, ip, ua, detail: "limite_indisponivel" });
    return erro(503, "indisponivel", "Serviço temporariamente indisponível");
  }

  // 4. Papel do banco (o JWT pode estar velho) e existência da conta. Admin não
  //    se autoexclui; conta que já sumiu não tem o que excluir.
  const conta = await prisma.user.findUnique({ where: { id: userId }, select: { role: true } });
  const papel = papelPodeExcluir(conta?.role ?? null);
  if (!papel.ok) {
    audit("account_delete_rejected", { userId, ip, ua, detail: papel.codigo });
    return erro(papel.status, "acesso_negado", "Acesso negado");
  }

  // 5. Confirmação forte. Corpo minúsculo e `{ "confirmacao": "EXCLUIR" }` exato.
  let corpo: unknown;
  try {
    corpo = await readJsonBody(req, LIMITE_DO_CORPO);
  } catch {
    audit("account_delete_rejected", { userId, ip, ua, detail: "corpo_invalido" });
    return erro(400, "confirmacao_invalida", "Confirmação inválida");
  }
  if (!confirmacaoValida(corpo)) {
    audit("account_delete_rejected", { userId, ip, ua, detail: "confirmacao_invalida" });
    return erro(400, "confirmacao_invalida", "Confirmação inválida");
  }

  audit("account_delete_requested", { userId, ip, ua });

  // 6. Exclusão transacional, na ordem real das FKs. Tudo ou nada: qualquer
  //    falha reverte e nada é apagado pela metade. O erro ao cliente é neutro —
  //    não expõe FK, tabela nem motivo interno.
  try {
    await prisma.$transaction((tx) => excluirDadosDaConta(tx, userId));
  } catch {
    audit("account_delete_rejected", { userId, ip, ua, detail: "falha_na_transacao" });
    return erro(500, "falha", "Não foi possível excluir a conta");
  }

  // Cache de entitlement: a conta pode ter direitos **pagos** memorizados por até
  // ~2 min (`TTL_ENTITLEMENTS_SEG`). As linhas de `Assinatura` já foram apagadas
  // na transação acima, então qualquer resolução a partir de agora só pode
  // reencher com o plano padrão — mas uma entrada ainda viva concederia o plano
  // pago por essa janela nas rotas que resolvem entitlements. Invalida-se
  // **depois** do commit, de propósito: antes dele uma resolução concorrente
  // reencheria a partir das linhas que ainda existiam. Falha aqui **não desfaz** a
  // exclusão (os dados já se foram) e **não é silenciosa** — é auditada; o TTL é o
  // teto do resíduo. Não transforma hiccup de Redis em "exclusão não concluída".
  try {
    await invalidarEntitlements(userId);
  } catch {
    audit("billing_entitlements_invalidation_failed", { userId, ip, ua, detail: "account_delete" });
  }

  audit("account_delete_completed", { userId, ip, ua });

  // A sessão continua sendo um JWT que ainda decodifica até expirar — mas a
  // linha `User` não existe mais, então login futuro falha (`auth.ts` não acha a
  // conta) e os refresh tokens de TV já saíram com os dispositivos. O cliente
  // encerra a sessão (`signOut`) ao receber esta resposta.
  return NextResponse.json({ ok: true }, { status: 200, headers: NO_STORE });
}
