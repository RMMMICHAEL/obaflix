/**
 * Importa canais ao vivo de um arquivo de varredura para `Canal`/`CanalFonte`.
 *
 *   npx tsx scripts/importar-canais.ts <arquivo.json>            # simulação
 *   npx tsx scripts/importar-canais.ts <arquivo.json> --aplicar  # grava
 *
 * ## As quatro regras que este script não quebra
 *
 * 1. **Não grava `.m3u8`.** O arquivo de entrada traz `media_url`, e ele é
 *    lido só para conferir que o canal respondeu. A URL não entra no banco: ela
 *    é descoberta **transitória** — pode mudar/rotacionar de um momento para o
 *    outro —, e gravá-la trataria como permanente algo que não é. A identidade
 *    estável é `provider` + `providerChannelId`; a mídia atual resolve-se a cada
 *    sessão (e o edge re-resolve quando ela falha). Ver `src/lib/canais/resolver.ts`.
 *
 * 2. **Todo canal entra `premium` e desativado.** Não há inferência de nível
 *    por categoria, por nome, nem por ser "24h". Um canal importado é o mais
 *    restrito que existe até alguém decidir o contrário na mão. O CHECK
 *    `Canal_ativo_exige_revisao` da migration recusa publicar sem essa decisão.
 *
 * 3. **Não sobrescreve curadoria.** Linha com `nivelRevisado = true` tem
 *    `nivelMinimo`, `ativo`, `categoria` e `nome` preservados. O import
 *    atualiza só o ponteiro para o provider — que é o que muda quando o
 *    provider mexe no catálogo dele.
 *
 * 4. **Canal adulto entra marcado e fica fora.** `adulto = true` e
 *    `ativo = false`, sem exceção e sem flag para contornar. Enquanto não
 *    existir perfil com PIN parental, não há caminho para ele aparecer.
 *
 * A categoria **é** inferida, e isso não contradiz a regra 2: categoria é
 * prateleira, não permissão. Quem decide acesso é `nivelMinimo`, e esse nunca
 * sai de `premium` sozinho.
 */

import { readFileSync } from "fs";
import { prisma } from "../src/lib/prisma";
import { ehIdDeProviderValido } from "../src/lib/canais/providers";
import type { CategoriaDeCanal } from "../src/lib/canais/catalogo";

interface LinhaDaVarredura {
  id?: string;
  player_url?: string;
  status?: string;
  media_url?: string;
  tipo?: string;
}

/**
 * Canais que não entram no catálogo desta fase.
 *
 * Lista explícita, por id do provider. Não é regex sobre o nome: `adultswim` é
 * bloco de animação do Cartoon Network e seria capturado por qualquer padrão
 * que procurasse "adult" — o tipo de falso positivo que tira um canal legítimo
 * do ar sem ninguém entender por quê.
 */
const IDS_ADULTOS = new Set(["playboy", "sexyhot"]);

/**
 * Nome de exibição e categoria, por id do provider.
 *
 * O que não estiver aqui entra com o id prettificado e categoria
 * `variedades` — visível na simulação, para a curadoria corrigir. Deixar cair
 * num padrão visível é melhor do que adivinhar em silêncio.
 */
