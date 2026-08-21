"use strict";

// Localiza o ffmpeg. Ordem: binário embarcado no app, PATH do sistema, e por
// último os caminhos onde os instaladores comuns do Windows costumam deixá-lo.
//
// Nada é baixado em tempo de execução: ou o binário veio no pacote, ou já estava
// instalado na máquina.

const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");

let cacheCaminho;          // undefined = ainda não procurado; null = não existe
let cacheProbe;

function existeExecutavel(p) {
  try { return !!p && fs.existsSync(p) && fs.statSync(p).isFile(); } catch { return false; }
}

/** Caminho do binário embarcado, quando o app foi empacotado com ele. */
function caminhoEmbarcado(nome) {
  const candidatos = [];
  try {
    // Em produção o electron-builder põe extraResources em process.resourcesPath.
    if (process.resourcesPath) {
      candidatos.push(path.join(process.resourcesPath, "ffmpeg", nome));
    }
  } catch { /**/ }
  // Em desenvolvimento, o pacote npm resolve sozinho.
  try {
    const doPacote = require("ffmpeg-static");
    if (typeof doPacote === "string") {
      candidatos.push(nome === "ffmpeg.exe" ? doPacote : path.join(path.dirname(doPacote), nome));
    }
  } catch { /* pacote ausente: seguimos para o PATH */ }
  return candidatos.find(existeExecutavel) || null;
}

function noPath(nome) {
  const dirs = String(process.env.PATH || "").split(path.delimiter).filter(Boolean);
  for (const d of dirs) {
    const p = path.join(d, nome);
    if (existeExecutavel(p)) return p;
  }
  return null;
}

/** Instaladores comuns no Windows que não colocam o ffmpeg no PATH. */
function locaisConhecidos(nome) {
  const raizes = [
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Microsoft", "WinGet", "Packages"),
    "C:\\ffmpeg\\bin",
    process.env.ProgramFiles && path.join(process.env.ProgramFiles, "ffmpeg", "bin"),
  ].filter(Boolean);

  for (const raiz of raizes) {
    const direto = path.join(raiz, nome);
    if (existeExecutavel(direto)) return direto;
    // O WinGet cria uma pasta por versão; procura um nível abaixo.
    try {
      for (const sub of fs.readdirSync(raiz, { withFileTypes: true })) {
        if (!sub.isDirectory()) continue;
        if (!/ffmpeg/i.test(sub.name)) continue;
        const base = path.join(raiz, sub.name);
        const candidatos = [path.join(base, "bin", nome), path.join(base, nome)];
        for (const c of candidatos) if (existeExecutavel(c)) return c;
        // WinGet aninha mais um nível: <pacote>/<build>/bin/ffmpeg.exe
        try {
          for (const sub2 of fs.readdirSync(base, { withFileTypes: true })) {
            if (!sub2.isDirectory()) continue;
            const c2 = path.join(base, sub2.name, "bin", nome);
            if (existeExecutavel(c2)) return c2;
          }
        } catch { /**/ }
      }
    } catch { /**/ }
  }
  return null;
}

function nomeBinario(base) {
  return process.platform === "win32" ? `${base}.exe` : base;
}

/** Caminho do ffmpeg, ou null se não houver nenhum disponível. */
function localizarFfmpeg() {
  if (cacheCaminho !== undefined) return cacheCaminho;
  const nome = nomeBinario("ffmpeg");
  cacheCaminho = caminhoEmbarcado(nome) || noPath(nome) || locaisConhecidos(nome) || null;
  return cacheCaminho;
}

/** ffprobe fica ao lado do ffmpeg; usado só para conferir o resultado. */
function localizarFfprobe() {
  if (cacheProbe !== undefined) return cacheProbe;
  const nome = nomeBinario("ffprobe");
  const ffmpeg = localizarFfmpeg();
  const vizinho = ffmpeg ? path.join(path.dirname(ffmpeg), nome) : null;
  cacheProbe = (existeExecutavel(vizinho) ? vizinho : null) || noPath(nome) || locaisConhecidos(nome) || null;
  return cacheProbe;
}

function temFfmpeg() {
  return !!localizarFfmpeg();
}

/** Executa o ffmpeg. `onLinha` recebe cada linha de progresso do stderr. */
function rodarFfmpeg(args, { sinal, onLinha, timeoutMs = 60 * 60 * 1000 } = {}) {
  const bin = localizarFfmpeg();
  if (!bin) return Promise.reject(new Error("ffmpeg não encontrado"));

  return new Promise((resolve, reject) => {
    const filho = execFile(bin, args, { timeout: timeoutMs, maxBuffer: 1024 * 1024 * 32 },
      (erro, _saida, stderr) => {
        if (sinal?.aborted) return reject(new Error("cancelado"));
        if (erro) {
          // A causa real fica nas últimas linhas do stderr, não na mensagem do erro.
          const ultimas = String(stderr || "").trim().split("\n").slice(-4).join(" | ");
          return reject(new Error(ultimas.slice(0, 300) || erro.message));
        }
        resolve();
      });

    if (onLinha && filho.stderr) {
      let resto = "";
      filho.stderr.on("data", (pedaco) => {
        resto += String(pedaco);
        const linhas = resto.split(/\r?\n|\r/);
        resto = linhas.pop() || "";
        linhas.forEach((l) => { try { onLinha(l); } catch { /**/ } });
      });
    }

    const abortar = () => { try { filho.kill("SIGKILL"); } catch { /**/ } };
    if (sinal) {
      if (sinal.aborted) abortar();
      else sinal.addEventListener("abort", abortar, { once: true });
    }
  });
}

module.exports = { localizarFfmpeg, localizarFfprobe, temFfmpeg, rodarFfmpeg };
