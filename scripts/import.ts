import { PrismaClient } from "@prisma/client";
import fs from "fs";
import path from "path";

const prisma = new PrismaClient();

const args = process.argv.slice(2);
const getArg = (flag: string) => {
  const i = args.indexOf(flag);
  return i !== -1 ? args[i + 1] : null;
};

const BATCH = 500;

function detectTipoSerie(generoIds: number[], origemPais?: string): string {
  if (generoIds.includes(16) && origemPais === "JP") return "anime";
  if (generoIds.includes(16)) return "desenho";
  return "serie";
}

function chunks<T>(arr: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let i = 0; i < arr.length; i += size) result.push(arr.slice(i, i + size));
  return result;
}

async function importFilmes(filePath: string) {
  const filmes = JSON.parse(fs.readFileSync(filePath, "utf-8")) as any[];
  console.log(`\n Importando ${filmes.length} filmes em lotes de ${BATCH}...`);

  const generosMap = new Map<number, string>();
  for (const f of filmes) {
    for (const g of f.generos ?? []) generosMap.set(Number(g.id), g.nome);
  }
  const generosArr = Array.from(generosMap.entries()).map(([id, nome]) => ({ id, nome }));
  for (const batch of chunks(generosArr, BATCH)) {
    await prisma.genero.createMany({ data: batch, skipDuplicates: true });
  }
  console.log(`  OK ${generosArr.length} generos`);

  let ok = 0;
  for (const batch of chunks(filmes, BATCH)) {
    await prisma.filme.createMany({
      skipDuplicates: true,
      data: batch.map((f) => ({
        id: String(f.id),
        tmdbId: f.tmdb ? String(f.tmdb) : null,
        titulo: f.titulo,
        tituloOriginal: f.title ?? null,
        poster: f.poster ?? null,
        background: f.background ?? null,
        sinopse: f.sinopse ?? null,
        ano: f.ano ? Number(f.ano) : null,
        nota: f.nota ? Number(f.nota) : null,
        duracao: f.duracao ? Number(f.duracao) : null,
        urlDub: f.urlBR || null,
        urlLeg: f.urlENG || null,
      })),
    });
    ok += batch.length;
    console.log(`  ${ok}/${filmes.length} filmes`);
  }

  const fgRows: { filmeId: string; generoId: number }[] = [];
  for (const f of filmes) {
    for (const g of f.generos ?? []) {
      fgRows.push({ filmeId: String(f.id), generoId: Number(g.id) });
    }
  }
  for (const batch of chunks(fgRows, BATCH)) {
    await prisma.filmeGenero.createMany({ data: batch, skipDuplicates: true });
  }

  console.log(`  CONCLUIDO: ${ok} filmes`);
}

async function importSeries(filePath: string) {
  const series = JSON.parse(fs.readFileSync(filePath, "utf-8")) as any[];
  console.log(`\n Importando ${series.length} series em lotes de ${BATCH}...`);

  const generosMap = new Map<number, string>();
  for (const s of series) {
    for (const g of s.generos ?? []) generosMap.set(Number(g.id), g.nome);
  }
  const generosArr = Array.from(generosMap.entries()).map(([id, nome]) => ({ id, nome }));
  for (const batch of chunks(generosArr, BATCH)) {
    await prisma.genero.createMany({ data: batch, skipDuplicates: true });
  }

  let ok = 0;
  for (const batch of chunks(series, BATCH)) {
    await prisma.serie.createMany({
      skipDuplicates: true,
      data: batch.map((s) => {
        const generoIds = (s.generos ?? []).map((g: any) => Number(g.id));
        const temporadas = s.episodios?.length
          ? Math.max(...s.episodios.map((e: any) => Number(e.temp) || 1))
          : null;
        return {
          id: String(s.id),
          tmdbId: s.tmdb ? String(s.tmdb) : null,
          titulo: s.titulo,
          tituloOriginal: s.title ?? null,
          poster: s.poster ?? null,
          background: s.background ?? null,
          sinopse: s.sinopse ?? null,
          ano: s.ano ? Number(s.ano) : null,
          nota: s.nota ? Number(s.nota) : null,
          temporadas,
          tipo: detectTipoSerie(generoIds, s.origemPais),
        };
      }),
    });
    ok += batch.length;
    console.log(`  ${ok}/${series.length} series`);
  }

  const sgRows: { serieId: string; generoId: number }[] = [];
  for (const s of series) {
    for (const g of s.generos ?? []) {
      sgRows.push({ serieId: String(s.id), generoId: Number(g.id) });
    }
  }
  for (const batch of chunks(sgRows, BATCH)) {
    await prisma.serieGenero.createMany({ data: batch, skipDuplicates: true });
  }
  console.log(`  CONCLUIDO: ${ok} series`);

  console.log(`\n Importando episodios...`);
  const episodios: any[] = [];
  for (const s of series) {
    for (const ep of s.episodios ?? []) {
      episodios.push({
        id: String(ep.id),
        serieId: String(s.id),
        numeroEp: Number(ep.ep),
        temporada: Number(ep.temp),
        titulo: ep.nome ?? null,
        thumbnail: ep.bg ?? null,
        urlDub: ep.urlBR || null,
        urlLeg: ep.urlENG || null,
      });
    }
  }

  let epOk = 0;
  for (const batch of chunks(episodios, BATCH)) {
    await prisma.episodio.createMany({ data: batch, skipDuplicates: true });
    epOk += batch.length;
    console.log(`  ${epOk}/${episodios.length} episodios`);
  }
  console.log(`  CONCLUIDO: ${epOk} episodios`);
}

async function main() {
  const filmesPath = getArg("--filmes");
  const seriesPath = getArg("--series");

  if (!filmesPath && !seriesPath) {
    console.log("Uso: npx tsx scripts/import.ts --filmes filmes_completo.json --series series_completo.json");
    process.exit(1);
  }

  const start = Date.now();
  if (filmesPath) await importFilmes(path.resolve(filmesPath));
  if (seriesPath) await importSeries(path.resolve(seriesPath));

  const mins = ((Date.now() - start) / 60000).toFixed(1);
  console.log(`\nConcluido em ${mins} minutos`);
  await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