const CATALOGO: Record<string, { nome: string; categoria: CategoriaDeCanal }> = {
  // Abertos
  globosp: { nome: "Globo SP", categoria: "abertos" },
  globorj: { nome: "Globo RJ", categoria: "abertos" },
  globomg: { nome: "Globo MG", categoria: "abertos" },
  globors: { nome: "Globo RS", categoria: "abertos" },
  globoes: { nome: "Globo ES", categoria: "abertos" },
  globoce: { nome: "Globo CE", categoria: "abertos" },
  globope: { nome: "Globo PE", categoria: "abertos" },
  globopb: { nome: "Globo PB", categoria: "abertos" },
  globoam: { nome: "Globo AM", categoria: "abertos" },
  sbtsp: { nome: "SBT SP", categoria: "abertos" },
  sbtrj: { nome: "SBT RJ", categoria: "abertos" },
  recordsp: { nome: "Record SP", categoria: "abertos" },
  recordrj: { nome: "Record RJ", categoria: "abertos" },
  recordmg: { nome: "Record MG", categoria: "abertos" },
  bandsp: { nome: "Band SP", categoria: "abertos" },
  bandrj: { nome: "Band RJ", categoria: "abertos" },
  cultura: { nome: "TV Cultura", categoria: "abertos" },
  aparecida: { nome: "TV Aparecida", categoria: "abertos" },
  cancaonova: { nome: "Canção Nova", categoria: "abertos" },

  // Notícias
  globonews: { nome: "GloboNews", categoria: "noticias" },
  cnnbrasil: { nome: "CNN Brasil", categoria: "noticias" },
  bandnews: { nome: "BandNews", categoria: "noticias" },

  // Esportes
  sportv: { nome: "SporTV", categoria: "esportes" },
  sportv2: { nome: "SporTV 2", categoria: "esportes" },
  sportv3: { nome: "SporTV 3", categoria: "esportes" },
  sportv4: { nome: "SporTV 4", categoria: "esportes" },
  bandsports: { nome: "BandSports", categoria: "esportes" },
  combate: { nome: "Combate", categoria: "esportes" },
  espn: { nome: "ESPN", categoria: "esportes" },
  espn2: { nome: "ESPN 2", categoria: "esportes" },
  espn3: { nome: "ESPN 3", categoria: "esportes" },
  espn4: { nome: "ESPN 4", categoria: "esportes" },
  espn5: { nome: "ESPN 5", categoria: "esportes" },
  espn6: { nome: "ESPN 6", categoria: "esportes" },
  xsports: { nome: "X Sports", categoria: "esportes" },
  ufcfightpass: { nome: "UFC Fight Pass", categoria: "esportes" },
  premiere: { nome: "Premiere", categoria: "esportes" },
  premiere2: { nome: "Premiere 2", categoria: "esportes" },
  premiere3: { nome: "Premiere 3", categoria: "esportes" },
  premiere4: { nome: "Premiere 4", categoria: "esportes" },
  premiere5: { nome: "Premiere 5", categoria: "esportes" },
  premiere6: { nome: "Premiere 6", categoria: "esportes" },
  premiere7: { nome: "Premiere 7", categoria: "esportes" },
  premiere8: { nome: "Premiere 8", categoria: "esportes" },
  caze1: { nome: "CazéTV 1", categoria: "esportes" },
  caze2: { nome: "CazéTV 2", categoria: "esportes" },
  caze3: { nome: "CazéTV 3", categoria: "esportes" },

  // Filmes & Séries
  hbo: { nome: "HBO", categoria: "filmes-series" },
  hbo2: { nome: "HBO 2", categoria: "filmes-series" },
  hbofamily: { nome: "HBO Family", categoria: "filmes-series" },
  hbomundi: { nome: "HBO Mundi", categoria: "filmes-series" },
  hbopop: { nome: "HBO Pop", categoria: "filmes-series" },
  hboplus: { nome: "HBO Plus", categoria: "filmes-series" },
  hboxtreme: { nome: "HBO Xtreme", categoria: "filmes-series" },
  max1: { nome: "Max 1", categoria: "filmes-series" },
  max2: { nome: "Max 2", categoria: "filmes-series" },
  max3: { nome: "Max 3", categoria: "filmes-series" },
  telecineaction: { nome: "Telecine Action", categoria: "filmes-series" },
  telecinecult: { nome: "Telecine Cult", categoria: "filmes-series" },
  telecinefun: { nome: "Telecine Fun", categoria: "filmes-series" },
  telecinepipoca: { nome: "Telecine Pipoca", categoria: "filmes-series" },
  telecinepremium: { nome: "Telecine Premium", categoria: "filmes-series" },
  telecinetouch: { nome: "Telecine Touch", categoria: "filmes-series" },
  megapix: { nome: "Megapix", categoria: "filmes-series" },
  cinemax: { nome: "Cinemax", categoria: "filmes-series" },
  tnt: { nome: "TNT", categoria: "filmes-series" },
  tntseries: { nome: "TNT Séries", categoria: "filmes-series" },
  tntnovelas: { nome: "TNT Novelas", categoria: "filmes-series" },
  space: { nome: "Space", categoria: "filmes-series" },
  tcm: { nome: "TCM", categoria: "filmes-series" },
  axn: { nome: "AXN", categoria: "filmes-series" },
  amc: { nome: "AMC", categoria: "filmes-series" },
  sonychannel: { nome: "Sony Channel", categoria: "filmes-series" },
  starchannel: { nome: "Star Channel", categoria: "filmes-series" },
  studiouniversal: { nome: "Studio Universal", categoria: "filmes-series" },
  universaltv: { nome: "Universal TV", categoria: "filmes-series" },
  warnerchannel: { nome: "Warner Channel", categoria: "filmes-series" },
  paramountplus: { nome: "Paramount+ 1", categoria: "filmes-series" },
  paramountplus2: { nome: "Paramount+ 2", categoria: "filmes-series" },
  primevideo: { nome: "Prime Video 1", categoria: "filmes-series" },
  primevideo2: { nome: "Prime Video 2", categoria: "filmes-series" },
  primevideo3: { nome: "Prime Video 3", categoria: "filmes-series" },
  primevideo4: { nome: "Prime Video 4", categoria: "filmes-series" },
  disneyplus1: { nome: "Disney+ 1", categoria: "filmes-series" },
  disneyplus2: { nome: "Disney+ 2", categoria: "filmes-series" },
  disneyplus3: { nome: "Disney+ 3", categoria: "filmes-series" },
  globonovelas: { nome: "Globo Novelas", categoria: "filmes-series" },

  // Infantil
  cartoonnetwork: { nome: "Cartoon Network", categoria: "infantil" },
  cartoonito: { nome: "Cartoonito", categoria: "infantil" },
  gloob: { nome: "Gloob", categoria: "infantil" },
  discoverykids: { nome: "Discovery Kids", categoria: "infantil" },
  adultswim: { nome: "Adult Swim", categoria: "infantil" },

  // Documentários
  discoverychannel: { nome: "Discovery Channel", categoria: "documentarios" },
  discoveryhh: { nome: "Discovery H&H", categoria: "documentarios" },
  discoveryid: { nome: "Discovery ID", categoria: "documentarios" },
  discoveryscience: { nome: "Discovery Science", categoria: "documentarios" },
  discoverytheather: { nome: "Discovery Theater", categoria: "documentarios" },
  discoveryturbo: { nome: "Discovery Turbo", categoria: "documentarios" },
  discoveryworld: { nome: "Discovery World", categoria: "documentarios" },
  animalplanet: { nome: "Animal Planet", categoria: "documentarios" },
  history: { nome: "History", categoria: "documentarios" },
  history2: { nome: "History 2", categoria: "documentarios" },
  ae: { nome: "A&E", categoria: "documentarios" },

  // Variedades
  multishow: { nome: "Multishow", categoria: "variedades" },
  gnt: { nome: "GNT", categoria: "variedades" },
  mtv: { nome: "MTV", categoria: "variedades" },
  tlc: { nome: "TLC", categoria: "variedades" },
  off: { nome: "Off", categoria: "variedades" },

  // Culinária & Lifestyle
  foodnetwork: { nome: "Food Network", categoria: "culinaria-lifestyle" },
  masterchef: { nome: "MasterChef", categoria: "culinaria-lifestyle" },
  hgtv: { nome: "HGTV", categoria: "culinaria-lifestyle" },

  // 24h
  "24h_chaves": { nome: "24h Chaves", categoria: "24h" },
  "24h_dragonball": { nome: "24h Dragon Ball", categoria: "24h" },
  "24h_naruto": { nome: "24h Naruto", categoria: "24h" },
  "24h_simpsons": { nome: "24h Simpsons", categoria: "24h" },
  "24h_odeiachris": { nome: "24h Todo Mundo Odeia o Chris", categoria: "24h" },
  acasadopatrao1: { nome: "A Casa do Patrão 1", categoria: "24h" },
  acasadopatrao2: { nome: "A Casa do Patrão 2", categoria: "24h" },
  acasadopatrao3: { nome: "A Casa do Patrão 3", categoria: "24h" },
  acasadopatrao4: { nome: "A Casa do Patrão 4", categoria: "24h" },
  acasadopatrao5: { nome: "A Casa do Patrão 5", categoria: "24h" },

  // Internacionais (Portugal)
  pt_abola: { nome: "A Bola TV", categoria: "internacionais" },
  pt_benficatv: { nome: "Benfica TV", categoria: "internacionais" },
  pt_canal11: { nome: "Canal 11", categoria: "internacionais" },
  pt_eleven1: { nome: "Eleven 1", categoria: "internacionais" },
  pt_eleven2: { nome: "Eleven 2", categoria: "internacionais" },
  pt_eleven3: { nome: "Eleven 3", categoria: "internacionais" },
  pt_sportv1: { nome: "Sport TV 1 (PT)", categoria: "internacionais" },
  pt_sportv2: { nome: "Sport TV 2 (PT)", categoria: "internacionais" },
  pt_sportv3: { nome: "Sport TV 3 (PT)", categoria: "internacionais" },
  pt_sportv4: { nome: "Sport TV 4 (PT)", categoria: "internacionais" },
  pt_sportv5: { nome: "Sport TV 5 (PT)", categoria: "internacionais" },
  pt_sportv6: { nome: "Sport TV 6 (PT)", categoria: "internacionais" },
  pt_sportv7: { nome: "Sport TV 7 (PT)", categoria: "internacionais" },
};

