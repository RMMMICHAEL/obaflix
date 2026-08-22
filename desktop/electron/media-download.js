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
const { temFfmpeg, suportaOpcao, rodarFfmpeg } = require("./ffmpeg-bin");

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
  const audiosSeparados = [];
  let mapInit = null;
  let criptografada = false;
  let duracaoTotal = 0;

  for (let i = 0; i < linhas.length; i += 1) {
    const linha = linhas[i].trim();

    if (/^#EXT-X-KEY:/i.test(linha) && !/METHOD=NONE/i.test(linha)) criptografada = true;

    // Rendição de áudio com URI própria: o vídeo e o áudio vêm em playlists
    // separadas e o player junta na hora de tocar. Note o ":" no padrão — sem
    // ele, "#EXT-X-MEDIA-SEQUENCE" casaria e daria falso positivo.
    if (/^#EXT-X-MEDIA:/i.test(linha)) {
      const tipoMedia = linha.match(/TYPE=([A-Z-]+)/i)?.[1]?.toUpperCase();
      const uriMedia = linha.match(/URI="([^"]+)"/i)?.[1];
      if (tipoMedia === "AUDIO" && uriMedia) {
        try {
          audiosSeparados.push({
            url: new URL(uriMedia, baseUrl).toString(),
            nome: linha.match(/NAME="([^"]*)"/i)?.[1] || "áudio",
          });
        } catch { /**/ }
      }
      continue;
    }

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

  return { variantes, segmentos, audiosSeparados, mapInit, criptografada, duracaoTotal, ehMaster: variantes.length > 0 };
}

