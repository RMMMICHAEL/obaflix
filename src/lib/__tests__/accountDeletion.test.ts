import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  CONFIRMACAO_ESPERADA,
  confirmacaoValida,
  excluirDadosDaConta,
  papelPodeExcluir,
  sessaoPodeExcluir,
} from "../account/deletion";
import { decidirRota } from "../../config/site-mode";
import { normalizarToken, type UsuarioRequisicao } from "../authSession";

/**
 * Exclusão de conta — Estágio 3.
 *
 * Duas metades, como em `billingOrdersRoute.test.ts`:
 *
 *   1. **Comportamento de verdade.** A decisão de quem pode excluir, o que é
 *      confirmação forte e a ordem exata em que as linhas saem do banco são
 *      funções puras tiradas da rota de propósito — e aqui elas são exercitadas,
 *      não grepadas. A ordem é testada contra uma transação falsa que grava a
 *      sequência de chamadas.
 *
 *   2. **A forma da rota**, lida do fonte: prova que a origem vem antes da
 *      sessão, a sessão antes do limite, o limite antes do banco; que o limite
 *      falha fechado; que a identidade só vem da sessão; e que nada de PII nem o
 *      marcador do Play aparecem.
 */

// ── 1. Sessão humana ──────────────────────────────────────────────────────────

const cookie = (role = "user"): UsuarioRequisicao => ({ userId: "u-1", role, origem: "cookie", deviceId: null });
const bearer = (): UsuarioRequisicao => ({ userId: "u-1", role: "user", origem: "bearer", deviceId: "d-1" });

describe("sessaoPodeExcluir: exige sessão humana", () => {
  test("sem credencial → 401", () => {
    assert.deepEqual(sessaoPodeExcluir(null), { ok: false, status: 401, codigo: "sem_sessao" });
  });

  test("Bearer/TV é recusado explicitamente → 403", () => {
    assert.deepEqual(sessaoPodeExcluir(bearer()), { ok: false, status: 403, codigo: "origem_nao_humana" });
  });

  test("cookie passa", () => {
    assert.deepEqual(sessaoPodeExcluir(cookie()), { ok: true });
  });
});

// ── 2. Papel, lido do banco ────────────────────────────────────────────────────

describe("papelPodeExcluir: admin nunca se autoexclui; conta sumida é 401", () => {
  test("conta inexistente no banco → 401", () => {
    assert.deepEqual(papelPodeExcluir(null), { ok: false, status: 401, codigo: "conta_inexistente" });
  });

  test("admin → 403, mesmo com sessão válida", () => {
    assert.deepEqual(papelPodeExcluir("admin"), { ok: false, status: 403, codigo: "admin_nao_pode_excluir" });
  });

  test("user comum passa", () => {
    assert.deepEqual(papelPodeExcluir("user"), { ok: true });
  });

  test("só 'admin' é bloqueado — outro papel não-admin passa", () => {
    assert.deepEqual(papelPodeExcluir("moderador"), { ok: true });
  });
});

// ── 3. Confirmação forte ───────────────────────────────────────────────────────

describe("confirmacaoValida: igualdade estrita de EXCLUIR", () => {
  test("a palavra exata passa", () => {
    assert.equal(confirmacaoValida({ confirmacao: "EXCLUIR" }), true);
    assert.equal(CONFIRMACAO_ESPERADA, "EXCLUIR");
  });

  test("ausente, minúscula, com espaço ou outro tipo não passa", () => {
    for (const c of [{}, { confirmacao: "excluir" }, { confirmacao: " EXCLUIR " }, { confirmacao: "EXCLUIR!" }, { confirmacao: 1 }, { confirmacao: null }, { confirmacao: true }]) {
      assert.equal(confirmacaoValida(c), false, `${JSON.stringify(c)} não deveria confirmar`);
    }
  });

  test("corpo que não é objeto simples não passa", () => {
    for (const c of [null, undefined, "EXCLUIR", 42, [], ["EXCLUIR"]]) {
      assert.equal(confirmacaoValida(c), false, `${JSON.stringify(c)} não deveria confirmar`);
    }
  });
});

// ── 4. A ordem de exclusão, contra uma transação falsa ─────────────────────────

type Chamada = { modelo: string; op: "deleteMany" | "delete"; where: Record<string, unknown> };

