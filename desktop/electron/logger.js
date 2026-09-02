"use strict";

// ── Sistema de logs do Obaflix Desktop ────────────────────────────────────────
// Objetivo: quando algo falha, saber EXATAMENTE em que etapa falhou, quanto tempo
// cada etapa levou e com qual URL. Tudo sai no console (stdout do processo main)
// e também num arquivo rotativo em <userData>/logs/obaflix-<data>.log.
//
// Onde fica o arquivo no Windows:
//   C:\Users\<user>\AppData\Roaming\Obaflix\logs\obaflix-YYYY-MM-DD.log
//
// Formato de cada linha:
//   2026-08-17T14:03:11.482Z  INFO  [player.extract] provider=hide ok=true dur=1569ms url=https://playhide.shop/v/...
//
// Uso típico:
//   const log = require("./logger");
//   log.info("app", "iniciando");
//   const t = log.timer("player.extract", { provider: "hide" });
//   ... t.step("html_baixado") ... t.done({ ok: true }) / t.fail(err)

const fs = require("fs");
const path = require("path");
const os = require("os");

const LEVELS = { trace: 10, debug: 20, info: 30, warn: 40, error: 50 };
const MAX_FILE_BYTES = 8 * 1024 * 1024; // 8 MB por arquivo antes de rotacionar
const KEEP_FILES = 5;

let minLevel = LEVELS[(process.env.OBAFLIX_LOG_LEVEL || "").toLowerCase()] ?? LEVELS.debug;
let logDir = null;
let stream = null;
let streamBytes = 0;
let ready = false;
const pending = [];

// ── Utilidades ────────────────────────────────────────────────────────────────

/** Encurta URLs para o log sem esconder o essencial (host + começo do path). */
function shortUrl(raw, max = 120) {
  if (typeof raw !== "string") return String(raw ?? "");
  if (raw.length <= max) return raw;
  return `${raw.slice(0, max)}…(+${raw.length - max})`;
}

/**
 * Remove segredos óbvios que não devem parar num arquivo de log compartilhável.
 *
 * O padrão anterior exigia `?` ou `&` colado ao nome, então `cnvs_token=` e
 * `verify=` — os dois que os CDNs em uso realmente assinam — passavam inteiros
 * para o arquivo em disco. Agora qualquer parâmetro terminado em `token`, mais
 * a lista nominal, é mascarado.
 */
function scrub(value) {
  if (typeof value !== "string") return value;
  return value
    .replace(/([?&](?:t|pt|[\w-]*(?:token|password|secret|signature|sig|key|auth|verify|cfv|expires|hash|md5))=)[^&\s]*/gi, "$1***")
    .replace(/\b(cf_clearance|__sf_turnstile_pass|cfv|page_token|pageToken)=([^;\s&]+)/gi, "$1=***")
    .replace(/(Authorization:\s*Bearer\s+)\S+/gi, "$1***")
    .replace(/(Cookie\s*[:=]\s*)\S+/gi, "$1***");
}

/**
 * URL sem query nenhuma: host + caminho.
 *
 * Para linhas que só precisam dizer "qual recurso", e não "com quais
 * parâmetros". É a query que carrega assinatura de CDN, e nenhum diagnóstico
 * daqui depende dela.
 */
function safeUrl(raw) {
  if (typeof raw !== "string" || !raw) return "-";
  try {
    const u = new URL(raw);
    const params = u.searchParams.size ?? [...u.searchParams].length;
    return `${u.host}${u.pathname}${params ? `?<${params}p>` : ""}`;
  } catch {
    return scrub(raw).slice(0, 80);
  }
}

function formatFields(fields) {
  if (!fields) return "";
  const parts = [];
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || value === null) continue;
    let out;
    if (value instanceof Error) out = value.message;
    else if (typeof value === "object") {
      try { out = JSON.stringify(value); } catch { out = "[objeto]"; }
    } else out = String(value);
    out = scrub(out);
    if (/\s/.test(out)) out = `"${out.replace(/"/g, "'")}"`;
    parts.push(`${key}=${out}`);
  }
  return parts.length ? ` ${parts.join(" ")}` : "";
}

// ── Arquivo ───────────────────────────────────────────────────────────────────

function rotateIfNeeded() {
  if (!stream || streamBytes < MAX_FILE_BYTES) return;
  try {
    stream.end();
    const base = stream.path;
    for (let i = KEEP_FILES - 1; i >= 1; i -= 1) {
      const from = `${base}.${i}`;
      const to = `${base}.${i + 1}`;
      if (fs.existsSync(from)) fs.renameSync(from, to);
    }
    fs.renameSync(base, `${base}.1`);
    stream = fs.createWriteStream(base, { flags: "a" });
    streamBytes = 0;
  } catch {
    /* rotação é best-effort — nunca deve derrubar o app */
  }
}

