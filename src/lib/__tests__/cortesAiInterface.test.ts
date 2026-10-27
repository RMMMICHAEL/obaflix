import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";

const text = readFileSync(new URL("../../components/player/CustomPlayer.tsx", import.meta.url), "utf8");
const source = ts.createSourceFile("CustomPlayer.tsx", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let panel = "", request = "", permissionEffect = "";
function visit(node: ts.Node) {
  if (ts.isJsxElement(node) && node.openingElement.getText(source) === '<div className="mb-2">' && node.getText(source).includes('aria-label="Pedido ao Cortes AI"')) panel = node.getText(source);
  if (ts.isVariableDeclaration(node) && node.name.getText(source) === "pedirCortesIA" && node.initializer && ts.isCallExpression(node.initializer)) request = node.initializer.arguments[0].getText(source);
  if (ts.isCallExpression(node) && node.expression.getText(source) === "useEffect" && node.arguments[0]?.getText(source).includes('fetch("/api/billing/me"')) permissionEffect = node.arguments[0].getText(source);
  ts.forEachChild(node, visit);
}
visit(source);
assert.ok(panel && request, "bloco AI e handler devem existir");
const code = ts.transpileModule(`module.exports = (props: any) => { const { podeUsarIA, pedindoIA, pedidoIA, setPedidoIA, pedirCortesIA } = props; return (${panel}); };`, { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS } }).outputText;
const scope = { exports: {}, module: { exports: {} }, require: createRequire(import.meta.url) };
runInNewContext(code, scope);
const Panel = scope.module.exports as (props: Record<string, unknown>) => ReturnType<typeof createElement>;

for (const level of ["nenhum", "individual", "lote", "ia"]) {
  test(`Cortes AI visível; permissão ${level}`, async () => {
    const allowed = level === "ia";
    const html = renderToStaticMarkup(createElement(Panel, { podeUsarIA: allowed, pedindoIA: false, pedidoIA: "momentos de tensão", setPedidoIA() {}, pedirCortesIA() {} }));
    assert.match(html, /Cortes AI/);
    assert.equal(/<textarea[^>]*\sdisabled=""/.test(html), !allowed);
    assert.equal(/<button[^>]*\sdisabled=""/.test(html), !allowed);
    assert.equal(html.includes("requer permissão do plano Cortes AI"), !allowed);
    if (!allowed) {
      let calls = 0;
      const handler = runInNewContext(`(${request})`, { podeUsarIA: false, pedindoIA: false, pedidoIA: "momentos de tensão", fetch() { calls++; } });
      await handler();
      assert.equal(calls, 0, "sem permissão, o handler não pode fazer chamadas");
    }
  });
}

for (const plan of ["cortes-ai", "cortes-start", "cortes-pro"]) {
  test(`direito ${plan} chega com menu fechado e Vários trechos aberto`, async () => {
    const values: boolean[] = [];
    const effect = runInNewContext(`(${permissionEffect})`, {
      showDownload: false, multiCenasAtivo: true, AbortController,
      setTemAssinaturaIA(value: boolean) { values.push(value); },
      fetch: async () => ({ ok: true, json: async () => ({ cortes: { plano: { id: plan } } }) }),
    });
    const cleanup = effect();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(values, [false, plan === "cortes-ai"]);
    cleanup();
  });
}

test("editor fechado não consulta nem concede direito AI", () => {
  let calls = 0;
  const values: boolean[] = [];
  const effect = runInNewContext(`(${permissionEffect})`, {
    multiCenasAtivo: false, setTemAssinaturaIA(value: boolean) { values.push(value); },
    fetch() { calls++; },
  });
  effect();
  assert.deepEqual(values, [false]);
  assert.equal(calls, 0);
});
