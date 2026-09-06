package com.obaflix.ads

/**
 * Script injetado no proprio site, dentro da WebView do aplicativo movel — e so
 * dele. Duas responsabilidades:
 *
 *  1. Interceptar a intencao real de reproducao (clique em ASSISTIR / episodio),
 *     que e um `<Link>` do Next e navega por pushState — invisivel para
 *     `shouldOverrideUrlLoading`. Interceptar o clique no proprio documento e a
 *     unica forma de saber da intencao sem mexer em `src/`, compartilhado com o
 *     site na Vercel e com o Electron.
 *  2. Impor uma BARREIRA REAL DE REPRODUCAO enquanto um anuncio esta na tela
 *     (AD_HOLD): nenhum `<video>`/`<audio>` do documento oficial pode tocar nem
 *     avancar `currentTime` ate o anuncio ser realmente dispensado.
 *  3. Observar a troca de episodio feita DENTRO do player. Proximo, anterior e
 *     selecao nao sao ancoras — sao `router.push` do Next, que grava a rota com
 *     `window.history.pushState`. Sem observar o historico, o gate decidia uma
 *     vez na entrada e o usuario emendava episodios sem nenhuma outra decisao.
 *
 * A regra da troca interna e uma so: **a rota mudou para OUTRO episodio =
 * intencao nova**. Ela cobre proximo, anterior, selecao e a contagem regressiva
 * de fim de episodio, venham de onde vierem. E exclui, por construcao e nao por
 * lista, tudo que o produto nao quer contar — retry, failover, troca de fonte,
 * reextracao, reload interno, buffering, recuperacao de erro, resume e
 * remontagem do player nunca mudam a rota. Clique duplicado produz a MESMA rota
 * e cai na deduplicacao por episodio. Quem conta continua sendo o
 * [SeriesAdFrequencyPolicy] no lado nativo: aqui nao existe um segundo contador.
 *
 * Diferenca em relacao ao clique no catalogo: la a navegacao espera a decisao;
 * aqui ela ja aconteceu quando percebemos. Por isso a barreira sobe PROVISORIA
 * no instante da intencao e so depois o gate confirma (anuncio) ou solta
 * (livre) — o episodio novo nunca chega a tocar antes da decisao.
 *
 * O que conta como intencao: clique confiavel (`isTrusted`), botao principal,
 * sem modificadores, numa ancora do proprio site cujo destino e
 * `/assistir/filme/<id>` ou `/assistir/serie/<id>/<temporada>/<episodio>`. Fica
 * de fora: retentativa, buffering, retomada, reconexao, erro de player, troca de
 * servidor, failover, re-resolucao — nada disso navega.
 *
 * Barreira em profundidade (a falha do teste fisico foi o player ESCAPAR do
 * hold): confiar so em adiar `resolve` da extracao nao basta, porque ha caminhos
 * de fonte que chegam ao player por outra rota. Entao, durante o hold:
 *
 *  - **Defer**: `__obaflixAdGateDefer` (usado pelo shim) adia a entrega da
 *    extracao — o player nem recebe o stream, entao nem arma seus vigias de
 *    primeiro-frame. Continua sendo o caminho preferido (overlap sem ruido).
 *  - **Bloqueio de play()**: `HTMLMediaElement.prototype.play` e interceptado e
 *    devolve sem tocar; listeners de captura para `play`/`playing`/`timeupdate`
 *    pausam e zeram `currentTime` de qualquer midia que tente avancar. E a
 *    garantia final, independente de como o stream chegou.
 *  - **Freio dos vigias**: os vigias de primeiro-frame do player sao
 *    `setTimeout` longos (7s) que, sem primeiro frame, trocam de servidor. Com o
 *    anuncio na tela a ausencia de frame e INTENCIONAL — deixar o vigia correr
 *    faria failover por tras do anuncio. Durante o hold, timers longos armados
 *    no documento nao disparam: ficam congelados e sao rearmados INTEIROS na
 *    liberacao, entao cada vigia recebe seu prazo cheio depois do anuncio, e
 *    travamento real fora do hold continua sendo detectado como antes.
 *  - **Espera intencional nao e travamento**: a sonda de diagnostico comeca a
 *    contar `travado` no evento `waiting`. Durante o hold esse evento e
 *    interrompido na captura, entao `js_travado` nao aparece por causa do
 *    anuncio — e volta a valer intacto assim que o hold sai.
 *
 * Vocabulario dos logs, porque a diferenca importa no criterio fisico:
 * `ads_play_bloqueado` e uma tentativa BARRADA antes de qualquer frame (o
 * esperado, o mecanismo funcionando); `ads_hold_violation` e o escape real —
 * evento `playing`, ou `currentTime` que andou. So o segundo reprova o teste.
 *
 * Persistencia entre navegacoes: o hold e espelhado em `sessionStorage`, porque a
 * navegacao para `/assistir` pode ser pushState (mesmo window) ou um load novo
 * (window recriado). No load novo, este script e reinjetado e restaura o hold —
 * reinstalando o bloqueio ANTES de o player poder dar autoplay.
 *
 * Quem decide QUANDO soltar o hold e o lado nativo ([PlaybackAdGate]), que so
 * chama `__obaflixAdGateResume` quando a Activity/overlay do Unity realmente
 * sumiu e a MainActivity voltou ao foco. Aqui a gente so obedece: solta a
 * barreira, libera a fila adiada e da UM autoplay.
 *
 * Fail-open: erro ao falar com a ponte, ancora sumida, ou lado nativo mudo — a
 * navegacao segue assim mesmo. Geracao (`gen`) descarta preparacao/ callbacks de
 * um toque anterior.
 */
