import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { acaoNoPlanoCortes } from "../billing/checkout";
import { cpfValido, cnpjValido, nomeCompletoValido, telefoneBrasileiroValido, montarPagador, pagadorCaktoValido } from "../billing/pagador";
import { pilotoCaktoAdminPermitido } from "../billing/cakto";
import { emitirConsultaVisitante, consultaVisitanteValida } from "../billing/statusVisitante";

const segredo = "s".repeat(40);

test("checkout Cortes só aponta para a rota dedicada, sem alterar checkout tradicional", () => {
  assert.deepEqual(acaoNoPlanoCortes("cortes-start", { logado: false, atual: null }), { acao: "assinar", href: "/cortes/checkout?planoId=cortes-start" });
  assert.deepEqual(acaoNoPlanoCortes("cortes-pro", { logado: true, atual: "cortes-start" }), { acao: "upgrade", href: "/cortes/checkout?planoId=cortes-pro&conta=1" });
  const antigo = readFileSync("src/app/checkout/page.tsx", "utf-8");
  assert.match(antigo, /export default function CheckoutPage/);
  const dedicado = readFileSync("src/app/cortes/checkout/CheckoutCortes.tsx", "utf-8");
  assert.match(dedicado, /data-obaflix-landing/);
  assert.doesNotMatch(dedicado, /CAKTO_PILOTO_TOKEN|x-obaflix-cakto-piloto|NEXT_PUBLIC_.*TOKEN/);
});

test("validação Cakto rejeita CPF falso e aceita documentos com dígitos verificadores", () => {
  assert.equal(cpfValido("529.982.247-25"), true);
  assert.equal(cpfValido("111.444.777-35"), true);
  for (const invalid of ["123.456.789-01", "111.111.111-11", "00000000000", "123", ""]) assert.equal(cpfValido(invalid), false);
  assert.equal(cnpjValido("11.222.333/0001-81"), true);
  assert.equal(cnpjValido("11.222.333/0001-82"), false);
  assert.equal(nomeCompletoValido("Maria da Silva"), true);
  assert.equal(nomeCompletoValido("M"), false);
  assert.equal(telefoneBrasileiroValido("(11) 98765-4321"), true);
  assert.equal(telefoneBrasileiroValido("00123456789"), false);
  const completo = montarPagador(
    { nome: "Apelido", email: "comprador@exemplo.test" },
    { nome: "Maria da Silva", documento: "529.982.247-25", telefone: "11987654321" },
    { preferirNomeInformado: true },
  );
  assert.equal(completo?.nome, "Maria da Silva");
  assert.ok(completo && pagadorCaktoValido(completo));
  assert.equal(montarPagador({ nome: null, email: "comprador@exemplo.test" }, { documento: "52998224725", telefone: "11987654321" }, { preferirNomeInformado: true }), null);
});

test("piloto no navegador exige admin por cookie e confirmado no banco, sem token no browser", () => {
  const env = { CAKTO_PILOTO_TOKEN: segredo, CAKTO_VENDAS_PUBLICAS: "false" };
  assert.equal(pilotoCaktoAdminPermitido("cortes-start", { origem: "cookie", role: "admin" }, "admin", env), true);
  for (const role of ["user", undefined]) assert.equal(pilotoCaktoAdminPermitido("cortes-start", { origem: "cookie", role: "admin" }, role, env), false);
  assert.equal(pilotoCaktoAdminPermitido("cortes-start", { origem: "bearer", role: "admin" }, "admin", env), false);
  assert.equal(pilotoCaktoAdminPermitido("cortes-pro", { origem: "cookie", role: "admin" }, "admin", env), false);
  assert.equal(pilotoCaktoAdminPermitido("cortes-start", { origem: "cookie", role: "admin" }, "admin", {}), false);
});

test("consulta de visitante é específica de um pedido e expira", () => {
  const agora = 1790000000000;
  const token = emitirConsultaVisitante("pedido-1", segredo, agora);
  assert.ok(token);
  assert.equal(consultaVisitanteValida("pedido-1", token, segredo, agora + 60000), true);
  assert.equal(consultaVisitanteValida("pedido-2", token, segredo, agora + 60000), false);
  assert.equal(consultaVisitanteValida("pedido-1", token, segredo, agora + 3 * 60 * 60 * 1000), false);
  assert.equal(consultaVisitanteValida("pedido-1", token, "outra-chave".repeat(5), agora), false);
});

test("piloto fechado recusa visitantes, papéis divergentes, AI e token ausente ou curto", () => {
  for (const planoId of ["cortes-start", "cortes-pro", "cortes-ai"]) {
    for (const usuario of [null, { origem: "cookie", role: "user" }, { origem: "cookie", role: "admin" }, { origem: "bearer", role: "admin" }]) {
      for (const roleBanco of [null, "user", "admin"]) {
        for (const token of [undefined, "s".repeat(31), segredo]) {
          const permitido = planoId === "cortes-start" && usuario?.origem === "cookie" && usuario.role === "admin" && roleBanco === "admin" && token === segredo;
          assert.equal(pilotoCaktoAdminPermitido(planoId, usuario, roleBanco, { CAKTO_VENDAS_PUBLICAS: "false", CAKTO_PILOTO_TOKEN: token }), permitido);
        }
      }
    }
  }
});


test("consulta de visitante permanece autorizavel apos vincular usuario na confirmacao", () => {
  // Regressao: em confirmarPedidoPorId, o pedido passa a ter userId.
  // A restricao de guest precisa considerar a origem (emailComprador), nao userId nulo.
  const fonte = readFileSync("src/app/api/billing/orders/guest-status/route.ts", "utf-8");
  assert.match(fonte, /emailComprador:\s*\{\s*not:\s*null\s*\}/);
  assert.doesNotMatch(fonte, /userId:\s*null/);
});
test("CTA Cortes: compra visivel, checkout com total Pix e acessibilidade", () => {
  const planos = readFileSync("src/app/cortes/PlanosCortes.tsx", "utf8");
  const estilos = readFileSync("src/app/cortes/cortes.module.css", "utf8");
  const checkout = readFileSync("src/app/cortes/checkout/CheckoutCortes.tsx", "utf8");
  assert.match(planos, /Quero o/);
  assert.match(planos, /data-cortes-cta/);
  assert.match(estilos, /\.planList \.planBuy \{/);
  assert.match(estilos, /\.planBuy:focus-visible/);
  assert.match(checkout, /Gerar Pix de/);
  assert.match(checkout, /dinheiro\(totalPix\(preco\.precoCentavos, id\), preco\.moeda\)/);
  assert.match(checkout, /disabled=\{!!bloqueado/);
});
