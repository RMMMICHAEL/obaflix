// Diagnóstico temporário da homologação Electron. Nunca serializar o erro bruto.
let fase = "idle";
let instalado = false;

export function sanitizarDiagnosticoNavegacao(texto: string): string {
  return texto
    .replace(/(?:https?|blob|file|rtmp|wss?):\/\/[^\s)"'<>]+/gi, "[url]")
    .replace(/(?:[a-z]:\\|\/)[^\s)"'<>]+/gi, "[path]")
    .replace(/\b(?:[a-z0-9-]+\.)+[a-z]{2,}\b/gi, "[host]")
    .replace(/(?:\?|&)?(?:_vercel_share|token|signature|authorization|referer|key|secret)\s*[=:]\s*[^\s,;]+/gi, "[secret]")
    .replace(/[a-zA-Z0-9_=-]{48,}/g, "[opaque]")
    .slice(0, 1200);
}

function stackSeguro(stack: unknown): string {
  if (typeof stack !== "string") return "";
  return stack.split("\n").slice(1, 13).map(linha => {
    // Apenas o nome conhecido do bundle e coordenadas, nunca host/path/query.
    const arquivo = linha.match(/(?:\/|\\)((?:jwplayer|jw[\w-]*|[\w-]+)\.js):(\d+):(\d+)/);
    const funcao = linha.match(/^\s*at\s+([^\s(]+)/)?.[1] ?? "frame";
    return `at ${sanitizarDiagnosticoNavegacao(funcao)} (${arquivo ? `${arquivo[1]}:${arquivo[2]}:${arquivo[3]}` : "[origin]"})`;
  }).join("\n");
}

export function registrarErroNavegacao(origem: string, erro: unknown): void {
  const e = erro && typeof erro === "object" ? erro as { name?: unknown; message?: unknown; stack?: unknown } : {};
  console.error("[diag/nav] " + JSON.stringify({ origem, fase,
    name: typeof e.name === "string" ? sanitizarDiagnosticoNavegacao(e.name) : "UnknownError",
    message: sanitizarDiagnosticoNavegacao(typeof e.message === "string" ? e.message : typeof erro === "string" ? erro : "Sem mensagem"),
    stack: stackSeguro(e.stack),
  }));
}

export function registrarFaseNavegacao(proxima: string): void {
  fase = proxima;
  console.info(`[diag/nav] ${proxima}`);
}

/** Observa sem mudar o resultado nem absorver exceções. */
export function observarFaseNavegacao<T>(nome: string, acao: () => T): T {
  registrarFaseNavegacao(nome);
  try {
    const resultado = acao();
    if (resultado && typeof (resultado as { then?: unknown }).then === "function") {
      return Promise.resolve(resultado).then(valor => { registrarFaseNavegacao(`${nome}:finish`); return valor; }, erro => {
        registrarErroNavegacao(nome, erro); throw erro;
      }) as T;
    }
    registrarFaseNavegacao(`${nome}:finish`);
    return resultado;
  } catch (erro) { registrarErroNavegacao(nome, erro); throw erro; }
}

export function instalarDiagnosticoNavegacao(): void {
  if (instalado || typeof window === "undefined") return;
  instalado = true;
  // Permanecem até reload: o erro de commit React pode ocorrer após cleanup.
  window.addEventListener("error", evento => {
    if (evento instanceof ErrorEvent) registrarErroNavegacao("window:error", evento.error ?? evento.message);
  });
  window.addEventListener("unhandledrejection", evento => registrarErroNavegacao("window:unhandledrejection", evento.reason));
}
