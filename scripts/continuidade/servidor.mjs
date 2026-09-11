// Harness de teste: serve um HLS ao vivo local e uma pagina que exercita a
// troca de fonte do hls.js exatamente como o PlayerDeCanal faz.
//
// Nao faz parte do produto. Existe para medir CONTINUIDADE real de reproducao
// durante o handoff, que nenhum teste de unidade consegue provar.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const DIR = process.argv[2];
const HLSJS = process.argv[3];
const PORTA = 8791;

const TIPOS = {
  ".m3u8": "application/vnd.apple.mpegurl",
  ".ts": "video/mp2t",
  ".js": "text/javascript",
  ".html": "text/html; charset=utf-8",
};

const PAGINA = `<!doctype html><meta charset="utf-8"><title>handoff</title>
<body style="margin:0;background:#000">
<video id="v" muted playsinline style="width:100%;height:70vh"></video>
<pre id="log" style="color:#0f0;font:12px monospace"></pre>
<script src="/hls.js"></script>
<script>
const v = document.getElementById("v");
window.__est = { trocas: 0, eventos: [] };

const hls = new Hls({ liveSyncDurationCount: 3, enableWorker: true });
hls.attachMedia(v);
hls.on(Hls.Events.ERROR, (_e, d) => { if (d.fatal) window.__est.eventos.push("fatal:" + d.details); });

// A MESMA logica de troca do PlayerDeCanal: loadSource na instancia existente,
// preservando a posicao quando a linha do tempo permite.
window.__trocar = (url) => {
  const antes = v.currentTime;
  const tocava = !v.paused;
  hls.loadSource(url);
  const restaurar = () => {
    // Numa live, v.duration e Infinity — por isso a checagem NAO pode ser
    // Number.isFinite(duration). O que decide e o buffer: se o ponto anterior
    // ainda esta bufferizado na fonte nova, volta-se a ele.
    for (let i = 0; i < v.buffered.length; i++) {
      if (antes >= v.buffered.start(i) && antes <= v.buffered.end(i)) {
        if (Math.abs(v.currentTime - antes) > 0.1) v.currentTime = antes;
        break;
      }
    }
    if (tocava) v.play().catch(() => {});
  };
  hls.once(Hls.Events.FRAG_BUFFERED, restaurar);
  hls.once(Hls.Events.MANIFEST_PARSED, () => setTimeout(restaurar, 0));
  window.__est.trocas++;
  window.__est.eventos.push("troca:" + window.__est.trocas);
  return antes;
};

window.__medir = () => ({
  currentTime: v.currentTime,
  paused: v.paused,
  readyState: v.readyState,
  frames: v.getVideoPlaybackQuality ? v.getVideoPlaybackQuality().totalVideoFrames : -1,
  bufferEnd: v.buffered.length ? v.buffered.end(v.buffered.length - 1) : 0,
  eventos: window.__est.eventos.slice(),
});

window.__trocar("/stream/live.m3u8?g=1");
</script>`;

http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  if (u.pathname === "/") {
    res.writeHead(200, { "Content-Type": TIPOS[".html"] });
    return res.end(PAGINA);
  }
  if (u.pathname === "/hls.js") {
    res.writeHead(200, { "Content-Type": TIPOS[".js"] });
    return res.end(fs.readFileSync(HLSJS));
  }
  if (u.pathname.startsWith("/stream/")) {
    const arq = path.join(DIR, path.basename(u.pathname));
    if (!fs.existsSync(arq)) { res.writeHead(404); return res.end(); }
    res.writeHead(200, {
      "Content-Type": TIPOS[path.extname(arq)] || "application/octet-stream",
      "Cache-Control": "no-store",
    });
    return res.end(fs.readFileSync(arq));
  }
  res.writeHead(404);
  res.end();
}).listen(PORTA, () => console.log("servidor em http://127.0.0.1:" + PORTA));
