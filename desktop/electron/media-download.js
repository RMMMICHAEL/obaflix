"use strict";

// ── Download de mídia (processo principal do Electron) ────────────────────────
//
// Roda aqui e não no renderer por dois motivos: os CDNs exigem Referer/Origin do
// embed, que o navegador não deixa forjar, e os segmentos vêm de dezenas de hosts
// diferentes, o que no renderer esbarraria em CORS a cada um.
//
// Não há transcodificação. Os dois formatos que os provedores usam hoje aceitam
// concatenação direta:
//   - fMP4  (WatchPlay): init do EXT-X-MAP + segmentos = .mp4 fragmentado válido
//   - MPEG-TS (EmbedPlayer): segmentos crus concatenados = .ts válido
// Ambos abrem em VLC/MPV e podem ser remuxados depois sem recodificar.
//
// O Content-Type não serve para nada aqui: os provedores entregam vídeo rotulado
// como text/css e application/javascript. A identificação é pelos bytes.

const fs = require("fs");
const path = require("path");

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/122.0.0.0 Safari/537.36 ObaflixDesktop/1.0";

const TIMEOUT_MANIFESTO_MS = 20000;
const TIMEOUT_SEGMENTO_MS = 45000;
const TENTATIVAS_POR_SEGMENTO = 3;
/** Quantos segmentos são buscados à frente. A escrita continua em ordem. */
const JANELA_PARALELA = 4;

function cabecalhos(referer, extras) {
  const h = { "User-Agent": UA, Accept: "*/*", ...(extras || {}) };
  if (referer) {
    h.Referer = referer;
    try { h.Origin = new URL(referer).origin; } catch { /**/ }
  }
  return h;
}

