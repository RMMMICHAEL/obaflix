/**
 * Curadoria de canais: decidir nível, categoria e publicação — sem editar
 * código e sem refazer o import.
 *
 *   # ver o estado atual
 *   npx tsx scripts/canais-curadoria.ts --listar
 *   npx tsx scripts/canais-curadoria.ts --listar --categoria abertos
 *
 *   # um canal
 *   npx tsx scripts/canais-curadoria.ts --slug globosp --nivel gratuito --ativar --aplicar
 *
 *   # vários de uma vez (a allowlist de teste, por exemplo)
 *   npx tsx scripts/canais-curadoria.ts --slug globosp,sbtsp,cultura --nivel gratuito --ativar --aplicar
 *
 *   # tirar do ar sem perder a curadoria
 *   npx tsx scripts/canais-curadoria.ts --slug hbo --desativar --aplicar
 *
 *   # exportar / reimportar a matriz inteira
 *   npx tsx scripts/canais-curadoria.ts --exportar > canais.csv
 *   npx tsx scripts/canais-curadoria.ts --importar canais.csv --aplicar
 *
 * ## O que este script é, e o que ele não é
 *
 * É a única ferramenta que escreve `nivelMinimo` e `ativo`. Toda escrita marca
 * `nivelRevisado = true`, que é o que faz `importar-canais.ts` parar de mexer
 * naquela linha para sempre.
 *
 * Não é um caminho para publicar canal adulto. `--ativar` num canal com
 * `adulto = true` é recusado aqui, e o CHECK `Canal_adulto_fora_do_catalogo`
 * recusaria no banco de qualquer forma. Enquanto não existir perfil com PIN,
 * não há bandeira que contorne.
 *
 * Sem `--aplicar` nada é gravado: imprime o que faria e sai.
 */

import { readFileSync } from "fs";
import { prisma } from "../src/lib/prisma";
import { CANAIS_NIVEIS } from "../src/lib/planos";
import { CATEGORIAS_DE_CANAL, ehCategoriaDeCanal } from "../src/lib/canais/catalogo";

function arg(nome: string): string | undefined {
  const i = process.argv.indexOf(`--${nome}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function flag(nome: string): boolean {
  return process.argv.includes(`--${nome}`);
}

const NIVEIS = CANAIS_NIVEIS as readonly string[];

async function listar(categoria?: string) {
  const canais = await prisma.canal.findMany({
    where: categoria ? { categoria } : {},
    select: {
      slug: true,
      nome: true,
      categoria: true,
      nivelMinimo: true,
      nivelRevisado: true,
      ativo: true,
      adulto: true,
    },
    orderBy: [{ categoria: "asc" }, { ordem: "asc" }],
  });

  const larg = Math.max(12, ...canais.map((c) => c.slug.length));
  console.log(
    `${"slug".padEnd(larg)}  ${"categoria".padEnd(20)}  ${"nivel".padEnd(9)}  rev  ativo  adulto  nome`,
  );
  for (const c of canais) {
    console.log(
      `${c.slug.padEnd(larg)}  ${c.categoria.padEnd(20)}  ${c.nivelMinimo.padEnd(9)}  ` +
        `${c.nivelRevisado ? " ✓ " : " · "}  ${c.ativo ? " ✓  " : " ·  "}  ` +
        `${c.adulto ? "  ✓   " : "  ·   "}  ${c.nome}`,
    );
  }

  const porNivel = new Map<string, number>();
  for (const c of canais) porNivel.set(c.nivelMinimo, (porNivel.get(c.nivelMinimo) ?? 0) + 1);
  console.log(
    `\n  ${canais.length} canais · ${canais.filter((c) => c.ativo).length} no ar · ` +
      `${canais.filter((c) => c.nivelRevisado).length} revisados`,
  );
  console.log(
    `  por nível: ${[...porNivel].map(([n, q]) => `${n}=${q}`).join("  ")}`,
  );
}

async function exportar() {
  const canais = await prisma.canal.findMany({
    select: { slug: true, nivelMinimo: true, ativo: true, categoria: true, nome: true },
    orderBy: [{ categoria: "asc" }, { ordem: "asc" }],
  });
  console.log("slug,nivelMinimo,ativo,categoria,nome");
  for (const c of canais) {
    // Nome pode ter vírgula. Aspas duplicadas, como manda o CSV.
    console.log(
      `${c.slug},${c.nivelMinimo},${c.ativo},${c.categoria},"${c.nome.replace(/"/g, '""')}"`,
    );
  }
}

