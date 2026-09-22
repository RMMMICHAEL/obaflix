"use strict";

const crypto = require("crypto");

const DESKTOP_PROTOCOL = "obaflix";
const DESKTOP_AUTH_HOST = "auth";
const DESKTOP_AUTH_PATH = "/callback";
const FLOW_MAX_AGE_MS = 10 * 60 * 1000;

function callbackInternoSeguro(value, fallback = "/desktop") {
  return typeof value === "string" &&
    value.startsWith("/") &&
    !value.startsWith("//") &&
    !value.includes("\\")
    ? value
    : fallback;
}

function createPkceFlow(callbackUrl, now = Date.now()) {
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  const state = crypto.randomBytes(32).toString("base64url");
  return {
    verifier,
    challenge,
    state,
    callbackUrl: callbackInternoSeguro(callbackUrl),
    createdAt: now,
  };
}

function findDeepLinkArg(argv) {
  if (!Array.isArray(argv)) return null;
  return argv.find((value) =>
    typeof value === "string" && value.toLowerCase().startsWith(`${DESKTOP_PROTOCOL}://`)
  ) || null;
}

function parseDesktopAuthDeepLink(raw) {
  try {
    if (typeof raw !== "string" || raw.length > 8192) return null;
    const url = new URL(raw);
    if (
      url.protocol !== `${DESKTOP_PROTOCOL}:` ||
      url.hostname !== DESKTOP_AUTH_HOST ||
      url.pathname !== DESKTOP_AUTH_PATH
    ) return null;

    const ticket = url.searchParams.get("ticket");
    const state = url.searchParams.get("state");
    if (!ticket || ticket.length > 4096) return null;
    if (!state || !/^[A-Za-z0-9_-]{43}$/.test(state)) return null;
    return { ticket, state };
  } catch {
    return null;
  }
}

function flowAindaValido(flow, state, now = Date.now()) {
  if (!flow || typeof flow !== "object") return false;
  if (typeof flow.createdAt !== "number" || now - flow.createdAt < 0 || now - flow.createdAt > FLOW_MAX_AGE_MS) {
    return false;
  }
  if (typeof flow.state !== "string" || typeof state !== "string" || flow.state.length !== state.length) {
    return false;
  }
  return crypto.timingSafeEqual(Buffer.from(flow.state), Buffer.from(state));
}

module.exports = {
  DESKTOP_PROTOCOL,
  FLOW_MAX_AGE_MS,
  callbackInternoSeguro,
  createPkceFlow,
  findDeepLinkArg,
  parseDesktopAuthDeepLink,
  flowAindaValido,
};
