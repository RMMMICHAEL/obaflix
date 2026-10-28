import { prisma } from "../src/lib/prisma";
import { reenviarEmailCompra } from "../src/lib/billing/reenviarEmailCompra";

// Dry-run por padrão; --apply envia somente o e-mail de um pedido PAGO.
async function main() {
  const pedidoId = process.argv.find(a => a.startsWith("--pedido="))?.slice(9);
  if (!pedidoId || !/^[A-Za-z0-9_-]{1,64}$/.test(pedidoId)) throw new Error("Use --pedido=ID [--apply]");
  const aplicar = process.argv.includes("--apply");
  const r = await reenviarEmailCompra(pedidoId, aplicar ? {} : { notificar: async () => ({ ok: true, simulado: true }) });
  console.log(r.ok ? (!aplicar ? "DRY_RUN_OK" : r.simulado ? "EMAIL_SIMULADO" : "EMAIL_ENVIADO") : `FALHA:${r.motivo}`);
  if (!r.ok) process.exitCode = 1;
}
main().catch(() => { console.error("FALHA_REENVIO"); process.exitCode = 1; }).finally(() => prisma.$disconnect());