function criarTxFake() {
  const chamadas: Chamada[] = [];
  const contagem: Record<string, number> = {
    watchHistory: 2, watchlist: 3, like: 4, tvRefreshToken: 5, tvDevice: 1,
    revisaoPagamentoEvento: 6, revisaoPagamento: 7, eventoPagamento: 8, assinatura: 9, pedidoPagamento: 10,
  };
  const deleteMany = (modelo: string) => async ({ where }: { where: Record<string, unknown> }) => {
    chamadas.push({ modelo, op: "deleteMany", where });
    return { count: contagem[modelo] };
  };
  const modelos = [
    "watchHistory", "watchlist", "like", "tvRefreshToken", "tvDevice",
    "revisaoPagamentoEvento", "revisaoPagamento", "eventoPagamento", "assinatura", "pedidoPagamento",
  ] as const;
  const tx: Record<string, unknown> = {
    user: {
      delete: async ({ where }: { where: Record<string, unknown> }) => {
        chamadas.push({ modelo: "user", op: "delete", where });
        return {};
      },
    },
  };
  for (const m of modelos) tx[m] = { deleteMany: deleteMany(m) };
  return { tx, chamadas };
}

type TxParam = Parameters<typeof excluirDadosDaConta>[0];
const idx = (ordem: string[], modelo: string) => {
  const i = ordem.indexOf(modelo);
  assert.notEqual(i, -1, `${modelo} não foi excluído`);
  return i;
};

describe("excluirDadosDaConta: ordem, abrangência e identidade", () => {
  test("a conta (User) sai por último", async () => {
    const { tx, chamadas } = criarTxFake();
    await excluirDadosDaConta(tx as unknown as TxParam, "u-123");
    assert.equal(chamadas[chamadas.length - 1].modelo, "user");
    assert.equal(chamadas[chamadas.length - 1].op, "delete");
  });

  test("a cadeia de cobrança respeita as FKs NO ACTION", async () => {
    const { tx, chamadas } = criarTxFake();
    await excluirDadosDaConta(tx as unknown as TxParam, "u-123");
    const ordem = chamadas.map((c) => c.modelo);
    // evento de revisão antes do caso; caso antes do pedido
    assert.ok(idx(ordem, "revisaoPagamentoEvento") < idx(ordem, "revisaoPagamento"));
    assert.ok(idx(ordem, "revisaoPagamento") < idx(ordem, "pedidoPagamento"));
    // assinatura e evento de pagamento antes do pedido
    assert.ok(idx(ordem, "assinatura") < idx(ordem, "pedidoPagamento"));
    assert.ok(idx(ordem, "eventoPagamento") < idx(ordem, "pedidoPagamento"));
    // pedido antes da conta
    assert.ok(idx(ordem, "pedidoPagamento") < idx(ordem, "user"));
  });

  test("token de TV sai antes do aparelho", async () => {
    const { tx, chamadas } = criarTxFake();
    await excluirDadosDaConta(tx as unknown as TxParam, "u-123");
    const ordem = chamadas.map((c) => c.modelo);
    assert.ok(idx(ordem, "tvRefreshToken") < idx(ordem, "tvDevice"));
  });

  test("apaga histórico, lista, curtidas, TV, cobrança e a conta — e nada mais", async () => {
    const { tx, chamadas } = criarTxFake();
    await excluirDadosDaConta(tx as unknown as TxParam, "u-123");
    const modelos = chamadas.map((c) => c.modelo).sort();
    assert.deepEqual(modelos, [
      "assinatura", "eventoPagamento", "like", "pedidoPagamento", "revisaoPagamento",
      "revisaoPagamentoEvento", "tvDevice", "tvRefreshToken", "user", "watchHistory", "watchlist",
    ].sort());
  });

  test("auditoria administrativa (imutável) nunca é tocada", async () => {
    const { tx, chamadas } = criarTxFake();
    await excluirDadosDaConta(tx as unknown as TxParam, "u-123");
    assert.ok(!chamadas.some((c) => c.modelo === "adminAudit"), "AdminAudit não pode ser apagado");
  });

  test("o resumo reflete as contagens de cada tabela", async () => {
    const { tx } = criarTxFake();
    const resumo = await excluirDadosDaConta(tx as unknown as TxParam, "u-123");
    assert.deepEqual(resumo, {
      watchHistory: 2, watchlist: 3, likes: 4, tvRefreshTokens: 5, tvDevices: 1,
      revisaoEventos: 6, revisoes: 7, eventosPagamento: 8, assinaturas: 9, pedidos: 10,
    });
  });

  /**
   * A prova de que a identidade é só o argumento: todo filtro aponta para o
   * `userId` recebido (direto ou pela relação). Trocar o id troca TODOS os
   * filtros — não há um segundo caminho por onde um id de corpo entraria.
   */
  test("todo filtro usa exatamente o userId recebido", async () => {
    const { tx, chamadas } = criarTxFake();
    await excluirDadosDaConta(tx as unknown as TxParam, "alvo-xyz");
    const porModelo = Object.fromEntries(chamadas.map((c) => [c.modelo, c.where]));
    assert.deepEqual(porModelo.watchHistory, { userId: "alvo-xyz" });
    assert.deepEqual(porModelo.watchlist, { userId: "alvo-xyz" });
    assert.deepEqual(porModelo.like, { userId: "alvo-xyz" });
    assert.deepEqual(porModelo.tvDevice, { userId: "alvo-xyz" });
    assert.deepEqual(porModelo.assinatura, { userId: "alvo-xyz" });
    assert.deepEqual(porModelo.pedidoPagamento, { userId: "alvo-xyz" });
    assert.deepEqual(porModelo.revisaoPagamento, { userId: "alvo-xyz" });
    // Relações: o userId é alcançado pelo pai.
    assert.deepEqual(porModelo.tvRefreshToken, { device: { userId: "alvo-xyz" } });
    assert.deepEqual(porModelo.revisaoPagamentoEvento, { revisao: { userId: "alvo-xyz" } });
    assert.deepEqual(porModelo.eventoPagamento, { pedido: { userId: "alvo-xyz" } });
    assert.deepEqual(porModelo.user, { id: "alvo-xyz" });
  });
});

