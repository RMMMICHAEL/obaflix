import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * Sair da conta em /conta.
 *
 * Lê o arquivo em vez de renderizar: o que importa aqui são duas promessas de
 * código — usar o logout que já existe (NextAuth), e não apagar nada que o
 * aparelho guardou. Downloads vivem no armazenamento nativo do app; nenhum
 * logout do site pode tocá-los.
 */
const pagina = readFileSync("src/app/conta/page.tsx", "utf8");

test("/conta oferece Sair da conta pelo signOut do NextAuth, voltando ao login", () => {
  assert.match(pagina, /import\s*\{[^}]*\bsignOut\b[^}]*\}\s*from\s*"next-auth\/react"/);
  assert.match(pagina, /signOut\(\s*\{\s*callbackUrl:\s*"\/login"\s*\}\s*\)/);
  assert.ok(pagina.includes("Sair da conta"), "botão sem o rótulo pedido");
});

test("sair da conta não apaga downloads nem armazenamento local", () => {
  for (const proibido of [
    "localStorage.clear",
    "sessionStorage.clear",
    "indexedDB",
    "cancelDownload",
    "cancelarDownload",
    "_obaflixMedia",
    "caches.delete",
  ]) {
    assert.ok(!pagina.includes(proibido), `/conta não pode chamar ${proibido} ao sair`);
  }
});

test("Sair da conta fica no topo, junto do perfil, antes do plano e da lista", () => {
  const botao = pagina.indexOf("Sair da conta");
  assert.ok(botao > pagina.indexOf("session.user?.email"), "o botão precisa vir junto do nome/e-mail");
  assert.ok(botao < pagina.indexOf("Meu plano"), "o botão não pode descer para depois do plano");
  assert.ok(botao < pagina.indexOf("Minha Lista"), "o botão não pode ficar depois da lista de filmes/séries");
  assert.equal(pagina.split("Sair da conta").length - 1, 1, "só pode existir um botão de sair");
});
