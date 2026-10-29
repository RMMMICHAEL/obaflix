import assert from "node:assert/strict";
import test from "node:test";

test("CSP permite o Meta Pixel sem afrouxar o resto", async () => {
  const config = (await import("../../../next.config.mjs")).default as { headers(): Promise<{ headers: { key: string; value: string }[] }[]> };
  const csp = (await config.headers()).flatMap((h) => h.headers).find((h) => h.key === "Content-Security-Policy")!.value;
  const diretiva = (nome: string) => csp.split(";").map((d) => d.trim()).find((d) => d.startsWith(nome + " "))!.split(" ");
  assert.ok(diretiva("script-src").includes("https://connect.facebook.net"));
  assert.ok(diretiva("img-src").includes("https://www.facebook.com"));
  // Restrições existentes preservadas.
  assert.ok(csp.includes("default-src 'self'") && csp.includes("object-src 'none'") && csp.includes("base-uri 'self'"));
  assert.ok(!diretiva("script-src").includes("https:") && !diretiva("img-src").includes("https:"));
});