// ── 5. /excluir-conta é pública ────────────────────────────────────────────────

describe("roteamento público de /excluir-conta", () => {
  test("o navegador comum alcança a página (allowlist)", () => {
    assert.deepEqual(decidirRota("/excluir-conta", "navegador"), { tipo: "segue" });
  });

  test("uma rota de streaming comum continua fechada para o navegador", () => {
    assert.deepEqual(decidirRota("/alguma-rota-de-streaming", "navegador"), { tipo: "landing" });
  });
});

// ── 6. A forma da rota ─────────────────────────────────────────────────────────

const rota = readFileSync(join(process.cwd(), "src/app/api/user/account/route.ts"), "utf8");

const codigo = (() => {
  let dentroDeBloco = false;
  return rota
    .split("\n")
    .filter((linha) => {
      const t = linha.trimStart();
      if (dentroDeBloco) {
        if (t.includes("*/")) dentroDeBloco = false;
        return false;
      }
      if (t.startsWith("/*")) {
        dentroDeBloco = !t.includes("*/");
        return false;
      }
      return !t.startsWith("//");
    })
    .join("\n");
})();

const handler = codigo.slice(codigo.indexOf("export async function DELETE"));
const posicaoDe = (trecho: string) => {
  const i = handler.indexOf(trecho);
  assert.notEqual(i, -1, `"${trecho}" não foi encontrado no handler`);
  return i;
};

