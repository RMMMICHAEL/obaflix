/**
 * Prova, contra o Worker realmente publicado, que "arm + fetch" funciona.
 *
 *   npx tsx scripts/verificar-arm-no-edge.ts <manifestUrl-da-concessao>
 *
 * ## Por que isto existe, e por que é obrigatório antes de ativar
 *
 * O desenho de canais depende de a página do player e a mídia serem buscadas do
 * **mesmo IP de saída**: o provider guarda um grant por par (IP, canal), e o
 * Worker arma e busca na mesma invocação contando com isso.
 *
 * "Mesma invocação" **não é promessa contratual de IP de egress estável na
 * Cloudflare.** IP de egress dedicado é recurso à parte, e a plataforma pode
 * sair por endereços diferentes. Se sair, o sintoma não é vazamento — é 403
 * teimoso, ou um canal que só toca de vez em quando, que é justamente o tipo de
 * falha que se descobre tarde e se debuga mal.
 *
 * Então: rodar isto contra o Worker que vai servir o Obaflix, e olhar o
 * resultado, faz parte da ativação. Não dá para inferir do código.
 *
 * ## O que este script faz
 *
 * Pede o manifesto ao edge várias vezes seguidas, cada uma como uma requisição
 * nova, e reporta a taxa de sucesso. Cada requisição é uma invocação do Worker,
 * possivelmente noutro ponto de presença — é exatamente o cenário que precisa
 * ser provado.
 *
 *   100% de 200      → arm + fetch funciona no Worker publicado
 *   mistura de 403   → o egress varia; ver as saídas em `docs/canais-fase-a.md`
 *   100% de 403      → a sessão venceu, a allowlist está vazia, ou o canal caiu
 *
 * ## Como obter o `manifestUrl`
 *
 * Chame `POST /api/canais/{id}/play` autenticado e copie o campo `manifestUrl`
 * da resposta. Ele vale poucos minutos — rode este script logo em seguida.
 *
 * O script **não** imprime a URL, nem host de CDN, nem query: só status e
 * contagem. Colar a saída num chamado não vaza nada.
 */

const TENTATIVAS = 12;
const INTERVALO_MS = 1500;

function uso(): never {
  console.error("uso: npx tsx scripts/verificar-arm-no-edge.ts <manifestUrl>");
  console.error("     (o campo `manifestUrl` de POST /api/canais/{id}/play)");
  process.exit(1);
}

async function main() {
  const bruto = process.argv[2];
  if (!bruto) uso();

  let url: URL;
  try {
    url = new URL(bruto);
  } catch {
    uso();
  }
  if (url.protocol !== "https:") uso();

  console.log(`edge: ${url.host}`);
  console.log(`${TENTATIVAS} requisições, ${INTERVALO_MS} ms de intervalo\n`);

  const contagem = new Map<string, number>();
  let manifestosValidos = 0;

  for (let i = 1; i <= TENTATIVAS; i++) {
    let rotulo: string;
    try {
      const r = await fetch(url.toString(), {
        headers: { Accept: "application/vnd.apple.mpegurl,*/*" },
        signal: AbortSignal.timeout(20_000),
      });
      rotulo = String(r.status);
      if (r.ok) {
        const corpo = await r.text();
        if (corpo.startsWith("#EXTM3U")) {
          manifestosValidos++;
          // Confere de graça o que o edge promete: nada de host de terceiro no
          // que ele serve. Não imprime o achado, só o fato.
          const absolutas = corpo.match(/https?:\/\/[^\s"',]+/gi) ?? [];
          const forasteira = absolutas.some((u) => {
            try {
              return new URL(u).origin !== url.origin;
            } catch {
              return true;
            }
          });
          if (forasteira) rotulo = "200 MAS VAZOU HOST DE TERCEIRO";
        } else {
          rotulo = "200 sem #EXTM3U";
        }
      }
    } catch (e) {
      rotulo = e instanceof Error && e.name === "TimeoutError" ? "timeout" : "erro de rede";
    }
    contagem.set(rotulo, (contagem.get(rotulo) ?? 0) + 1);
    process.stdout.write(`  ${String(i).padStart(2)}/${TENTATIVAS}  ${rotulo}\n`);
    if (i < TENTATIVAS) await new Promise((r) => setTimeout(r, INTERVALO_MS));
  }

  console.log("\nresumo:");
  for (const [rotulo, n] of [...contagem].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(3)}×  ${rotulo}`);
  }

  const vazou = [...contagem.keys()].some((k) => k.includes("VAZOU"));
  console.log("");
  if (vazou) {
    console.log("REPROVADO: o manifesto servido contém host que não é do edge.");
    process.exitCode = 1;
  } else if (manifestosValidos === TENTATIVAS) {
    console.log("APROVADO: arm + fetch funciona no Worker publicado.");
  } else if (manifestosValidos === 0) {
    console.log("REPROVADO: nenhuma tentativa trouxe manifesto.");
    console.log("  Confira, nesta ordem: a concessão ainda é válida (vale poucos");
    console.log("  minutos); CANAIS_PLAYER_ALLOWLIST e CDN_ALLOWLIST preenchidas no");
    console.log("  Worker; o canal está no ar no provedor.");
    process.exitCode = 1;
  } else {
    console.log(`INCONCLUSIVO: ${manifestosValidos}/${TENTATIVAS} trouxeram manifesto.`);
    console.log("  Sucesso intermitente é o sintoma esperado de egress variável —");
    console.log("  o arm vale para o IP que armou, e a busca seguinte saiu por outro.");
    console.log("  Ver as saídas em docs/canais-fase-a.md antes de ativar.");
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
