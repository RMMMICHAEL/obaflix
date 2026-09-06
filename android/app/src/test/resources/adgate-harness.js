// Ambiente minimo de navegador para exercitar o AdGateScript num motor JS puro.
//
// Existe porque a BARREIRA de reproducao do anuncio e JavaScript: bloqueio de
// play(), listeners de captura, freio dos vigias de primeiro-frame e supressao
// da espera. Nada disso e observavel num teste que so olhe o Kotlin — e era
// justamente a barreira que falhou no teste fisico. Aqui ela roda de verdade,
// com relogio controlado, e o teste afirma o comportamento, nao o texto do
// script.
//
// O que este arquivo NAO tenta ser: um navegador. Sao apenas as pecas que o
// script toca — document com captura, HTMLMediaElement com play/pause,
// sessionStorage, setTimeout/clearTimeout, URL e a ponte _obaflixAds.

var window = this;

// -- relogio controlado ------------------------------------------------------
var agora = 0;
var timers = [];
var proximoTimer = 1;

function setTimeout(fn, ms) {
    var t = {
        id: proximoTimer++,
        fn: fn,
        quando: agora + (Number(ms) || 0),
        args: Array.prototype.slice.call(arguments, 2),
        morto: false
    };
    timers.push(t);
    return t.id;
}

function clearTimeout(id) {
    for (var i = 0; i < timers.length; i++) {
        if (timers[i].id === id) timers[i].morto = true;
    }
}

/** Avanca o relogio disparando, em ordem, tudo que vence no caminho. */
function avancarRelogio(ms) {
    var limite = agora + ms;
    for (;;) {
        var prox = null;
        for (var i = 0; i < timers.length; i++) {
            var t = timers[i];
            if (t.morto || t.quando > limite) continue;
            if (!prox || t.quando < prox.quando) prox = t;
        }
        if (!prox) break;
        prox.morto = true;
        agora = prox.quando;
        prox.fn.apply(window, prox.args);
    }
    agora = limite;
}

// -- armazenamento -----------------------------------------------------------
var sessionStorage = {
    _m: {},
    setItem: function (k, v) { this._m[k] = String(v); },
    getItem: function (k) {
        return Object.prototype.hasOwnProperty.call(this._m, k) ? this._m[k] : null;
    },
    removeItem: function (k) { delete this._m[k]; }
};

// -- location / URL / history ------------------------------------------------
var ORIGEM = 'https://obaflix.vercel.app';
var location = {
    href: ORIGEM + '/', origin: ORIGEM, pathname: '/',
    assign: function (h) { irPara(h); }
};

function irPara(url) {
    var u = new URL(url, location.href);
    location.href = u.href;
    location.pathname = u.pathname;
}

// O `router.push` do Next grava a rota por aqui — e e este o sinal que o gate
// observa para ver troca de episodio dentro do player.
var history = {
    pushState: function (estado, titulo, url) { if (url) irPara(url); },
    replaceState: function (estado, titulo, url) { if (url) irPara(url); }
};

var _ouvintesDaJanela = {};
function addEventListener(tipo, fn) {
    (_ouvintesDaJanela[tipo] = _ouvintesDaJanela[tipo] || []).push(fn);
}
function dispararNaJanela(tipo) {
    var l = (_ouvintesDaJanela[tipo] || []).slice();
    for (var i = 0; i < l.length; i++) l[i]({ type: tipo });
}