describe("a rota só existe como DELETE", () => {
  test("exporta DELETE", () => {
    assert.match(codigo, /export async function DELETE\s*\(/);
  });
  test("não exporta GET, POST, PUT nem PATCH", () => {
    for (const verbo of ["GET", "POST", "PUT", "PATCH"]) {
      assert.equal(new RegExp(`export (async )?function ${verbo}\\s*\\(`).test(codigo), false, `${verbo} não pertence a esta rota`);
    }
  });
});

describe("ordem das verificações", () => {
  test("origem → sessão → limite → banco → corpo → exclusão", () => {
    const origem = posicaoDe("headerMatchesHost(origin, host)");
    const sessao = posicaoDe("getUserFromRequest(req)");
    const limite = posicaoDe("checkRateLimit(");
    const banco = posicaoDe("prisma.user.findUnique");
    const corpo = posicaoDe("readJsonBody");
    const exclusao = posicaoDe("excluirDadosDaConta(");
    assert.ok(origem < sessao, "origem antes da sessão");
    assert.ok(sessao < limite, "não se limita quem não se autenticou");
    assert.ok(limite < banco, "o limite protege o banco: vem antes da consulta");
    assert.ok(banco < corpo, "papel/existência antes de ler o corpo");
    assert.ok(corpo < exclusao, "confirmação antes de apagar qualquer coisa");
  });

  test("a sessão é decidida por sessaoPodeExcluir e o papel por papelPodeExcluir", () => {
    assert.ok(codigo.includes("sessaoPodeExcluir("));
    assert.ok(codigo.includes("papelPodeExcluir("));
    assert.ok(codigo.includes("confirmacaoValida("));
  });
});

describe("o limite de exclusão falha fechado", () => {
  test("Redis fora recusa, em vez de deixar passar", () => {
    const bloco = handler.slice(posicaoDe("checkRateLimit("), posicaoDe("prisma.user.findUnique"));
    assert.ok(bloco.includes("catch"), "a falha de Redis precisa ser tratada");
    assert.ok(/erro\(503/.test(bloco), "e precisa recusar com indisponível");
  });

  test("as chaves de limite são próprias da exclusão", () => {
    assert.ok(codigo.includes("account:delete:user:"));
    assert.ok(codigo.includes("account:delete:ip:"));
  });
});

describe("a identidade vem só da sessão", () => {
  test("o userId vem de `usuario`, nunca de corpo/query/header", () => {
    assert.match(handler, /userId\s*=\s*usuario/);
    for (const fonte of ["corpo.userId", "searchParams", "nextUrl", "req.url", 'headers.get("x-user', "body.userId", "query."]) {
      assert.equal(codigo.includes(fonte), false, `${fonte} não pode decidir quem é excluído`);
    }
  });

  test("o corpo só alimenta a confirmação", () => {
    // `corpo` aparece em readJsonBody (atribuição) e em confirmacaoValida(corpo).
    assert.ok(codigo.includes("confirmacaoValida(corpo)"));
    assert.equal(/corpo\.\w+/.test(codigo), false, "nenhum campo do corpo além da confirmação é lido");
  });
});

describe("nada de PII, nada do Play como autorização", () => {
  test("a rota não lê nem registra dado pessoal", () => {
    for (const pii of ["email", "senhaHash", "telefone", "documento", "avatar", ".nome"]) {
      assert.equal(codigo.includes(pii), false, `${pii} não pertence a esta rota`);
    }
  });

  test("o marcador do Play não autoriza nem bloqueia a exclusão", () => {
    for (const play of ["ehClientePlay", "ObaflixPlay"]) {
      assert.equal(codigo.includes(play), false, `${play} não pode decidir exclusão de conta`);
    }
  });

  test("toda resposta é no-store", () => {
    const respostas = codigo.match(/NextResponse\.json\(/g) ?? [];
    const comNoStore = codigo.match(/headers:\s*NO_STORE/g) ?? [];
    assert.equal(respostas.length, comNoStore.length, "toda resposta precisa de NO_STORE");
    assert.ok(respostas.length > 0);
  });

  test("os eventos de auditoria são só os técnicos da exclusão", () => {
    assert.ok(codigo.includes("account_delete_requested"));
    assert.ok(codigo.includes("account_delete_completed"));
    assert.ok(codigo.includes("account_delete_rejected"));
  });
});

// ── 7. Grounding dos efeitos pós-exclusão (não executável sem banco) ───────────
//
// Login e refresh de TV pós-exclusão dependem de banco e NextAuth; sem
// DATABASE_URL aqui, a garantia é verificada na fonte. São consequências diretas
// da remoção da linha `User` e dos `TvRefreshToken`.

describe("login pós-exclusão falha por construção", () => {
  const auth = readFileSync(join(process.cwd(), "src/lib/auth.ts"), "utf8");
  test("authorize busca a conta por e-mail e recusa quando não existe", () => {
    assert.ok(auth.includes("prisma.user.findUnique({ where: { email } })"));
    assert.ok(/if \(!user\)[\s\S]{0,120}return null/.test(auth), "sem linha de User, o login retorna null");
  });
  test("o login Google também exige a conta local", () => {
    assert.ok(/if \(!local\) return false/.test(auth));
  });
});

// ── 8. Revogação imediata de sessão (blocker FECHADO) + mitigação de cache ─────
//
// A sessão do Obaflix é um JWT stateless de 30 dias; `normalizarToken` só
// decodifica, sem provar que a linha `User` existe. Sozinho, um cookie (ou Bearer
// de TV) emitido ANTES da exclusão continuaria "autenticando" DEPOIS dela. O fecho
// é central e barato: `src/lib/sessionRevocation.ts` grava um cutoff por `userId`
// no Redis e `getUserFromRequest` + o callback `session` de `auth.ts` recusam
// `iat <= cutoff`. A exclusão grava o cutoff ANTES da transação destrutiva.
//
// A prova de ponta a ponta (token antigo recusado, token novo aceito, fail-closed,
// playback com monetização off deixando de devolver PERMITIDO) vive em
// `sessionRevocation.test.ts`. Aqui ficam o motivo (decodificação pura) e a ordem
// na rota (cutoff antes de apagar).

describe("revogação de sessão: motivo e ordem na exclusão", () => {
  test("normalizarToken decodifica o JWT mesmo de conta apagada — por isso o cutoff é necessário", () => {
    const u = normalizarToken({ id: "conta-apagada", role: "user" }, "cookie");
    assert.deepEqual(u, { userId: "conta-apagada", role: "user", origem: "cookie", deviceId: null });
  });

  test("a exclusão grava o cutoff de revogação ANTES da transação destrutiva", () => {
    const revog = posicaoDe("revogarSessoesDoUsuario(");
    const transacao = posicaoDe("prisma.$transaction");
    assert.ok(revog < transacao, "o cutoff tem de ser gravado antes de qualquer linha ser apagada");
  });

  test("se o cutoff não persistir, 503 e a conta NÃO é apagada", () => {
    const bloco = handler.slice(posicaoDe("revogarSessoesDoUsuario("), posicaoDe("prisma.$transaction"));
    assert.ok(/catch[\s\S]{0,180}erro\(503/.test(bloco), "falha ao revogar recusa com 503 antes de apagar");
  });
});

describe("MITIGAÇÃO: a exclusão invalida o cache de entitlement", () => {
  test("invalida o cache DEPOIS da transação (nunca antes do commit)", () => {
    assert.ok(codigo.includes("invalidarEntitlements("), "a exclusão precisa invalidar o cache");
    assert.ok(
      posicaoDe("prisma.$transaction") < posicaoDe("invalidarEntitlements("),
      "o cache só pode ser invalidado depois do commit",
    );
  });

  test("falha de invalidação é auditada, sem derrubar a exclusão já concluída", () => {
    const bloco = handler.slice(posicaoDe("invalidarEntitlements("));
    assert.ok(
      /catch[\s\S]{0,140}billing_entitlements_invalidation_failed/.test(bloco),
      "falha de cache é auditada e não vira erro de exclusão",
    );
  });
});

describe("AdminAudit: SET NULL (PR #74) e o ex-admin agora excluível, sem apagar auditoria", () => {
  const fonte = readFileSync(join(process.cwd(), "src/lib/account/deletion.ts"), "utf8");
  test("a ordem de exclusão nunca inclui AdminAudit (auditoria é imutável)", () => {
    // Nenhuma operação de delegate sobre adminAudit no orquestrador: o comentário
    // cita `AdminAudit.adminUserId`, mas não há `tx.adminAudit`.
    assert.equal(fonte.includes("tx.adminAudit"), false, "AdminAudit não pode ser apagado");
  });
  test("o comentário documenta SET NULL e o ex-admin rebaixado agora excluível", () => {
    assert.ok(fonte.includes("AdminAudit"));
    assert.ok(/SET NULL/i.test(fonte), "a FK agora é SET NULL (PR #74), não mais NO ACTION");
    assert.ok(/ex-admin|rebaixado/i.test(fonte), "o caso do ex-admin precisa estar documentado");
  });
  test("ex-admin rebaixado (role != admin) passa o portão de papel e apaga User sem tocar AdminAudit", async () => {
    // O portão de papel só barra `admin`; um ex-admin rebaixado a 'moderador'/'user'
    // passa. A transação apaga a linha `User` — e, pela FK SET NULL, a auditoria
    // fica com `adminUserId = null` em vez de derrubar a exclusão (o antigo blocker).
    assert.deepEqual(papelPodeExcluir("moderador"), { ok: true });
    const { tx, chamadas } = criarTxFake();
    await excluirDadosDaConta(tx as unknown as TxParam, "ex-admin-1");
    assert.ok(chamadas.some((c) => c.modelo === "user" && c.op === "delete"), "User é apagado");
    assert.ok(!chamadas.some((c) => c.modelo === "adminAudit"), "AdminAudit nunca é apagado");
  });
});
