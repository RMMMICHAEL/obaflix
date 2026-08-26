/**
 * Matriz do webcine: filme, série e animes, com todas as fontes de cada um.
 *
 * Roda o extrator de verdade (src/lib/cinevs.ts), fonte por fonte, e reporta
 * áudio, premium, locked, legendas, formato final e se a mídia pode ir direto
 * ao CDN. Nenhum conteúdo é baixado.
 *
 * Uso:  npx tsx scripts/matriz-webcine.ts
 */

export {};

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { loadEnvConfig } = require("@next/env");
loadEnvConfig(process.cwd(), true, { info: () => {}, error: console.error });

import { extractCineVs, type CineVsFonte } from "../src/lib/cinevs";

type Caso = {
  rotulo: string;
  tmdbId: string;
  type: "movie" | "tv";
  season?: number;
  episode?: number;
  titleHint: string;
};

const CASOS: Caso[] = [
  { rotulo: "FILME  A Origem", tmdbId: "27205", type: "movie", titleHint: "A Origem" },
  { rotulo: "SÉRIE  Dexter S1E1", tmdbId: "1405", type: "tv", season: 1, episode: 1, titleHint: "Dexter" },
  { rotulo: "ANIME  Hunter x Hunter S1E1", tmdbId: "46298", type: "tv", season: 1, episode: 1, titleHint: "Hunter x Hunter" },
  { rotulo: "ANIME  Jujutsu Kaisen S1E1", tmdbId: "95479", type: "tv", season: 1, episode: 1, titleHint: "Jujutsu Kaisen" },
  // Achados por scripts/achar-casos-webcine.ts: audio legendado e legenda externa.
  { rotulo: "ANIME  ONIMAI S1E1 (legendado)", tmdbId: "198152", type: "tv", season: 1, episode: 1, titleHint: "ONIMAI" },
  { rotulo: "FILME  Attack on Titan (legenda)", tmdbId: "1333100", type: "movie", titleHint: "Attack on Titan: O ÚLTIMO ATAQUE" },
];

type Linha = {
  caso: string;
  fonte: string;
  videoId: number;
  audio: string;
  premium: boolean;
  locked: boolean;
  disponivel: boolean;
  formato: string;
  host: string;
  legendas: number;
  cors: boolean;
  entrega: string;
  resultado: string;
};

(async () => {
  const linhas: Linha[] = [];

  for (const c of CASOS) {
    process.stderr.write(`\n=== ${c.rotulo} ===\n`);

    // Primeira extração: descobre a lista de fontes (sem escolher nenhuma).
    let fontes: CineVsFonte[] = [];
    try {
      const primeira = await extractCineVs({ ...c, diagnostic: true });
      if (!primeira) {
        linhas.push({
          caso: c.rotulo, fonte: "—", videoId: 0, audio: "—", premium: false, locked: false,
          disponivel: false, formato: "—", host: "—", legendas: 0, cors: false,
          entrega: "—", resultado: "NÃO ENCONTRADO",
        });
        continue;
      }
      fontes = primeira.fontes;
    } catch (e: any) {
      linhas.push({
        caso: c.rotulo, fonte: "—", videoId: 0, audio: "—", premium: false, locked: false,
        disponivel: false, formato: "—", host: "—", legendas: 0, cors: false,
        entrega: "—", resultado: `ERRO: ${String(e.message).slice(0, 40)}`,
      });
      continue;
    }

    // Depois, uma extração por fonte — exatamente o que o menu de servidor faz.
    for (const f of fontes) {
      const base = {
        caso: c.rotulo,
        fonte: f.label,
        videoId: f.videoId,
        audio: f.audioType,
        premium: f.isPremium,
        locked: f.locked,
        disponivel: f.disponivel,
      };

      if (!f.disponivel) {
        linhas.push({
          ...base, formato: "—", host: "—", legendas: 0, cors: false,
          entrega: "—", resultado: `INDISPONÍVEL (${f.motivoIndisponivel})`,
        });
        continue;
      }

      try {
        const r = await extractCineVs({ ...c, videoId: f.videoId, diagnostic: true });
        if (!r) {
          linhas.push({ ...base, formato: "—", host: "—", legendas: 0, cors: false, entrega: "—", resultado: "falhou" });
          continue;
        }
        const direto = r.format !== "HLS" || r.corsLiberado;
        linhas.push({
          ...base,
          formato: r.format,
          host: r.mediaHost,
          legendas: r.subtitles.length,
          cors: r.corsLiberado,
          entrega: direto ? "DIRETO" : "proxy",
          resultado: "ok",
        });
      } catch (e: any) {
        linhas.push({ ...base, formato: "—", host: "—", legendas: 0, cors: false, entrega: "—", resultado: `erro: ${String(e.message).slice(0, 30)}` });
      }
    }
  }

  console.log("\n\n================ MATRIZ WEBCINE ================\n");
  const col = (v: string | number, n: number) => String(v).padEnd(n).slice(0, n);
  console.log(
    col("CONTEÚDO", 28) + col("FONTE", 18) + col("VIDEO ID", 10) + col("ÁUDIO", 9) +
    col("PREM", 6) + col("LOCK", 6) + col("FORMATO", 9) + col("LEG", 5) + col("ENTREGA", 9) + "RESULTADO",
  );
  console.log("-".repeat(128));
  let casoAnterior = "";
  for (const l of linhas) {
    console.log(
      col(l.caso === casoAnterior ? "" : l.caso, 28) +
      col(l.fonte, 18) + col(l.videoId || "—", 10) + col(l.audio, 9) +
      col(l.premium ? "sim" : "não", 6) + col(l.locked ? "SIM" : "não", 6) +
      col(l.formato, 9) + col(l.legendas, 5) + col(l.entrega, 9) + l.resultado,
    );
    casoAnterior = l.caso;
  }

  const ok = linhas.filter((l) => l.resultado === "ok");
  const diretas = ok.filter((l) => l.entrega === "DIRETO");
  console.log("\n" + "-".repeat(128));
  console.log(`fontes testadas: ${linhas.length} | extraíram: ${ok.length} | entrega direta: ${diretas.length}/${ok.length}`);
  console.log(`com legendas .: ${ok.filter((l) => l.legendas > 0).length}`);
  console.log(`indisponíveis : ${linhas.filter((l) => !l.disponivel).length} (nenhuma tentativa de contorno)`);
})();
