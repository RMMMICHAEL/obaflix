import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  BASE_BLACKCAT_PADRAO,
  lerConfiguracao,
  provedorComConfiguracao,
} from "../billing/blackcat";
import type { PedidoParaProvedor } from "../billing/pedidos";

const PEDIDO: PedidoParaProvedor = {
  refExterna: "ref-postback-teste",
  valorCentavos: 1890,
  moeda: "BRL",
  descricao: "Plus — Mensal",
  pagador: {
    nome: "Fulano de Tal",
    email: "fulano@example.test",
    telefone: "11999999999",
    documento: {
      numero: "12345678901",
      tipo: "cpf",
    },
  },
};

function respostaCriacao() {
  return new Response(
    JSON.stringify({
      success: true,
      data: {
        transactionId: "TXN-POSTBACK-TESTE",
        status: "PENDING",
        amount: 1890,
        paymentData: {
          qrCode: "qr-teste",
          copyPaste: "pix-copia-teste",
          expiresAt: new Date(Date.now() + 3600_000).toISOString(),
        },
      },
    }),
    {
      status: 201,
      headers: {
        "Content-Type": "application/json",
      },
    },
  );
}

describe("postback Blackcat", () => {
  test("confirmacao desligada nao configura postback", () => {
    const config = lerConfiguracao({
      BLACKCAT_API_KEY: "teste",
      BLACKCAT_CONFIRMACAO_ATIVA: "false",
      NEXTAUTH_URL: "https://obaflix.online",
      BLACKCAT_WEBHOOK_PATH_SECRET: "segredo",
    });

    assert.ok(config);
    assert.equal(config.postbackUrl, undefined);
  });

  test("confirmacao ativa monta postback HTTPS e codifica o segredo", () => {
    const config = lerConfiguracao({
      BLACKCAT_API_KEY: "teste",
      BLACKCAT_CONFIRMACAO_ATIVA: "true",
      NEXTAUTH_URL: "https://obaflix.online/",
      BLACKCAT_WEBHOOK_PATH_SECRET: "a/b c?d",
    });

    assert.ok(config);

    assert.equal(
      config.postbackUrl,
      "https://obaflix.online/api/billing/webhook/blackcat/a%2Fb%20c%3Fd",
    );
  });

  test("confirmacao ativa falha fechada com configuracao de webhook invalida", () => {
    const casos: Array<Record<string, string | undefined>> = [
      {
        BLACKCAT_API_KEY: "teste",
        BLACKCAT_CONFIRMACAO_ATIVA: "true",
        NEXTAUTH_URL: "https://obaflix.online",
      },
      {
        BLACKCAT_API_KEY: "teste",
        BLACKCAT_CONFIRMACAO_ATIVA: "true",
        NEXTAUTH_URL: "https://obaflix.online",
        BLACKCAT_WEBHOOK_PATH_SECRET: "   ",
      },
      {
        BLACKCAT_API_KEY: "teste",
        BLACKCAT_CONFIRMACAO_ATIVA: "true",
        BLACKCAT_WEBHOOK_PATH_SECRET: "segredo",
      },
      {
        BLACKCAT_API_KEY: "teste",
        BLACKCAT_CONFIRMACAO_ATIVA: "true",
        NEXTAUTH_URL: "nao-e-url",
        BLACKCAT_WEBHOOK_PATH_SECRET: "segredo",
      },
      {
        BLACKCAT_API_KEY: "teste",
        BLACKCAT_CONFIRMACAO_ATIVA: "true",
        NEXTAUTH_URL: "http://obaflix.online",
        BLACKCAT_WEBHOOK_PATH_SECRET: "segredo",
      },
    ];

    for (const env of casos) {
      assert.equal(lerConfiguracao(env), null);
    }
  });

  test("create-sale envia somente o postback definido pelo servidor", async () => {
    let corpo: Record<string, unknown> | undefined;

    const buscar: typeof fetch = async (_input, init) => {
      corpo = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      return respostaCriacao();
    };

    const pedidoPoluido = {
      ...PEDIDO,
      postbackUrl: "https://evil.example/webhook",
    } as PedidoParaProvedor & { postbackUrl: string };

    const resultado = await provedorComConfiguracao(
      {
        apiKey: "teste",
        baseUrl: BASE_BLACKCAT_PADRAO,
        postbackUrl:
          "https://obaflix.online/api/billing/webhook/blackcat/segredo-servidor",
      },
      buscar,
    ).criarVenda(pedidoPoluido);

    assert.equal(resultado.ok, true);

    assert.equal(
      corpo?.postbackUrl,
      "https://obaflix.online/api/billing/webhook/blackcat/segredo-servidor",
    );

    assert.notEqual(
      corpo?.postbackUrl,
      pedidoPoluido.postbackUrl,
    );
  });

  test("create-sale omite postback quando confirmacao nao esta configurada", async () => {
    let corpo: Record<string, unknown> | undefined;

    const buscar: typeof fetch = async (_input, init) => {
      corpo = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      return respostaCriacao();
    };

    const resultado = await provedorComConfiguracao(
      {
        apiKey: "teste",
        baseUrl: BASE_BLACKCAT_PADRAO,
      },
      buscar,
    ).criarVenda(PEDIDO);

    assert.equal(resultado.ok, true);
    assert.equal("postbackUrl" in (corpo ?? {}), false);
  });
});