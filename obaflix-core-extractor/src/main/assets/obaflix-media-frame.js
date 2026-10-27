(function () {
  'use strict';
  const bridge = window.__obaMediaFrame;
  if (!bridge) return;
  const request = __OBA_REQUEST__;
  const send = value => bridge.postMessage(JSON.stringify(value));
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const waitFor = async fn => {
    for (let i = 0; i < 160; i++) {
      const value = fn();
      if (value) return value;
      await sleep(250);
    }
    throw Error('Timeout esperando catálogo, Service Worker ou MP4');
  };
  // Um fetch grande alimenta varios blocos pequenos. O WebMessage continua
  // limitado a 256 KB de binario (~350 KB em Base64), mas o CDN/SW nao precisa
  // abrir uma requisicao HTTP nova para cada bloco.
  const CHUNK_BYTES = 262144;
  const WINDOW_CHUNKS = 16; // 4 MiB por fetch
  const MAX_WINDOWS = 4;

  const windows = [];
  const cancelled = new Set();
  let source;

  const newSlot = () => ({
    value: null,
    error: null,
    waiters: []
  });

  const resolveSlot = (slot, value) => {
    if (slot.value || slot.error) return;
    slot.value = value;
    const waiters = slot.waiters.splice(0);
    for (const waiter of waiters) waiter.resolve(value);
  };

  const rejectSlot = (slot, error) => {
    if (slot.value || slot.error) return;
    slot.error = error;
    const waiters = slot.waiters.splice(0);
    for (const waiter of waiters) waiter.reject(error);
  };

  const waitSlot = slot => {
    if (slot.value) return Promise.resolve(slot.value);
    if (slot.error) return Promise.reject(slot.error);
    return new Promise((resolve, reject) => {
      slot.waiters.push({ resolve, reject });
    });
  };

  const evictOldWindows = current => {
    while (windows.length > MAX_WINDOWS) {
      const index = windows.findIndex(win =>
        win !== current &&
        Array.from(win.chunks.values()).every(slot => slot.waiters.length === 0)
      );
      if (index < 0) return;

      const old = windows.splice(index, 1)[0];
      try { old.controller.abort(); } catch (_) {}
    }
  };

  const startWindow = start => {
    const plannedEnd = start + CHUNK_BYTES * WINDOW_CHUNKS - 1;
    const controller = new AbortController();

    const win = {
      start,
      plannedEnd,
      controller,
      chunks: new Map(),
      total: null,
      done: false,
      failed: null,
      lastUsed: Date.now()
    };

    for (let i = 0; i < WINDOW_CHUNKS; i++) {
      win.chunks.set(start + i * CHUNK_BYTES, newSlot());
    }

    windows.push(win);
    evictOldWindows(win);

    (async () => {
      const timeout = setTimeout(() => controller.abort(), 25000);

      try {
        const response = await fetch(source, {
          headers: {
            Range: `bytes=${start}-${plannedEnd}`
          },
          signal: controller.signal
        });

        if (response.status !== 206) {
          throw Error('CDN HTTP ' + response.status);
        }

        const contentRange = response.headers.get('content-range');
        const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(contentRange || '');

        if (!match) {
          throw Error('Content-Range ausente');
        }

        const actualStart = Number(match[1]);
        const actualEnd = Number(match[2]);
        const total = Number(match[3]);

        if (
          actualStart !== start ||
          actualEnd < start ||
          actualEnd > plannedEnd ||
          !Number.isSafeInteger(total) ||
          total <= actualEnd
        ) {
          throw Error('Content-Range inconsistente');
        }

        win.total = total;

        if (!response.body) {
          throw Error('Resposta sem stream');
        }

        const expected = actualEnd - actualStart + 1;
        const reader = response.body.getReader();

        let received = 0;
        let cursor = start;
        let buffer = new Uint8Array(CHUNK_BYTES);
        let used = 0;

        while (true) {
          const part = await reader.read();
          if (part.done) break;

          let position = 0;
          const value = part.value;

          while (position < value.length) {
            const take = Math.min(
              CHUNK_BYTES - used,
              value.length - position
            );

            buffer.set(
              value.subarray(position, position + take),
              used
            );

            used += take;
            position += take;
            received += take;

            if (used === CHUNK_BYTES || received === expected) {
              const chunkEnd = cursor + used - 1;
              const slot = win.chunks.get(cursor);

              if (!slot) {
                throw Error('Chunk fora da janela');
              }

              resolveSlot(slot, {
                bytes: buffer.slice(0, used),
                end: chunkEnd,
                total
              });

              cursor = chunkEnd + 1;
              buffer = new Uint8Array(CHUNK_BYTES);
              used = 0;
            }
          }
        }

        if (received !== expected || used !== 0) {
          throw Error('Range incompleto');
        }

        // Alguns CDNs podem limitar o tamanho máximo do Range mesmo quando
        // pedimos uma janela maior. Libera os slots não cobertos para que
        // getChunk() use o fetch individual de fallback em vez de ficar esperando.
        for (const [chunkStart, slot] of win.chunks) {
          if (chunkStart > actualEnd && !slot.value && !slot.error) {
            rejectSlot(slot, Error('Chunk fora da resposta da janela'));
          }
        }

        win.done = true;
      } catch (error) {
        win.failed = error;

        for (const slot of win.chunks.values()) {
          rejectSlot(slot, error);
        }
      } finally {
        clearTimeout(timeout);
      }
    })();

    return win;
  };

  const findWindow = start => {
    for (let i = windows.length - 1; i >= 0; i--) {
      const win = windows[i];
      if (!win.failed && win.chunks.has(start)) {
        win.lastUsed = Date.now();
        return win;
      }
    }
    return null;
  };

  // Plano B: se uma janela grande falhar neste CDN/SW, a requisicao individual
  // de 256 KB preserva o comportamento que ja provamos funcionar.
  const fetchExact = async (start, end) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 25000);

    try {
      const response = await fetch(source, {
        headers: {
          Range: `bytes=${start}-${end}`
        },
        signal: controller.signal
      });

      if (response.status !== 206) {
        throw Error('CDN HTTP ' + response.status);
      }

      const contentRange = response.headers.get('content-range');
      const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(contentRange || '');

      if (
        !match ||
        Number(match[1]) !== start ||
        Number(match[2]) !== end
      ) {
        throw Error('Content-Range inconsistente');
      }

      const total = Number(match[3]);
      const reader = response.body.getReader();
      const bytes = new Uint8Array(end - start + 1);

      let offset = 0;

      while (true) {
        const part = await reader.read();
        if (part.done) break;

        if (offset + part.value.length > bytes.length) {
          controller.abort();
          throw Error('Corpo excede Range');
        }

        bytes.set(part.value, offset);
        offset += part.value.length;
      }

      if (offset !== bytes.length) {
        throw Error('Range incompleto');
      }

      return { bytes, end, total };
    } finally {
      clearTimeout(timeout);
    }
  };

  const getChunk = async (start, end) => {
    let win = findWindow(start);

    if (!win) {
      win = startWindow(start);
    }

    try {
      const result = await waitSlot(win.chunks.get(start));

      if (result.end !== end) {
        throw Error('Chunk nao corresponde ao Range pedido');
      }

      return result;
    } catch (_) {
      // Compatibilidade: uma janela grande que algum host nao aceite nao
      // derruba a reproducao; recua para o Range pequeno tradicional.
      return fetchExact(start, end);
    }
  };

  bridge.onmessage = async event => {
    const command = JSON.parse(event.data);

    if (command.kind === 'cancel') {
      cancelled.add(command.id);
      return;
    }

    if (command.kind !== 'range' || !source) return;

    try {
      const { start, end } = command;

      if (
        !Number.isSafeInteger(start) ||
        !Number.isSafeInteger(end) ||
        start < 0 ||
        end < start ||
        end - start + 1 > CHUNK_BYTES
      ) {
        throw Error('Range invalido');
      }

      const result = await getChunk(start, end);

      if (cancelled.delete(command.id)) return;

      let binary = '';

      for (let i = 0; i < result.bytes.length; i += 32768) {
        binary += String.fromCharCode.apply(
          null,
          result.bytes.subarray(i, i + 32768)
        );
      }

      send({
        kind: 'range',
        id: command.id,
        contentRange: `bytes ${start}-${end}/${result.total}`,
        base64: btoa(binary)
      });
    } catch (error) {
      if (cancelled.delete(command.id)) return;

      send({
        kind: 'range',
        id: command.id,
        error: String(error.message || error)
      });
    }
  };
  (async () => {
    if (location.hostname === 'www.embedplay.one' && window === top) {
      const catalog = await waitFor(() => window.ALL_EPISODES);
      const ep = (catalog[String(request.season)] || []).find(item =>
        Number(item.season) === request.season && Number(item.epi_num) === request.episode);
      if (!ep) throw Error('Episódio ausente');
      const response = await fetch('/api', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          'X-Requested-With': 'XMLHttpRequest' },
        body: new URLSearchParams({ action: 'getOptions', contentid: String(ep.ID) }).toString()
      });
      if (!response.ok) throw Error('getOptions HTTP ' + response.status);
      const json = await response.json();
      const abys = (json.data?.options || []).find(item => String(item.server).toUpperCase() === 'ABYS');
      if (!abys?.url || new URL(abys.url).protocol !== 'https:') throw Error('ABYS ausente/inválido');
      const iframe = document.createElement('iframe');
      iframe.src = abys.url;
      iframe.allow = 'autoplay; fullscreen; encrypted-media';
      document.body.appendChild(iframe);
      send({ kind: 'stage', value: 'ABYS' });
    } else if (location.hostname === 'abysscdn.com') {
      await waitFor(() => navigator.serviceWorker?.controller?.state === 'activated');
      source = await waitFor(() => {
        try { return jwplayer().getPlaylistItem()?.sources?.find(s => s.label === request.quality)?.file; }
        catch (_) { return null; }
      });
      if (new URL(source).protocol !== 'https:') throw Error('Fonte MP4 inválida');
      try { jwplayer().pause(true); } catch (_) {}
      send({ kind: 'ready', quality: request.quality });
    }
  })().catch(error => send({ kind: 'error', error: String(error.message || error) }));
})();