function URL(href, base) {
    var completa = href;
    if (String(href).indexOf('http') !== 0) {
        var b = String(base || location.href).match(/^(https?:\/\/[^\/]+)/);
        completa = b[1] + (String(href).charAt(0) === '/' ? href : '/' + href);
    }
    var m = String(completa).match(/^(https?:\/\/[^\/]+)([^?#]*)/);
    this.origin = m[1];
    this.pathname = m[2] || '/';
    this.href = completa;
}

// -- eventos: captura no document, depois o alvo -----------------------------
var document = {
    documentElement: {},
    _captura: {},
    _midias: { video: [], audio: [] },
    addEventListener: function (tipo, fn) {
        (this._captura[tipo] = this._captura[tipo] || []).push(fn);
    },
    removeEventListener: function (tipo, fn) {
        var l = this._captura[tipo] || [];
        var i = l.indexOf(fn);
        if (i >= 0) l.splice(i, 1);
    },
    getElementsByTagName: function (tag) {
        return this._midias[String(tag).toLowerCase()] || [];
    },
    ouvintesDe: function (tipo) { return (this._captura[tipo] || []).length; }
};

/**
 * Dispara um evento como o navegador faz: primeiro a captura no document,
 * depois os ouvintes do proprio alvo. `stopPropagation` na captura impede a
 * fase do alvo — e exatamente disso que a supressao de `waiting` depende.
 */
function disparar(tipo, alvo, extras) {
    var ev = {
        type: tipo,
        target: alvo,
        parado: false,
        stopPropagation: function () { this.parado = true; },
        stopImmediatePropagation: function () { this.parado = true; }
    };
    if (extras) for (var k in extras) ev[k] = extras[k];

    var cap = (document._captura[tipo] || []).slice();
    for (var i = 0; i < cap.length; i++) {
        cap[i](ev);
        if (ev.parado) break;
    }
    if (ev.parado) return ev;

    var proprios = (alvo && alvo._ouvintes && alvo._ouvintes[tipo]) || [];
    for (var j = 0; j < proprios.length; j++) proprios[j](ev);
    return ev;
}

// -- midia -------------------------------------------------------------------
function HTMLMediaElement() {}
HTMLMediaElement.prototype.play = function () {
    this.paused = false;
    this.chamadasDePlay = (this.chamadasDePlay || 0) + 1;
    return { then: function () {}, catch: function () {} };
};
HTMLMediaElement.prototype.pause = function () { this.paused = true; };

function novoVideo() {
    var v = Object.create(HTMLMediaElement.prototype);
    v.tagName = 'VIDEO';
    v.currentTime = 0;
    v.paused = true;
    v.chamadasDePlay = 0;
    v._ouvintes = {};
    v.addEventListener = function (tipo, fn) {
        (this._ouvintes[tipo] = this._ouvintes[tipo] || []).push(fn);
    };
    document._midias.video.push(v);
    return v;
}

// -- ponte nativa ------------------------------------------------------------
var LOG = [];
var pedidos = [];
var _obaflixAds = {
    diag: function (cap, ev, det) { LOG.push(det ? ev + ':' + det : ev); },
    requestPlayback: function (cap, id, tipo, origem) {
        pedidos.push({ id: id, tipo: tipo, origem: origem });
    }
};

// -- utilidades para o teste -------------------------------------------------
function logs() { return LOG.join('|'); }
function limparLog() { LOG = []; }
function contarLog(evento) {
    var n = 0;
    for (var i = 0; i < LOG.length; i++) {
        if (LOG[i] === evento || LOG[i].indexOf(evento + ':') === 0) n++;
    }
    return n;
}

function novaAncora(href) {
    var a = {
        target: '',
        isConnected: true,
        cliques: 0,
        getAttribute: function () { return href; },
        click: function () { this.cliques++; }
    };
    a.closest = function () { return a; };
    return a;
}

/** Clique real do usuario numa ancora de /assistir. Devolve o gateId gerado. */
function clicar(href) {
    var a = novaAncora(href);
    disparar('click', a, {
        isTrusted: true,
        defaultPrevented: false,
        button: 0,
        metaKey: false, ctrlKey: false, shiftKey: false, altKey: false,
        preventDefault: function () { this.defaultPrevented = true; }
    });
    ultimaAncora = a;
    return pedidos.length ? pedidos[pedidos.length - 1].id : null;
}

var ultimaAncora = null;

/** Clique + decisao "vai ter anuncio": deixa o AD_HOLD armado. */
function armarHold(href) {
    var id = clicar(href || '/assistir/filme/123');
    window.__obaflixAdGateHold(id);
    return id;
}

// -- troca de episodio dentro do player --------------------------------------

/** O que `router.push('/assistir/serie/…')` do Next faz por baixo. */
function rotaDoPlayer(caminho) {
    window.history.pushState({ __NA: true }, '', caminho);
}

function caminhoDoEpisodio(temporada, numero) {
    return '/assistir/serie/77/' + temporada + '/' + numero;
}

/** Troca de episodio pelo player, como se o usuario tivesse tocado num botao. */
function trocarEpisodio(temporada, numero) {
    ultimoGestoDoTeste();
    rotaDoPlayer(caminhoDoEpisodio(temporada, numero));
    return ultimoPedido();
}

/** Troca sem toque nenhum: a contagem regressiva de fim de episodio. */
function trocarEpisodioSemGesto(temporada, numero) {
    rotaDoPlayer(caminhoDoEpisodio(temporada, numero));
    return ultimoPedido();
}

/** Marca um toque confiavel recente, sem navegar. */
function ultimoGestoDoTeste() {
    disparar('click', { closest: function () { return null; } }, { isTrusted: true });
}

function ultimoPedido() {
    return pedidos.length ? pedidos[pedidos.length - 1] : null;
}

/** Resposta do lado nativo: episodio livre, sem anuncio. */
function responderLivre(id) { window.__obaflixAdGateResume(id); }

/** Resposta do lado nativo: anuncio devido — confirma a barreira. */
function responderAnuncio(id) { window.__obaflixAdGateHold(id); }