/** Desce do master para a variante de maior qualidade e devolve a lista de segmentos. */
async function resolverPlaylistDeMidia(url, referer) {
  const primeira = lerPlaylist(await baixarTexto(url, referer), url);
  if (!primeira.ehMaster) return { ...primeira, url };

  const melhor = [...primeira.variantes].sort((a, b) => b.bandwidth - a.bandwidth)[0];
  if (!melhor) throw new Error("master sem variantes utilizáveis");
  const segunda = lerPlaylist(await baixarTexto(melhor.url, referer), melhor.url);
  // As rendições ficam declaradas no master, não na variante escolhida.
  return { ...segunda, audiosSeparados: primeira.audiosSeparados, url: melhor.url };
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

/** hh:mm:ss.mmm de uma duração em segundos, para o -ss/-to do ffmpeg. */
function paraTimecode(seg) {
  const s = Math.max(0, Number(seg) || 0);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const resto = (s % 60).toFixed(3).padStart(6, "0");
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${resto}`;
}

/**
 * Caminho com ffmpeg: junta faixas separadas, corta no tempo exato e sai em MP4.
 * Sempre com `-c copy` — nada é recodificado, só remuxado.
 */
async function baixarComFfmpeg({
  stream, referer, titulo, modo, inicioSeg, fimSeg, destinoDir, onProgresso, sinal,
}) {
  const base = nomeSeguro(titulo);
  const recorta = modo === "trecho" && Number.isFinite(inicioSeg) && Number.isFinite(fimSeg);
  const sufixo = recorta ? ` ${Math.round(inicioSeg)}s-${Math.round(fimSeg)}s` : "";
  const destino = path.join(destinoDir, `${base}${sufixo}.mp4`);

  const cabecalhosExtra = [];
  if (referer) {
    cabecalhosExtra.push(`Referer: ${referer}`);
    try { cabecalhosExtra.push(`Origin: ${new URL(referer).origin}`); } catch { /**/ }
  }

  const duracaoAlvo = recorta ? Math.max(0, fimSeg - inicioSeg) : 0;

  const args = [
    "-hide_banner", "-loglevel", "error", "-stats",
    "-user_agent", UA,
    // Estes provedores entregam segmentos disfarçados de .js/.css/.woff; sem
    // liberar as extensões o demuxer HLS do ffmpeg recusa a playlist inteira.
    "-allowed_extensions", "ALL",
    "-protocol_whitelist", "file,http,https,tcp,tls,crypto",
  ];
  // Builds recentes do ffmpeg apertaram a validação de extensão e passaram a
  // exigir esta opção além da anterior; builds mais antigos nem a reconhecem e
  // abortam com "Unrecognized option". Por isso ela é condicional.
  if (suportaOpcao("-extension_picky")) args.push("-extension_picky", "0");
  if (cabecalhosExtra.length) args.push("-headers", cabecalhosExtra.join("\r\n") + "\r\n");
  // -ss antes do -i faz busca na entrada: baixa só o trecho, em vez do arquivo todo.
  if (recorta) args.push("-ss", paraTimecode(inicioSeg), "-to", paraTimecode(fimSeg));
  args.push(
    "-i", stream,
    "-map", "0", "-c", "copy",
    // Necessário para MP4 com trilhas vindas de MPEG-TS.
    "-bsf:a", "aac_adtstoasc",
    // Com -c copy o corte cai no keyframe anterior ao pedido. Sem zerar os
    // timestamps, o inicio do arquivo fica com PTS negativo e alguns players
    // mostram tela preta (ou so tocam o audio) ate o proximo keyframe.
    "-avoid_negative_ts", "make_zero",
    "-fflags", "+genpts",
    "-movflags", "+faststart",
    "-y", destino,
  );

  onProgresso?.({ etapa: "baixando", atual: 0, total: 0, bytes: 0, pct: 0 });

  // O -stats imprime "time=00:01:07.20", que vira porcentagem quando há recorte.
  const rePonto = /time=(\d+):(\d+):(\d+(?:\.\d+)?)/;
  const reTamanho = /size=\s*(\d+)(?:KiB|kB)/i;
  let ultimoBytes = 0;

  await rodarFfmpeg(args, {
    sinal,
    onLinha: (linha) => {
      const t = linha.match(rePonto);
      const sz = linha.match(reTamanho);
      if (sz) ultimoBytes = Number(sz[1]) * 1024;
      if (!t) return;
      const decorrido = Number(t[1]) * 3600 + Number(t[2]) * 60 + Number(t[3]);
      const pct = duracaoAlvo > 0
        ? Math.max(0, Math.min(99, Math.round((decorrido / duracaoAlvo) * 100)))
        : 0;
      onProgresso?.({ etapa: "baixando", atual: Math.round(decorrido), total: Math.round(duracaoAlvo), bytes: ultimoBytes, pct });
    },
  });

  const bytes = (await fs.promises.stat(destino).catch(() => ({ size: 0 }))).size;
  if (!bytes) throw new Error("ffmpeg terminou sem gerar arquivo");

  onProgresso?.({ etapa: "concluido", atual: 1, total: 1, bytes, pct: 100 });
  return {
    caminho: destino,
    bytes,
    container: "mp4",
    viaFfmpeg: true,
    inicioReal: recorta ? inicioSeg : 0,
    fimReal: recorta ? fimSeg : 0,
  };
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

  // Roteamento por necessidade, e não "ffmpeg sempre que existir".
  //
  // O binário embarcado é o 6.1.1 e não dá conta do fMP4 HLS do WatchPlay:
  // gasta 81s e escreve zero byte, enquanto um build recente resolve em 8s. Como
  // a versão instalada varia de máquina para máquina, a concatenação — que não
  // depende de versão nenhuma — continua sendo o caminho quando a mídia é
  // autossuficiente. O ffmpeg entra onde a concatenação não tem como resolver:
  // faixa de áudio separada e recorte de MP4.

  // MP4 direto: não há playlist, é só transferir o arquivo.
  if (tipo === "mp4" || /\.mp4(?:$|\?)/i.test(stream)) {
    // Um MP4 progressivo tem um índice único (moov) que mapeia tempo para byte.
    // Recortar exige reconstruir esse índice; cortar por faixa de bytes produz
    // arquivo que não abre. Falhar aqui é melhor do que baixar o filme inteiro
    // quando o usuário pediu 30 segundos — que era o que acontecia antes.
    if (modo === "trecho") {
      // Recortar MP4 exige reconstruir o índice de tempo; só o ffmpeg faz isso.
      if (!temFfmpeg()) {
        throw new Error(
          "Sem ffmpeg não dá para recortar MP4: esta fonte entrega o arquivo inteiro, " +
          "sem índice de tempo. Baixe o conteúdo completo ou instale o ffmpeg.",
        );
      }
      return baixarComFfmpeg({
        stream, referer, titulo, modo, inicioSeg, fimSeg, destinoDir, onProgresso: progresso, sinal,
      });
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

  // Áudio em rendição separada: a variante de vídeo não carrega som nenhum, e
  // concatenar entregaria um arquivo mudo. Só o ffmpeg junta as duas faixas.
  if (playlist.audiosSeparados?.length) {
    if (!temFfmpeg()) {
      throw new Error(
        "Esta fonte entrega o áudio numa faixa separada e juntar as duas exige ffmpeg, que não foi " +
        "encontrado. Instale o ffmpeg ou troque para o servidor WatchPlayer, que entrega tudo junto.",
      );
    }
    return baixarComFfmpeg({
      stream, referer, titulo, modo, inicioSeg, fimSeg, destinoDir, onProgresso: progresso, sinal,
    });
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
