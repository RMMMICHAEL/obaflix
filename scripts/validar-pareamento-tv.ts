/**
 * Validação ponta a ponta do pareamento de TV.
 *
 * Percorre o caminho feliz inteiro e, no meio dele, tenta cada abuso que o
 * desenho promete barrar. Um passo que passe quando deveria falhar conta como
 * falha — é isso que separa "funciona" de "está seguro".
 *
 * Rodar com o servidor de pesenvolvimento no ar:
 *   npx tsx scripts/validar-pareamento-tv.ts http://localhost:3005
 */
import crypto from "crypto";
import { encode } from "next-auth/jwt";
import { prisma } from "../src/lib/prisma";

const BASE = process.argv[2] ?? "http://localhost:3000";
const SEGREDO = process.env.NEXTAUTH_SECRET!;
const UA_TV = "ObaflixTV/0.1.0 (Android 13; TesteAutomatizado)";

let passou = 0;
let falhou = 0;

function checa(nome: string, condicao: boolean, detalhe = "") {
  if (condicao) {
    passou++;
    console.log(`  ok   ${nome}${detalhe ? "  — " + detalhe : ""}`);
  } else {
    falhou++;
    console.log(`  XX   ${nome}${detalhe ? "  — " + detalhe : ""}`);
  }
}

function fingerprintFalso(semente: string): string {
  return crypto.createHash("sha256").update(semente).digest("hex");
}

