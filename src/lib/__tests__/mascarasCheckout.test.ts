import { test } from "node:test";
import assert from "node:assert/strict";
import { mascararCheckout } from "../billing/mascarasCheckout";
import { cpfValido, telefoneBrasileiroValido, soDigitos } from "../billing/pagador";

test("CPF progressivo pontua cada grupo e limita a onze dígitos", () => {
  for (const [entrada, esperado] of [["1", "1"], ["123", "123."], ["123456", "123.456."], ["123456789", "123.456.789-"], ["12345678901234", "123.456.789-01"]]) {
    assert.equal(mascararCheckout("cpf", entrada).valor, esperado);
  }
  let valor = "";
  for (const digito of "52998224725") valor = mascararCheckout("cpf", valor + digito).valor;
  assert.equal(valor, "529.982.247-25");
  assert.equal(cpfValido(valor), true);
  assert.equal(soDigitos(valor), "52998224725");
});

test("telefone aceita fixo, celular, colagem internacional e DDD 55 nacional", () => {
  for (const [entrada, esperado] of [["1", "(1"], ["11", "(11) "], ["113456", "(11) 3456-"], ["1134567890", "(11) 3456-7890"], ["11987654321", "(11) 98765-4321"], ["+55 (11) 98765-4321", "(11) 98765-4321"], ["551134567890", "(11) 3456-7890"], ["55987654321", "(55) 98765-4321"], ["+55 11 98765-4321 999", "(11) 98765-4321"]]) {
    assert.equal(mascararCheckout("telefone", entrada).valor, esperado);
  }
  let valor = "";
  for (const digito of "11987654321") valor = mascararCheckout("telefone", valor + digito).valor;
  assert.equal(valor, "(11) 98765-4321");
  assert.equal(telefoneBrasileiroValido(valor), true);
  assert.equal(soDigitos(valor), "11987654321");
  assert.equal(mascararCheckout("telefone", "(55) 98765-43219").valor, "(55) 98765-4321");
});

test("backspace e delete sobre pontuação removem dígitos sem prender o cursor", () => {
  assert.deepEqual(mascararCheckout("cpf", "123", 3, "deleteContentBackward", "123."), { valor: "12", cursor: 2 });
  assert.deepEqual(mascararCheckout("cpf", "123456.789-01", 3, "deleteContentBackward", "123.456.789-01"), { valor: "124.567.890-1", cursor: 2 });
  assert.deepEqual(mascararCheckout("cpf", "123456.789-01", 3, "deleteContentForward", "123.456.789-01"), { valor: "123.567.890-1", cursor: 4 });
  const apagado = mascararCheckout("telefone", "(11) 98765-432", 14, "deleteContentBackward", "(11) 98765-4321");
  assert.equal(apagado.valor, "(11) 9876-5432");
  assert.equal(apagado.cursor, apagado.valor.length);
});

test("edição no meio e colagem preservam a posição entre dígitos", () => {
  assert.deepEqual(mascararCheckout("cpf", "1293.456.", 3, "insertText", "123.456."), { valor: "129.345.6", cursor: 4 });
  assert.deepEqual(mascararCheckout("cpf", "529.082.247-25", 5, "insertText", "529.982.247-25"), { valor: "529.082.247-25", cursor: 5 });
  assert.deepEqual(mascararCheckout("telefone", "+55 (11) 98765-4321", 19, "insertFromPaste"), { valor: "(11) 98765-4321", cursor: 15 });
  assert.deepEqual(mascararCheckout("cpf", "", 0, "deleteContentBackward", "1"), { valor: "", cursor: 0 });
  assert.equal(cpfValido(mascararCheckout("cpf", "11111111111").valor), false);
});

test("backspace repetido apaga CPF e telefone completos até o campo vazio", () => {
  for (const campo of ["cpf", "telefone"] as const) {
    let atual = mascararCheckout(campo, "11987654321");
    for (let restantes = 10; restantes >= 0; restantes--) {
      const entrada = atual.valor.slice(0, atual.cursor - 1) + atual.valor.slice(atual.cursor);
      atual = mascararCheckout(campo, entrada, atual.cursor - 1, "deleteContentBackward", atual.valor);
      assert.equal(soDigitos(atual.valor).length, restantes);
      assert.equal(atual.cursor, atual.valor.length);
    }
    assert.deepEqual(atual, { valor: "", cursor: 0 });
  }
});