function writeFileLine(line) {
  if (!stream) return;
  try {
    stream.write(line + os.EOL);
    streamBytes += Buffer.byteLength(line) + 1;
    rotateIfNeeded();
  } catch {
    /* ignora falhas de escrita */
  }
}

/**
 * Liga a escrita em arquivo. Chamar assim que `app.getPath("userData")` existir
 * (ou seja, depois de app.whenReady()). Antes disso os logs ficam em buffer.
 */
function initFile(userDataPath) {
  if (ready) return logDir;
  try {
    logDir = path.join(userDataPath, "logs");
    fs.mkdirSync(logDir, { recursive: true });
    const day = new Date().toISOString().slice(0, 10);
    const file = path.join(logDir, `obaflix-${day}.log`);
    streamBytes = fs.existsSync(file) ? fs.statSync(file).size : 0;
    stream = fs.createWriteStream(file, { flags: "a" });
    ready = true;
    while (pending.length) writeFileLine(pending.shift());
    writeFileLine(`${new Date().toISOString()}  INFO  [log] arquivo=${file}`);
  } catch (error) {
    ready = true; // não tenta de novo a cada linha
    console.error("[log] não foi possível abrir o arquivo de log:", error.message);
  }
  return logDir;
}

function getLogDir() {
  return logDir;
}

function setLevel(name) {
  const level = LEVELS[String(name).toLowerCase()];
  if (level) minLevel = level;
}

// ── Emissão ───────────────────────────────────────────────────────────────────

const CONSOLE_FN = { trace: "debug", debug: "debug", info: "log", warn: "warn", error: "error" };

function emit(level, scope, message, fields) {
  if (LEVELS[level] < minLevel) return;
  const line = `${new Date().toISOString()}  ${level.toUpperCase().padEnd(5)} [${scope}] ${scrub(message)}${formatFields(fields)}`;
   
  console[CONSOLE_FN[level]](line);
  if (ready) writeFileLine(line);
  else if (pending.length < 2000) pending.push(line);
}

const trace = (scope, message, fields) => emit("trace", scope, message, fields);
const debug = (scope, message, fields) => emit("debug", scope, message, fields);
const info = (scope, message, fields) => emit("info", scope, message, fields);
const warn = (scope, message, fields) => emit("warn", scope, message, fields);

function error(scope, message, errOrFields) {
  if (errOrFields instanceof Error) {
    emit("error", scope, message, { erro: errOrFields.message, tipo: errOrFields.name });
    if (errOrFields.stack) emit("debug", scope, "stack", { stack: errOrFields.stack.split("\n").slice(1, 6).join(" | ") });
    return;
  }
  emit("error", scope, message, errOrFields);
}

// ── Timers de etapa ───────────────────────────────────────────────────────────
// O ponto central do pedido: descobrir ONDE está o gargalo. Um timer mede o total
// e cada `step` mede o delta desde o passo anterior, então o log já mostra a etapa
// cara sem ninguém ter que subtrair timestamps na mão.

let seq = 0;

/**
 * Cria um cronômetro de etapas.
 * @param {string} scope  rótulo da operação, ex. "player.extract"
 * @param {object} [base] campos repetidos em todas as linhas do cronômetro
 */
function timer(scope, base = {}) {
  const id = `${Date.now().toString(36)}${(seq += 1).toString(36)}`;
  const start = Date.now();
  let last = start;
  const steps = [];

  info(scope, "início", { id, ...base });

  return {
    id,
    /** Marca o fim de uma etapa e loga quanto ela levou. */
    step(name, fields) {
      const now = Date.now();
      const ms = now - last;
      last = now;
      steps.push(`${name}:${ms}ms`);
      debug(scope, `etapa ${name}`, { id, dur: `${ms}ms`, total: `${now - start}ms`, ...fields });
      return ms;
    },
    /** Fecha o cronômetro com sucesso, resumindo todas as etapas numa linha. */
    done(fields) {
      const total = Date.now() - start;
      info(scope, "fim ok", { id, total: `${total}ms`, etapas: steps.join(" ") || "-", ...base, ...fields });
      return total;
    },
    /** Fecha o cronômetro com falha, dizendo em qual etapa parou. */
    fail(err, fields) {
      const total = Date.now() - start;
      error(scope, "fim erro", {
        id,
        total: `${total}ms`,
        etapas: steps.join(" ") || "-",
        parouEm: steps.length ? steps[steps.length - 1].split(":")[0] : "início",
        erro: err instanceof Error ? err.message : String(err ?? ""),
        ...base,
        ...fields,
      });
      return total;
    },
  };
}

module.exports = {
  initFile,
  getLogDir,
  setLevel,
  trace,
  debug,
  info,
  warn,
  error,
  timer,
  shortUrl,
  safeUrl,
  LEVELS,
};