async function post(caminho: string, corpo: unknown, cabecalhos: Record<string, string> = {}) {
  const r = await fetch(`${BASE}${caminho}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": UA_TV, ...cabecalhos },
    body: JSON.stringify(corpo),
  });
  return { status: r.status, corpo: await r.json().catch(() => ({})) as any };
}

async function get(caminho: string, cabecalhos: Record<string, string> = {}) {
  const r = await fetch(`${BASE}${caminho}`, { headers: { "User-Agent": UA_TV, ...cabecalhos } });
  return { status: r.status, corpo: await r.json().catch(() => ({})) as any };
}

async function main() {
  const usuario = await prisma.user.findFirst({ select: { id: true, role: true, email: true } });
  if (!usuario) throw new Error("nenhum usuário no banco para testar");
  console.log(`conta de teste: ${usuario.email.replace(/(.{2}).*(@.*)/, "$1***$2")}\n`);

  // Cookie de sessão do site, igual ao que o NextAuth emite no login.
  const cookieSessao = await encode({
    token: { id: usuario.id, role: usuario.role },
    secret: SEGREDO,
    maxAge: 3600,
  });
  const comCookie = { Cookie: `next-auth.session-token=${cookieSessao}` };

  const fp = fingerprintFalso("aparelho-de-teste");
  const fpOutro = fingerprintFalso("outro-aparelho");

  // ── 1. Iniciar ────────────────────────────────────────────────────────────
  console.log("1. Iniciar pareamento na TV");
  const inicio = await post("/api/tv/pair/start", { fingerprint: fp, modelo: "Teste TV Box" });
  checa("start responde 200", inicio.status === 200);
  const { userCode, deviceCode, urlQrCode } = inicio.corpo;
  checa("userCode tem 8 caracteres", userCode?.length === 8, userCode);
  checa("deviceCode veio e é longo", typeof deviceCode === "string" && deviceCode.length >= 40);
  checa("QR contém apenas o código público", urlQrCode?.includes(userCode) && !urlQrCode?.includes(deviceCode), urlQrCode);
  checa(
    "nenhum token no QR",
    !/accessToken|refreshToken|eyJ/.test(urlQrCode ?? ""),
  );

  // ── 2. Poll antes da aprovação ────────────────────────────────────────────
  console.log("\n2. TV pergunta antes de alguém aprovar");
  const pend = await post("/api/tv/pair/poll", { userCode, deviceCode, fingerprint: fp });
  checa("estado pendente", pend.corpo.estado === "pendente");
  checa("nenhum token vazou no pendente", !pend.corpo.accessToken && !pend.corpo.refreshToken);

  // ── 3. Abusos no poll ─────────────────────────────────────────────────────
  console.log("\n3. Tentativas indevidas no poll");
  const errado = await post("/api/tv/pair/poll", {
    userCode, deviceCode: "deviceCode-inventado-por-terceiro", fingerprint: fp,
  });
  checa("deviceCode errado não avança", errado.corpo.estado === "expirado");

  const outroApar = await post("/api/tv/pair/poll", { userCode, deviceCode, fingerprint: fpOutro });
  checa("outro aparelho com o mesmo deviceCode não avança", outroApar.corpo.estado === "expirado");

  // ── 4. Aprovação ──────────────────────────────────────────────────────────
  console.log("\n4. Aprovação no celular");
  const semSessao = await post("/api/tv/pair/approve", { userCode });
  checa("aprovar sem sessão devolve 401", semSessao.status === 401);

  const info = await get(`/api/tv/pair/approve?c=${userCode}`, comCookie);
  checa("celular vê o aparelho antes de autorizar", info.status === 200 && !!info.corpo.modelo,
    `${info.corpo.modelo} · rede ${info.corpo.rede}`);
  checa("descrição não expõe IP inteiro", !/\d+\.\d+\.\d+\.\d+$/.test(info.corpo.rede ?? ""));

  const aprovou = await post("/api/tv/pair/approve", { userCode }, comCookie);
  checa("aprovação aceita", aprovou.status === 200 && aprovou.corpo.ok === true);

  const denovo = await post("/api/tv/pair/approve", { userCode }, comCookie);
  checa("aprovar de novo é recusado (uso único)", denovo.status === 410, denovo.corpo.erro);

  // ── 5. TV recebe a sessão ─────────────────────────────────────────────────
  console.log("\n5. TV recebe a sessão");
  const aprovado = await post("/api/tv/pair/poll", { userCode, deviceCode, fingerprint: fp });
  checa("estado aprovado", aprovado.corpo.estado === "aprovado");
  const { accessToken, refreshToken, deviceId } = aprovado.corpo;
  checa("veio accessToken", typeof accessToken === "string" && accessToken.length > 20);
  checa("veio refreshToken", typeof refreshToken === "string" && refreshToken.length > 20);

  const replay = await post("/api/tv/pair/poll", { userCode, deviceCode, fingerprint: fp });
  checa("replay do poll não entrega segunda sessão", replay.corpo.estado === "expirado");

  // ── 6. O Bearer funciona, e só o de TV ────────────────────────────────────
  console.log("\n6. Autorização por Bearer");
  const eu = await get("/api/tv/whoami", { Authorization: `Bearer ${accessToken}` });
  checa("whoami com Bearer da TV responde 200", eu.status === 200 && eu.corpo.autenticado === true);
  checa("origem reconhecida como bearer", eu.corpo.origem === "bearer", eu.corpo.origem);
  checa("whoami não devolve dado pessoal",
    !("email" in eu.corpo) && !("userId" in eu.corpo) && !("nome" in eu.corpo));

  const semNada = await get("/api/tv/whoami");
  checa("whoami sem credencial devolve 401", semNada.status === 401);

  // O caso que justifica a claim `tv`: cookie do site reenviado como Bearer.
  const cookieComoBearer = await get("/api/tv/whoami", { Authorization: `Bearer ${cookieSessao}` });
  checa("cookie do site usado como Bearer é recusado", cookieComoBearer.status === 401);

  // ── 7. Renovação com rotação ──────────────────────────────────────────────
  console.log("\n7. Renovação");
  const renovou = await post("/api/tv/session", { refreshToken, fingerprint: fp });
  checa("refresh devolve par novo", renovou.status === 200 && !!renovou.corpo.accessToken);
  checa("refresh token mudou (rotação)", renovou.corpo.refreshToken !== refreshToken);
  const refresh2 = renovou.corpo.refreshToken;

  const fpErrado = await post("/api/tv/session", { refreshToken: refresh2, fingerprint: fpOutro });
  checa("refresh de outro aparelho é recusado", fpErrado.status === 401);

  // ── 8. Detecção de reuso ──────────────────────────────────────────────────
  console.log("\n8. Reuso do refresh antigo");
  const reuso = await post("/api/tv/session", { refreshToken, fingerprint: fp });
  checa("refresh já usado é recusado", reuso.status === 401);

  const depoisDoReuso = await post("/api/tv/session", { refreshToken: refresh2, fingerprint: fp });
  checa("família inteira caiu após o reuso", depoisDoReuso.status === 401,
    "a TV precisa parear de novo — é o comportamento correto");

  // ── 9. Dispositivos e logout ──────────────────────────────────────────────
  console.log("\n9. Dispositivos e saída");
  const lista = await get("/api/tv/devices", comCookie);
  checa("lista de dispositivos responde", lista.status === 200);
  checa("a TV pareada aparece", lista.corpo.dispositivos?.some((d: any) => d.id === deviceId));
  checa("lista não expõe fingerprint nem token",
    !JSON.stringify(lista.corpo).match(/fingerprint|tokenHash|refresh/i));

  const revogou = await fetch(`${BASE}/api/tv/session`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json", ...comCookie },
    body: JSON.stringify({ deviceId }),
  });
  checa("revogar o aparelho responde 200", revogou.status === 200);

  const listaDepois = await get("/api/tv/devices", comCookie);
  checa("aparelho some da lista depois de revogado",
    !listaDepois.corpo.dispositivos?.some((d: any) => d.id === deviceId));

  // ── Limpeza ───────────────────────────────────────────────────────────────
  await prisma.tvDevice.deleteMany({ where: { fingerprint: { in: [fp, fpOutro] } } });

  console.log(`\n${"─".repeat(52)}`);
  console.log(`passou: ${passou}   falhou: ${falhou}`);
  if (falhou > 0) process.exitCode = 1;
}

main()
  .catch((e) => {
    console.error("\nerro:", e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