function prettificar(id: string): string {
  return id
    .replace(/^pt_/, "")
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function slugificar(id: string): string {
  return id.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

async function main() {
  const [arquivo, ...resto] = process.argv.slice(2);
  const aplicar = resto.includes("--aplicar");
  if (!arquivo) {
    console.error("uso: tsx scripts/importar-canais.ts <arquivo.json> [--aplicar]");
    process.exit(1);
  }

  const bruto = JSON.parse(readFileSync(arquivo, "utf-8")) as LinhaDaVarredura[];
  if (!Array.isArray(bruto)) throw new Error("arquivo não é uma lista");

  let criados = 0;
  let atualizados = 0;
  let preservados = 0;
  let ignorados = 0;
  const semCatalogo: string[] = [];

  for (const [i, linha] of bruto.entries()) {
    const providerChannelId = linha.id;
    if (!providerChannelId || !ehIdDeProviderValido(providerChannelId)) {
      ignorados++;
      continue;
    }
    // `status` e `media_url` são só evidência de que o canal respondeu na
    // varredura. Nenhum dos dois entra no banco.
    if (linha.status !== "OK" || !linha.media_url) {
      ignorados++;
      continue;
    }

    const conhecido = CATALOGO[providerChannelId];
    if (!conhecido) semCatalogo.push(providerChannelId);

    const slug = slugificar(providerChannelId);
    const adulto = IDS_ADULTOS.has(providerChannelId);
    const existente = await prisma.canal.findUnique({
      where: { slug },
      select: { id: true, nivelRevisado: true },
    });

    if (existente?.nivelRevisado) {
      preservados++;
      if (aplicar) {
        // Só o ponteiro para o provider. Nome, categoria, nível e `ativo` são
        // da curadoria, e o import não opina sobre eles.
        await prisma.canalFonte.upsert({
          where: { canalId: existente.id },
          create: { canalId: existente.id, provider: "megafrix", providerChannelId },
          update: { provider: "megafrix", providerChannelId },
        });
      }
      continue;
    }

    if (existente) atualizados++;
    else criados++;

    if (!aplicar) continue;

    const canal = await prisma.canal.upsert({
      where: { slug },
      create: {
        slug,
        nome: conhecido?.nome ?? prettificar(providerChannelId),
        categoria: conhecido?.categoria ?? "variedades",
        // As três invariantes da regra 2 e da regra 4, escritas juntas para
        // ficar óbvio que nenhuma depende de configuração.
        nivelMinimo: "premium",
        nivelRevisado: false,
        ativo: false,
        adulto,
        ordem: i,
      },
      update: {
        nome: conhecido?.nome ?? prettificar(providerChannelId),
        categoria: conhecido?.categoria ?? "variedades",
        adulto,
        ordem: i,
      },
      select: { id: true },
    });

    await prisma.canalFonte.upsert({
      where: { canalId: canal.id },
      create: { canalId: canal.id, provider: "megafrix", providerChannelId },
      update: { provider: "megafrix", providerChannelId },
    });
  }

  console.log(aplicar ? "APLICADO" : "SIMULAÇÃO (use --aplicar para gravar)");
  console.log(`  criados:     ${criados}`);
  console.log(`  atualizados: ${atualizados}`);
  console.log(`  preservados: ${preservados}  (nivelRevisado = true, curadoria intacta)`);
  console.log(`  ignorados:   ${ignorados}`);
  if (semCatalogo.length) {
    console.log(`\n  sem nome/categoria no CATALOGO (entram como "variedades"):`);
    console.log(`    ${semCatalogo.join(", ")}`);
  }
  console.log(
    `\n  Todos entram premium e desativados. Publique com:` +
      `\n    npx tsx scripts/canais-curadoria.ts --slug <slug> --nivel <nivel> --ativar --aplicar`,
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