internal object AdGateScript {

    /** Sem resposta do lado nativo neste prazo, a navegacao segue sozinha. */
    private const val LIMITE_SEM_RESPOSTA_MS = 10_000

    /**
     * @param capability token que autoriza a chamada a `_obaflixAds`, o mesmo
     *   mecanismo ja usado pela ponte principal.
     */
    fun paraCapability(capability: String): String = """
        (function () {
            if (window.__obaflixAdGateInstalado) return;
            window.__obaflixAdGateInstalado = true;

            var CAP = '$capability';
            var LIMITE = $LIMITE_SEM_RESPOSTA_MS;
            var FILME = /^\/assistir\/filme\/[^\/]+\/?${'$'}/;
            var EPISODIO = /^\/assistir\/serie\/[^\/]+\/[^\/]+\/[^\/]+\/?${'$'}/;
            var CHAVE_HOLD = '__obaflixAdHold';

            // Os timers DO PROPRIO gate (fail-open, espera pela decisao) usam o
            // setTimeout original de proposito: durante o hold o freio adia
            // qualquer prazo longo, e um fail-open congelado seria um impasse —
            // a barreira so sairia pelo prazo que ela mesma segurou.
            var setTimeoutOriginal = window.setTimeout;
            var clearTimeoutOriginal = window.clearTimeout;

            // Acima deste prazo um timer nao e animacao nem debounce de UI: e um
            // vigia medindo progresso de reproducao (o do primeiro frame usa 7s).
            // Sao esses, e so esses, que o hold congela.
            var LIMITE_TIMER_MS = 2000;

            // Teto de linhas por tipo de evento: 'timeupdate' dispara varias
            // vezes por segundo e inundaria a trilha do log.
            var MAX_DIAG = 8;

            function diag(ev, det) {
                try { window._obaflixAds.diag(CAP, ev, det || ''); } catch (e) {}
            }

            function diagLimitado(ev, det) {
                var n = (hold.contagem[ev] || 0) + 1;
                hold.contagem[ev] = n;
                if (n <= MAX_DIAG) diag(ev, det);
            }

            // gateId -> { el, href, timer, navegou, interno, episodio }
            var pendentes = {};
            var sequencia = 0;

            // Episodio pelo qual o gate JA decidiu. Enquanto a rota nao mudar
            // para OUTRO, nada e intencao nova — e por isso que reload interno,
            // resume, retry, failover e remontagem do player nao contam.
            var episodioAtual = null;

            // chave do episodio -> gateId em voo. Garante que uma acao so seja
            // contada uma vez, mesmo que o clique gere varias gravacoes de rota.
            var intencoes = {};

            // Ultimo evento confiavel do usuario. Serve so para rotular o log
            // (`_auto` quando a troca veio da contagem regressiva de fim de
            // episodio, sem toque); nao muda a decisao.
            var ultimoGesto = 0;
            var JANELA_DE_GESTO_MS = 3000;

            // AD_HOLD. So um por vez: o gate nativo nunca abre um segundo anuncio
            // enquanto o primeiro esta na tela.
            var hold = {
                ativo: false, gen: 0, gateId: null, fila: [], patch: null, midia: [],
                provisorio: false,   // armado na intencao, antes de o gate decidir
                contagem: {},        // evento -> quantas vezes ja foi logado
                timerPatch: null,    // { set, clear } originais, enquanto congelado
                timers: {},          // id -> registro de timer longo em espera
                congelados: []       // vencidos durante o hold, a rearmar na saida
            };

            // -- persistencia entre navegacoes -----------------------------------
            function salvarHold() {
                try {
                    if (hold.ativo) {
                        sessionStorage.setItem(CHAVE_HOLD, hold.gen + ':' + (hold.gateId || ''));
                    } else {
                        sessionStorage.removeItem(CHAVE_HOLD);
                    }
                } catch (e) {}
            }
            function lerHoldSalvo() {
                try { return sessionStorage.getItem(CHAVE_HOLD); } catch (e) { return null; }
            }

            // -- barreira REAL de reproducao -------------------------------------
            function estaBloqueado() { return hold.ativo; }
            window.__obaflixAdGateBloqueado = estaBloqueado;

            function registrarMidia(el) {
                if (el && hold.midia.indexOf(el) < 0) hold.midia.push(el);
            }

            function ehMidia(el) {
                return !!el && (el.tagName === 'VIDEO' || el.tagName === 'AUDIO');
            }

            /**
             * Freia uma midia que tentou avancar durante o hold.
             *
             * `escapou` separa as duas coisas que o teste fisico precisa
             * distinguir: uma tentativa barrada antes de qualquer frame e o
             * mecanismo funcionando; `playing` ou `currentTime > 0` e o player
             * tendo escapado de verdade.
             */
            function frear(el, motivo, escapou) {
                if (el.__obaflixAdGateHerdado) {
                    // Midia do episodio ANTERIOR, ainda tocando no instante em que
                    // o usuario pediu outro episodio. Silenciar e certo; chamar de
                    // escape seria mentira, e zerar `currentTime` atropelaria o
                    // progresso que o player acabou de salvar. Marca de um uso so:
                    // se ela voltar a tocar, ja conta como qualquer outra.
                    el.__obaflixAdGateHerdado = false;
                    try { el.pause(); } catch (e) {}
                    diagLimitado('ads_hold_midia_anterior_pausada', motivo);
                    return;
                }
                try { el.pause(); } catch (e) {}
                try { if (el.currentTime > 0) el.currentTime = 0; } catch (e) {}
                registrarMidia(el);
                diagLimitado(escapou ? 'ads_hold_violation' : 'ads_play_bloqueado', motivo);
            }

            /**
             * Marca a midia que ja estava no documento quando o hold foi armado.
             * So faz sentido na troca de episodio dentro do player: o episodio que
             * o usuario estava assistindo ainda esta no ar quando ele pede o
             * proximo.
             */
            function marcarMidiaHerdada() {
                try {
                    var listas = [
                        document.getElementsByTagName('video'),
                        document.getElementsByTagName('audio')
                    ];
                    for (var l = 0; l < listas.length; l++) {
                        var els = listas[l];
                        for (var i = 0; i < els.length; i++) els[i].__obaflixAdGateHerdado = true;
                    }
                } catch (e) {}
            }

            function pausarMidia(ev) {
                if (!hold.ativo) return;
                if (!ehMidia(ev.target)) return;
                var el = ev.target;
                var andou = false;
                try { andou = el.currentTime > 0; } catch (e) {}
                // 'timeupdate' com o tempo ainda em zero e ruido de carga: nao e
                // escape, e nem vale uma linha de log.
                if (ev.type === 'timeupdate' && !andou) return;
                frear(el, ev.type, ev.type === 'playing' || andou);
            }

            /**
             * A espera durante o anuncio e intencional, entao nao pode alimentar
             * o contador de travamento da sonda de diagnostico (que so comeca a
             * contar no 'waiting'). Interromper na captura impede que o listener
             * do proprio elemento veja o evento, sem tocar em codigo
             * compartilhado. Fora do hold, nada muda: travamento real continua
             * virando `js_travado` como antes.
             */
            function engolirEspera(ev) {
                if (!hold.ativo) return;
                if (!ehMidia(ev.target)) return;
                ev.stopPropagation();
                diagLimitado('ads_hold_waiting_suprimido', '');
            }

            // -- freio dos vigias de primeiro-frame ------------------------------
            //
            // Os vigias do player sao setTimeout longos que trocam de servidor
            // quando o primeiro frame nao vem. Com o anuncio na tela a ausencia de
            // frame e proposital, e deixa-los correr provocaria failover por tras
            // do anuncio. Aqui os timers longos armados durante o hold nao
            // disparam: quando vencem, entram na fila de congelados e sao
            // rearmados com o prazo INTEIRO na liberacao — cada vigia ganha sua
            // janela cheia depois do anuncio. Timers curtos (UI, debounce) passam
            // intactos, e fora do hold o relogio da pagina e o original.
            function instalarFreioDeTimers() {
                if (hold.timerPatch) return;
                var origSet = window.setTimeout;
                var origClear = window.clearTimeout;

                window.setTimeout = function (fn, ms) {
                    var atraso = Number(ms) || 0;
                    if (!hold.ativo || atraso < LIMITE_TIMER_MS || typeof fn !== 'function') {
                        return origSet.apply(window, arguments);
                    }
                    var extras = Array.prototype.slice.call(arguments, 2);
                    var reg = { fn: fn, ms: atraso, args: extras, morto: false, id: 0 };
                    reg.id = origSet.call(window, function () {
                        delete hold.timers[reg.id];
                        if (reg.morto) return;
                        if (!hold.ativo) { reg.fn.apply(window, reg.args); return; }
                        hold.congelados.push(reg);
                        diagLimitado('ads_hold_timer_adiado', String(atraso));
                    }, atraso);
                    hold.timers[reg.id] = reg;
                    return reg.id;
                };

                window.clearTimeout = function (id) {
                    var reg = hold.timers[id];
                    if (reg) { reg.morto = true; delete hold.timers[id]; }
                    return origClear.apply(window, arguments);
                };

                hold.timerPatch = { set: origSet, clear: origClear };
            }

            function removerFreioDeTimers() {
                var p = hold.timerPatch;
                if (!p) return;
                window.setTimeout = p.set;
                window.clearTimeout = p.clear;
                hold.timerPatch = null;
                hold.timers = {};
                var fila = hold.congelados;
                hold.congelados = [];
                var rearmados = 0;
                for (var i = 0; i < fila.length; i++) {
                    var reg = fila[i];
                    if (reg.morto) continue;
                    rearmados++;
                    (function (r) {
                        p.set.call(window, function () { r.fn.apply(window, r.args); }, r.ms);
                    })(reg);
                }
                if (rearmados) diag('ads_hold_timer_rearmado', String(rearmados));
            }

            function instalarBloqueio() {
                instalarFreioDeTimers();
                if (hold.patch) return;
                var proto = window.HTMLMediaElement && HTMLMediaElement.prototype;
                if (!proto) return;
                var origPlay = proto.play;
                proto.play = function () {
                    if (hold.ativo) {
                        // Nao toca: registra a tentativa para dar UM autoplay na
                        // liberacao e devolve promise resolvida (nao parece erro
                        // de autoplay para o player).
                        try { this.pause(); } catch (e) {}
                        registrarMidia(this);
                        diagLimitado('ads_play_bloqueado', 'play');
                        return (typeof Promise !== 'undefined') ? Promise.resolve() : undefined;
                    }
                    return origPlay.apply(this, arguments);
                };
                document.addEventListener('play', pausarMidia, true);
                document.addEventListener('playing', pausarMidia, true);
                document.addEventListener('timeupdate', pausarMidia, true);
                document.addEventListener('waiting', engolirEspera, true);
                hold.patch = { proto: proto, origPlay: origPlay };
            }

            function removerBloqueio() {
                removerFreioDeTimers();
                var p = hold.patch;
                if (!p) return;
                try { p.proto.play = p.origPlay; } catch (e) {}
                document.removeEventListener('play', pausarMidia, true);
                document.removeEventListener('playing', pausarMidia, true);
                document.removeEventListener('timeupdate', pausarMidia, true);
                document.removeEventListener('waiting', engolirEspera, true);
                hold.patch = null;
            }

            // -- ciclo do hold ---------------------------------------------------
            function ativarHold(gen, gateId, provisorio) {
                hold.ativo = true;
                hold.gen = gen;
                hold.gateId = gateId;
                hold.provisorio = !!provisorio;
                hold.midia = [];
                hold.contagem = {};
                marcarMidiaHerdada();
                salvarHold();
                instalarBloqueio();
                diag('ads_hold_armed', provisorio ? 'provisorio' : String(gen));
            }

            function limparHold() {
                hold.ativo = false;
                hold.provisorio = false;
                salvarHold();
                removerBloqueio();
                diag('ads_hold_cleared');
                // Um autoplay nos elementos que tentaram tocar durante o hold.
                var els = hold.midia.slice();
                hold.midia = [];
                for (var i = 0; i < els.length; i++) {
                    try { els[i].play(); } catch (e) {}
                }
            }

            // Usado pelo shim quando uma extracao resolve: com hold ativo, adia a
            // entrega ao player ate o fechamento. Retorna true se adiou.
            window.__obaflixAdGateDefer = function (thunk) {
                if (!hold.ativo) return false;
                hold.fila.push({ gen: hold.gen, run: thunk });
                diag('ads_preload_ready');
                return true;
            };

            function tipoDoDestino(href) {
                var u;
                try { u = new URL(href, location.href); } catch (e) { return null; }
                if (u.origin !== location.origin) return null;
                if (FILME.test(u.pathname)) return 'movie';
                if (EPISODIO.test(u.pathname)) return 'episode';
                return null;
            }

            function navegar(p) {
                var el = p.el;
                if (el && el.isConnected) {
                    el.__obaflixAdGatePass = true;
                    el.click();
                } else {
                    location.assign(p.href);
                }
            }

            // Anuncio vai aparecer: arma o hold (bloqueio + defer) e navega JA,
            // para preparar em paralelo por tras do anuncio.
            //
            // Na troca de episodio dentro do player a barreira ja subiu como
            // PROVISORIA no instante da intencao (a navegacao interna e o player
            // do episodio novo nao esperam ninguem). Aqui ela so e confirmada:
            // mesma geracao, mesma fila adiada. Rearmar bumparia `gen` e
            // descartaria como stale o que ja foi preparado por tras do anuncio.
            /**
             * A decisao do gate para esta intencao chegou: ela deixa de estar em
             * voo. A protecao contra contar duas vezes passa a ser [episodioAtual],
             * que so muda quando a rota vai para OUTRO episodio.
             */
            function encerrarIntencao(id) {
                var p = pendentes[id];
                if (p && p.episodio && intencoes[p.episodio] === id) delete intencoes[p.episodio];
            }

            function segurar(id) {
                var p = pendentes[id];
                if (!p) return;
                encerrarIntencao(id);
                if (p.timer) { clearTimeoutOriginal(p.timer); p.timer = 0; }
                if (hold.ativo && hold.gateId === id) {
                    hold.provisorio = false;
                    diag('ads_hold_confirmado', String(hold.gen));
                    return;
                }
                if (hold.ativo && hold.gateId !== id) {
                    hold.fila = [];
                    diag('ads_preload_cancelled');
                }
                ativarHold(hold.gen + 1, id, false);
                if (!p.navegou) {
                    p.navegou = true;
                    navegar(p);
                    diag('ads_preload_route_started');
                }
            }

            // Libera. Para o gate em hold (ou um hold restaurado de load novo):
            // solta a barreira, roda a fila adiada e da o autoplay. Para um gate
            // que nunca entrou em hold (caminho sem anuncio): navega como antes.
            function seguir(id) {
                encerrarIntencao(id);
                if (hold.ativo && (hold.gateId === id || hold.gateId === null)) {
                    var g = hold.gen;
                    var fila = hold.fila;
                    // Barreira provisoria: a intencao existiu, mas o gate decidiu
                    // que este episodio e livre. Nenhum anuncio apareceu, e a
                    // liberacao vale o mesmo — so o motivo no log muda.
                    var motivo = hold.provisorio ? 'livre' : 'dismiss';
                    hold.fila = [];
                    hold.gateId = null;
                    limparHold();
                    diag('ads_release', motivo);
                    if (fila.length) {
                        diag('ads_autoplay_after_release');
                        for (var i = 0; i < fila.length; i++) {
                            if (fila[i].gen === g) {
                                try { fila[i].run(); } catch (e) {}
                            } else {
                                diag('ads_callback_ignorado', 'stale');
                            }
                        }
                    }
                    if (pendentes[id]) delete pendentes[id];
                    return;
                }
                var p = pendentes[id];
                if (!p) { diag('ads_callback_ignorado', 'duplicate'); return; }
                delete pendentes[id];
                if (p.timer) { clearTimeoutOriginal(p.timer); p.timer = 0; }
                // Intencao interna do player: a navegacao ja aconteceu sozinha e
                // nao ha nada a disparar — a decisao "livre" e simplesmente o fim
                // da barreira, tratada no ramo de cima.
                if (p.interno) { diag('ads_episode_liberado'); return; }
                if (p.navegou) { diag('ads_callback_ignorado', 'duplicate'); return; }
                p.navegou = true;
                navegar(p);
            }

            window.__obaflixAdGateResume = seguir;
            window.__obaflixAdGateHold = segurar;

            // Restaura o hold apos uma navegacao com load novo (window recriado),
            // reinstalando o bloqueio antes de o player poder dar autoplay.
            (function restaurar() {
                var salvo = lerHoldSalvo();
                if (!salvo) return;
                var partes = salvo.split(':');
                hold.ativo = true;
                hold.gen = parseInt(partes[0], 10) || 0;
                hold.gateId = partes[1] || null;
                instalarBloqueio();
                diag('ads_hold_restaurado', partes[0] || '');
            })();

            function novoGateId() {
                return 'g' + (++sequencia) + 'x' + Date.now().toString(36);
            }

            document.addEventListener('click', function (ev) {
                if (ev.isTrusted) ultimoGesto = Date.now();

                var alvo = ev.target;
                var a = alvo && alvo.closest ? alvo.closest('a[href]') : null;
                if (!a) return;

                if (a.__obaflixAdGatePass) { a.__obaflixAdGatePass = false; return; }

                if (!ev.isTrusted) return;
                if (ev.defaultPrevented) return;
                if (ev.button !== 0) return;
                if (ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) return;
                if (a.target && a.target !== '_self') return;

                var destino = a.getAttribute('href');
                var tipo = tipoDoDestino(destino);
                if (!tipo) return;

                ev.preventDefault();
                ev.stopImmediatePropagation();

                var id = novoGateId();
                var registro = {
                    el: a,
                    href: new URL(destino, location.href).href,
                    timer: 0,
                    navegou: false,
                    interno: false
                };
                registro.timer = setTimeoutOriginal(function () { seguir(id); }, LIMITE);
                pendentes[id] = registro;

                // O gate ja decidiu por este episodio: a rota que vem a seguir e
                // consequencia deste mesmo toque, nao uma intencao nova.
                marcarEpisodioDecidido(caminhoDe(registro.href));

                try {
                    window._obaflixAds.requestPlayback(CAP, id, tipo, 'catalogo');
                } catch (e) {
                    seguir(id);
                }
            }, true);

            // -- troca de episodio DENTRO do player -------------------------------
            //
            // Proximo/anterior/selecao no player nao sao ancoras: sao
            // `router.push(url)` do Next, que grava a rota com
            // `window.history.pushState`. Por isso o interceptador de clique nao
            // via nada — o log mostrou uma unica decisao do gate e quatro
            // episodios depois dela. Observar o historico e o sinal mais proximo
            // da intencao real, e o unico que nao depende de conhecer o layout
            // dos botoes (que vive em `src/`, intocado).
            //
            // A regra e uma so: mudou para OUTRO episodio = intencao nova.
            // Failover, retry, reextracao, troca de fonte, recuperacao de erro,
            // resume e reconstrucao do player nunca mudam a rota, entao nunca
            // chegam aqui. Clique duplicado gera a MESMA rota, e a deduplicacao
            // por episodio o descarta.
            function caminhoDe(href) {
                try { return new URL(href, location.href).pathname; } catch (e) { return ''; }
            }

            function episodioDe(caminho) {
                var m = /^\/assistir\/serie\/([^\/]+)\/([^\/]+)\/([^\/]+)\/?${'$'}/.exec(caminho || '');
                if (!m) return null;
                return {
                    chave: m[1] + '|' + m[2] + '|' + m[3],
                    serie: m[1],
                    temp: parseInt(m[2], 10),
                    num: parseInt(m[3], 10)
                };
            }

            function direcaoEntre(de, para) {
                if (!de || de.serie !== para.serie || de.temp !== para.temp) return 'select';
                if (para.num === de.num + 1) return 'next';
                if (para.num === de.num - 1) return 'previous';
                return 'select';
            }

            function marcarEpisodioDecidido(caminho) {
                var ep = episodioDe(caminho);
                if (ep) episodioAtual = ep;
            }

            /**
             * Uma rota nova apareceu. Decide se ela e uma intencao de iniciar
             * OUTRO episodio e, se for, sobe a barreira ANTES de perguntar ao
             * gate — o player do episodio novo ja esta montando e nao espera
             * ninguem. A decisao do lado nativo entao confirma (anuncio) ou
             * solta (livre).
             */
            function avaliarRota() {
                var ep = episodioDe(location.pathname);
                if (!ep) return;
                if (episodioAtual && episodioAtual.chave === ep.chave) return;
                if (intencoes[ep.chave]) {
                    diag('ads_episode_intent_dedup', 'em_voo');
                    return;
                }

                var direcao = direcaoEntre(episodioAtual, ep);
                var comGesto = (Date.now() - ultimoGesto) < JANELA_DE_GESTO_MS;
                episodioAtual = ep;

                var id = novoGateId();
                intencoes[ep.chave] = id;
                diag('ads_episode_intent', 'player_' + direcao + (comGesto ? '' : '_auto'));

                var registro = { el: null, href: '', timer: 0, navegou: true, interno: true, episodio: ep.chave };
                pendentes[id] = registro;

                // Barreira JA: entre a intencao e a resposta do lado nativo o
                // episodio novo nao pode tocar nem avancar `currentTime`. Se o
                // gate disser "livre", isto sai em milissegundos.
                if (!hold.ativo) ativarHold(hold.gen + 1, id, true);

                registro.timer = setTimeoutOriginal(function () { seguir(id); }, LIMITE);

                try {
                    window._obaflixAds.requestPlayback(CAP, id, 'episode', 'player');
                } catch (e) {
                    seguir(id);
                }
            }

            function observarHistorico() {
                var h = window.history;
                if (!h || h.__obaflixAdGateObservado) return;
                h.__obaflixAdGateObservado = true;

                function envolver(nome) {
                    var original = h[nome];
                    if (typeof original !== 'function') return;
                    h[nome] = function () {
                        var r = original.apply(h, arguments);
                        try { avaliarRota(); } catch (e) {}
                        return r;
                    };
                }
                envolver('pushState');
                envolver('replaceState');
                try {
                    window.addEventListener('popstate', function () {
                        try { avaliarRota(); } catch (e) {}
                    });
                } catch (e) {}
            }

            // O episodio em que a pagina ja esta nunca e uma intencao nova: ou o
            // gate ja decidiu por ele (clique no catalogo), ou e um load direto
            // nesta rota. Semear aqui e o que impede uma decisao duplicada logo
            // no primeiro `pushState` do Next.
            marcarEpisodioDecidido(location.pathname);
            observarHistorico();
        })();
    """.trimIndent()
}