async function baixarTexto(url, referer) {
  const r = await fetch(url, {
    headers: cabecalhos(referer),
    signal: AbortSignal.timeout(TIMEOUT_MANIFESTO_MS),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status} ao ler ${new URL(url).hostname}`);
  return r.text();
}

/** Lê uma playlist HLS. Devolve variantes (se for master) ou segmentos. */
function lerPlaylist(texto, baseUrl) {
  const linhas = String(texto).replace(/\r/g, "").split("\n");
  const variantes = [];
  const segmentos = [];
  let mapInit = null;
  let criptografada = false;
  let duracaoTotal = 0;

  for (let i = 0; i < linhas.length; i += 1) {
    const linha = linhas[i].trim();

    if (/^#EXT-X-KEY:/i.test(linha) && !/METHOD=NONE/i.test(linha)) criptografada = true;

    if (/^#EXT-X-MAP:/i.test(linha)) {
      const uri = linha.match(/URI="([^"]+)"/i)?.[1];
      if (uri) {
        try { mapInit = new URL(uri, baseUrl).toString(); } catch { /**/ }
      }
      continue;
    }

    if (/^#EXT-X-STREAM-INF:/i.test(linha)) {
      const largura = Number.parseInt(linha.match(/BANDWIDTH=(\d+)/i)?.[1] || "0", 10);
      const alvo = (linhas[i + 1] || "").trim();
      if (alvo && !alvo.startsWith("#")) {
        try { variantes.push({ url: new URL(alvo, baseUrl).toString(), bandwidth: largura }); } catch { /**/ }
      }
      continue;
    }

    if (/^#EXTINF:/i.test(linha)) {
      const dur = Number.parseFloat(linha.split(":")[1]) || 0;
      const alvo = (linhas[i + 1] || "").trim();
      if (alvo && !alvo.startsWith("#")) {
        try {
          segmentos.push({ url: new URL(alvo, baseUrl).toString(), dur, inicio: duracaoTotal });
          duracaoTotal += dur;
        } catch { /**/ }
      }
    }
  }

  return { variantes, segmentos, mapInit, criptografada, duracaoTotal, ehMaster: variantes.length > 0 };
}

/** Desce do master para a variante de maior qualidade e devolve a lista de segmentos. */
async function resolverPlaylistDeMidia(url, referer) {
  const primeira = lerPlaylist(await baixarTexto(url, referer), url);
  if (!primeira.ehMaster) return { ...primeira, url };

  const melhor = [...primeira.variantes].sort((a, b) => b.bandwidth - a.bandwidth)[0];
  if (!melhor) throw new Error("master sem variantes utilizáveis");
  const segunda = lerPlaylist(await baixarTexto(melhor.url, referer), melhor.url);
  return { ...segunda, url: melhor.url };
}

/**
 * Recorta a lista de segmentos para o intervalo pedido. O corte é por segmento
 * inteiro — sem recodificar não dá para cortar no meio de um —, então o trecho
 * real pode começar alguns segundos antes e terminar alguns depois.
 */
function selecionarSegmentos(segmentos, inicioSeg, fimSeg) {
  if (!Number.isFinite(inicioSeg) && !Number.isFinite(fimSeg)) {
    return { escolhidos: segmentos, inicioReal: 0, fimReal: segmentos.reduce((s, x) => s + x.dur, 0) };
  }
  const de = Number.isFinite(inicioSeg) ? Math.max(0, inicioSeg) : 0;
  const ate = Number.isFinite(fimSeg) ? fimSeg : Number.POSITIVE_INFINITY;

  const escolhidos = segmentos.filter((s) => s.inicio + s.dur > de && s.inicio < ate);
  if (!escolhidos.length) throw new Error("intervalo fora da duração da mídia");

  return {
    escolhidos,
    inicioReal: escolhidos[0].inicio,
    fimReal: escolhidos[escolhidos.length - 1].inicio + escolhidos[escolhidos.length - 1].dur,
  };
}

/** Identifica o container pelos primeiros bytes; o Content-Type do provedor mente. */
function identificarContainer(buf) {
  if (buf.length >= 8) {
    const box = buf.slice(4, 8).toString("ascii");
    if (["ftyp", "styp", "moof", "sidx", "moov"].includes(box)) return "fmp4";
  }
  if (buf.length && buf[0] === 0x47) return "ts";
  return "desconhecido";
}

async function baixarSegmento(url, referer, sinal) {
  let ultimoErro;
  for (let tentativa = 1; tentativa <= TENTATIVAS_POR_SEGMENTO; tentativa += 1) {
    if (sinal?.aborted) throw new Error("cancelado");
    try {
      const r = await fetch(url, {
        headers: cabecalhos(referer),
        signal: AbortSignal.any([AbortSignal.timeout(TIMEOUT_SEGMENTO_MS), sinal].filter(Boolean)),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return Buffer.from(await r.arrayBuffer());
    } catch (erro) {
      ultimoErro = erro;
      if (sinal?.aborted) throw new Error("cancelado");
      // Espera crescente: um segmento isolado falhando é comum nesses CDNs.
      await new Promise((r) => setTimeout(r, 400 * tentativa));
    }
  }
  throw new Error(`segmento falhou após ${TENTATIVAS_POR_SEGMENTO} tentativas: ${ultimoErro?.message || ultimoErro}`);
}

function nomeSeguro(titulo) {
  return String(titulo || "obaflix")
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-zA-Z0-9 ._-]/g, "").replace(/\s+/g, " ").trim()
    .slice(0, 90) || "obaflix";
}

/**
 * Baixa a mídia para `destinoDir`. Devolve o caminho final.
 *
 * `onProgresso({ etapa, atual, total, bytes, pct })` é chamado ao longo do
 * processo; `sinal` é um AbortSignal para cancelamento.
 */
async function baixarMidia({
  stream, referer, tipo, titulo, modo, inicioSeg, fimSeg, destinoDir, onProgresso, sinal,
}) {
  const progresso = (dados) => { try { onProgresso?.(dados); } catch { /**/ } };
  const base = nomeSeguro(titulo);

  // MP4 direto: não há playlist, é só transferir o arquivo.
  if (tipo === "mp4" || /\.mp4(?:$|\?)/i.test(stream)) {
    // Um MP4 progressivo tem um índice único (moov) que mapeia tempo para byte.
    // Recortar exige reconstruir esse índice; cortar por faixa de bytes produz
    // arquivo que não abre. Falhar aqui é melhor do que baixar o filme inteiro
    // quando o usuário pediu 30 segundos — que era o que acontecia antes.
    if (modo === "trecho") {
      throw new Error(
        "Esta fonte entrega MP4 inteiro, sem índice de tempo: só dá para baixar o conteúdo completo. " +
        "Para recortar, troque para um servidor HLS (WatchPlayer ou VIP Player).",
      );
    }
    progresso({ etapa: "baixando", atual: 0, total: 1, bytes: 0, pct: 0 });
    const r = await fetch(stream, { headers: cabecalhos(referer), signal: sinal });
    if (!r.ok) throw new Error(`HTTP ${r.status} ao baixar o MP4`);
    const destino = path.join(destinoDir, `${base}.mp4`);
    const buf = Buffer.from(await r.arrayBuffer());
    await fs.promises.writeFile(destino, buf);
    progresso({ etapa: "concluido", atual: 1, total: 1, bytes: buf.length, pct: 100 });
    return { caminho: destino, bytes: buf.length, container: "mp4" };
  }

  progresso({ etapa: "lendo_playlist", atual: 0, total: 0, bytes: 0, pct: 0 });
  const playlist = await resolverPlaylistDeMidia(stream, referer);

  if (playlist.criptografada) {
    throw new Error("mídia protegida por chave (EXT-X-KEY); download não suportado");
  }
  if (!playlist.segmentos.length) throw new Error("playlist sem segmentos");

  const { escolhidos, inicioReal, fimReal } =
    modo === "trecho"
      ? selecionarSegmentos(playlist.segmentos, inicioSeg, fimSeg)
      : selecionarSegmentos(playlist.segmentos, NaN, NaN);

  // O init do EXT-X-MAP é obrigatório no fMP4: sem ele o arquivo não abre.
  const partes = [];
  if (playlist.mapInit) partes.push({ url: playlist.mapInit, init: true });
  escolhidos.forEach((s) => partes.push({ url: s.url, init: false }));

  const total = partes.length;
  let bytes = 0;
  let container = null;

  const sufixoTrecho = modo === "trecho"
    ? ` ${Math.round(inicioReal)}s-${Math.round(fimReal)}s`
    : "";
  // A extensão só é conhecida depois do primeiro pedaço; começa em .part.
  const parcial = path.join(destinoDir, `${base}${sufixoTrecho}.part`);
  const saida = fs.createWriteStream(parcial);

  const escrever = (buf) =>
    new Promise((resolve, reject) => {
      saida.write(buf, (erro) => (erro ? reject(erro) : resolve()));
    });

  try {
    // Busca à frente em janela, mas escreve na ordem: o container exige sequência.
    let proximoParaBuscar = 0;
    const emVoo = new Map();

    const agendar = () => {
      while (emVoo.size < JANELA_PARALELA && proximoParaBuscar < total) {
        const idx = proximoParaBuscar++;
        emVoo.set(idx, baixarSegmento(partes[idx].url, referer, sinal));
      }
    };

    agendar();
    for (let i = 0; i < total; i += 1) {
      if (sinal?.aborted) throw new Error("cancelado");
      const buf = await emVoo.get(i);
      emVoo.delete(i);
      agendar();

      if (container === null) {
        container = identificarContainer(buf);
        if (container === "desconhecido") {
          throw new Error("formato de segmento não reconhecido");
        }
      }

      await escrever(buf);
      bytes += buf.length;
      progresso({
        etapa: "baixando",
        atual: i + 1,
        total,
        bytes,
        pct: Math.round(((i + 1) / total) * 100),
      });
    }
  } catch (erro) {
    saida.destroy();
    await fs.promises.unlink(parcial).catch(() => {});
    throw erro;
  }

  await new Promise((resolve, reject) => saida.end((e) => (e ? reject(e) : resolve())));

  const extensao = container === "fmp4" ? "mp4" : "ts";
  const destino = path.join(destinoDir, `${base}${sufixoTrecho}.${extensao}`);
  await fs.promises.rename(parcial, destino).catch(async () => {
    await fs.promises.copyFile(parcial, destino);
    await fs.promises.unlink(parcial).catch(() => {});
  });

  progresso({ etapa: "concluido", atual: total, total, bytes, pct: 100 });
  return { caminho: destino, bytes, container, segmentos: total, inicioReal, fimReal };
}

module.exports = {
  baixarMidia,
  // Exportado para os testes locais; o app usa só baixarMidia.
  _test: { lerPlaylist, selecionarSegmentos, identificarContainer, nomeSeguro, resolverPlaylistDeMidia },
};