async function importarCsv(arquivo: string, aplicar: boolean) {
  const linhas = readFileSync(arquivo, "utf-8").split(/\r?\n/).filter(Boolean).slice(1);
  let ok = 0;
  const problemas: string[] = [];

  for (const linha of linhas) {
    const m = /^([^,]+),([^,]+),([^,]+),([^,]+),(.*)$/.exec(linha);
    if (!m) {
      problemas.push(`linha ilegível: ${linha.slice(0, 60)}`);
      continue;
    }
    const [, slug, nivelMinimo, ativoBruto, categoria, nomeBruto] = m;
    const nome = nomeBruto.replace(/^"|"$/g, "").replace(/""/g, '"');
    const ativo = ativoBruto.trim() === "true";

    if (!NIVEIS.includes(nivelMinimo)) {
      problemas.push(`${slug}: nível "${nivelMinimo}" fora de ${NIVEIS.join("|")}`);
      continue;
    }
    if (!ehCategoriaDeCanal(categoria) || categoria === "todos") {
      problemas.push(`${slug}: categoria "${categoria}" inválida`);
      continue;
    }

    const canal = await prisma.canal.findUnique({
      where: { slug },
      select: { id: true, adulto: true },
    });
    if (!canal) {
      problemas.push(`${slug}: não existe (rode o import primeiro)`);
      continue;
    }
    if (canal.adulto && ativo) {
      problemas.push(`${slug}: adulto não pode ser ativado nesta fase`);
      continue;
    }

    ok++;
    if (aplicar) {
      await prisma.canal.update({
        where: { id: canal.id },
        data: { nivelMinimo, ativo, categoria, nome, nivelRevisado: true },
      });
    }
  }

  console.log(`${aplicar ? "APLICADO" : "SIMULAÇÃO"}: ${ok} linha(s) válidas`);
  for (const p of problemas) console.log(`  ! ${p}`);
}

async function editar(slugs: string[], aplicar: boolean) {
  const nivel = arg("nivel");
  const categoria = arg("categoria");
  const ativar = flag("ativar");
  const desativar = flag("desativar");

  if (nivel && !NIVEIS.includes(nivel)) {
    throw new Error(`--nivel precisa ser um de: ${NIVEIS.join(", ")}`);
  }
  if (categoria && (!ehCategoriaDeCanal(categoria) || categoria === "todos")) {
    throw new Error(`--categoria precisa ser uma de: ${CATEGORIAS_DE_CANAL.slice(1).join(", ")}`);
  }
  if (ativar && desativar) throw new Error("--ativar e --desativar são exclusivos");
  if (!nivel && !categoria && !ativar && !desativar) {
    throw new Error("nada a fazer: informe --nivel, --categoria, --ativar ou --desativar");
  }

  for (const slug of slugs) {
    const canal = await prisma.canal.findUnique({
      where: { slug },
      select: { id: true, nome: true, nivelMinimo: true, ativo: true, adulto: true },
    });
    if (!canal) {
      console.log(`  ! ${slug}: não existe`);
      continue;
    }
    if (canal.adulto && ativar) {
      console.log(`  ! ${slug}: adulto, não pode ser ativado nesta fase`);
      continue;
    }

    const novoNivel = nivel ?? canal.nivelMinimo;
    const novoAtivo = ativar ? true : desativar ? false : canal.ativo;

    console.log(
      `  ${slug}: nivel ${canal.nivelMinimo} → ${novoNivel}` +
        `, ativo ${canal.ativo} → ${novoAtivo}` +
        (categoria ? `, categoria → ${categoria}` : ""),
    );

    if (aplicar) {
      await prisma.canal.update({
        where: { id: canal.id },
        data: {
          nivelMinimo: novoNivel,
          ativo: novoAtivo,
          ...(categoria ? { categoria } : {}),
          // Toda escrita daqui é decisão humana. É esta marca que faz o import
          // parar de mexer nesta linha.
          nivelRevisado: true,
        },
      });
    }
  }
  if (!aplicar) console.log("\n  SIMULAÇÃO — use --aplicar para gravar");
}

async function main() {
  const aplicar = flag("aplicar");

  if (flag("listar")) return listar(arg("categoria"));
  if (flag("exportar")) return exportar();

  const csv = arg("importar");
  if (csv) return importarCsv(csv, aplicar);

  const slugs = (arg("slug") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (slugs.length === 0) {
    console.error("uso: veja o cabeçalho de scripts/canais-curadoria.ts");
    process.exit(1);
  }
  return editar(slugs, aplicar);
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
