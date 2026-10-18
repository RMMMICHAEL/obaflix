// Sem rede, React, banco ou relógio real: executa a fila e os callbacks do player.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const source = fs.readFileSync('src/components/player/CustomPlayer.tsx', 'utf8');
const ast = ts.createSourceFile('CustomPlayer.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function compile(code, context = {}) {
  const exports = {};
  const result = ts.transpileModule(code, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }, reportDiagnostics: true });
  assert.equal(result.diagnostics?.length ?? 0, 0);
  vm.runInNewContext(result.outputText, { exports, ...context });
  return exports;
}
const { createProgressSaver, PROGRESS_CHECKPOINT_MS } = compile(fs.readFileSync('src/lib/playerProgress.ts', 'utf8'));
const component = ast.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'CustomPlayer');
const declarations = component.body.statements.filter(n => ts.isVariableStatement(n) &&
  n.declarationList.declarations.some(d => ['progressState', 'progressoRef', 'durationRef', 'saveProgress'].includes(d.name.getText(ast))));
const effect = component.body.statements.find(n => ts.isExpressionStatement(n) && n.getText(ast).includes('setInterval(saveProgress, PROGRESS_CHECKPOINT_MS)'));
function callback(predicate) {
  let found;
  function visit(n) { if (predicate(n)) found = n; ts.forEachChild(n, visit); }
  visit(ast); assert.ok(found); return found;
}
const nativeEnded = callback(n => ts.isVariableDeclaration(n) && n.name.getText(ast) === 'onEnded').initializer.getText(ast);
const jwComplete = callback(n => ts.isCallExpression(n) && n.expression.getText(ast) === 'player.on' && n.arguments[0]?.text === 'complete').arguments[1].getText(ast);
const nativePause = callback(n => ts.isVariableDeclaration(n) && n.name.getText(ast) === 'onPause').initializer.getText(ast);
const jwPause = callback(n => ts.isCallExpression(n) && n.expression.getText(ast) === 'player.on' && n.arguments[0]?.text === 'pause').arguments[1].getText(ast);
const navigate = callback(n => ts.isBinaryExpression(n) && n.left.getText(ast) === 'navegarEpisodioRef.current' && ts.isArrowFunction(n.right)).right.getText(ast);
function harness(send = async () => ({ ok: true }), episode = 'ep1', existingState) {
  const events = new Map(), navigations = []; let tick, cleanup, interval;
  const document = { visibilityState: 'visible', addEventListener: (k,v) => events.set(k,v), removeEventListener: k => events.delete(k) };
  const window = { addEventListener: (k,v) => events.set(k,v), removeEventListener: k => events.delete(k) };
  const code = `
    const conteudoId='serie1', conteudoTipo='serie', episodioId=${JSON.stringify(episode)}, temporada=1, numeroEp=1, duracaoSeg=600;
    ${declarations.map(n => n.getText(ast)).join('\n')}
    ${effect.getText(ast)}
    exports.state=progressState; exports.save=saveProgress;
    const unmountedRef={current:false}, saveProgressRef={current:saveProgress};
    exports.nativeEnd=${nativeEnded}; exports.jwEnd=${jwComplete};
    exports.nativePause=${nativePause}; exports.jwPause=${jwPause};
    exports.navigate=${navigate};
  `;
  const video = { currentTime: 600, duration: 600 };
  const player = { position:600, getPosition() { return this.position; }, getDuration: () => 600 };
  const h = compile(code, { createProgressSaver, PROGRESS_CHECKPOINT_MS,
    useMemo: f => existingState ?? f(), useCallback: f => f, useEffect: f => { cleanup = f(); },
    fetch: send, document, window, video, player,
    setPlaying() {}, setControlsVisible() {}, controlsTimerRef: { current:null },
    ambiente:'web', router:{push:url=>navigations.push(url)},
    setInterval: (f, ms) => { tick = f; interval = ms; return 1; }, clearInterval: () => { tick = null; },
  });
  return { ...h, events, document, video, player, navigations, tick: () => tick(), cleanup: () => cleanup(), interval };
}
const flush = () => new Promise(resolve => setImmediate(resolve));
test('2 minutos contínuos: quatro checkpoints; pausa longa não repete; duração alterada salva', async () => {
  const bodies=[]; const h=harness(async (_,o)=>{bodies.push(JSON.parse(o.body)); assert.equal(o.keepalive,true); return {ok:true};});
  assert.equal(h.interval, 30000);
  for(const second of [30,60,90,120]){h.state.position.current=second; await h.tick();}
  assert.equal(bodies.length,4);
  for(let i=0;i<20;i++) await h.tick();
  assert.equal(bodies.length,4);
  h.state.duration.current=601; await h.save(); assert.equal(bodies.length,5);
});
test('início sem reprodução não grava; retorno ao zero após avanço e retomada são preservados', async () => {
  const bodies=[]; const h=harness(async (_,o)=>{bodies.push(JSON.parse(o.body));return {ok:true};});
  await h.save(); assert.equal(bodies.length,0);
  h.state.position.current=60; await h.save();
  h.state.position.current=10; await h.save();
  h.state.position.current=0; await h.save();
  h.state.position.current=5; await h.save();
  assert.deepEqual(bodies.map(b=>b.progressoSeg),[60,10,0,5]);
});
test('eventos simultâneos: um envio ativo, último pendente vence e retorno à posição salva não é perdido', async () => {
  const calls=[], resolvers=[];
  const save=createProgressSaver(s=>{calls.push(s);return new Promise(r=>resolvers.push(r));});
  const a=save({p:10}); await flush(); resolvers.shift()(true); await a;
  const b=save({p:20}); await flush();
  save({p:30}); save({p:40}); const c=save({p:10});
  assert.deepEqual(calls,[{p:10},{p:20}]);
  resolvers.shift()(true); await flush();
  assert.deepEqual(calls,[{p:10},{p:20},{p:10}]);
  resolvers.shift()(true); await Promise.all([b,c]);
});
test('HTTP não ok e erro de rede não confirmam estado: próximo evento tenta novamente', async () => {
  let n=0; const h=harness(async()=>{n++;if(n===1)return {ok:false};if(n===2)throw Error('offline');return {ok:true};});
  h.state.position.current=20;
  await h.save(); await h.save(); await h.save(); await h.save(); assert.equal(n,3);
});
test('pausa/ocultação/pagehide/saída/desmontagem deduplicam e removem listeners; reentrada tem fila própria', async () => {
  const bodies=[];const send=async(_,o)=>{bodies.push(JSON.parse(o.body));return {ok:true};};
  const h=harness(send);h.state.position.current=50;
  await h.save(); // mesmo callback usado pela pausa e saída
  h.document.visibilityState='hidden'; h.events.get('visibilitychange')(); h.events.get('pagehide')();
  h.cleanup(); await flush(); assert.equal(bodies.length,1); assert.equal(h.events.size,0);
  const next=harness(send,'ep2'); await next.save(); assert.equal(bodies.length,1);
  next.state.position.current=15;await next.save();assert.equal(bodies[1].episodioId,'ep2');
  const again=harness(send);again.state.position.current=50;await again.save();assert.equal(bodies.length,3);
  next.cleanup();again.cleanup();await flush();assert.equal(bodies.length,3);
});
test('conclusão nativa e JW leem tempo final e salvam uma vez, sem forçar conclusão em pausa', async () => {
  for(const kind of ['nativeEnd','jwEnd']){
    const bodies=[];const h=harness(async(_,o)=>{bodies.push(JSON.parse(o.body));return {ok:true};});
    h.state.position.current=100;await h.save();assert.equal(bodies[0].progressoSeg,100);
    h[kind]();await flush();await h.save();
    assert.equal(bodies.length,2);assert.equal(bodies[1].progressoSeg,600);assert.equal(bodies[1].duracaoSeg,600);
  }
});
test('evento na finalização de um envio não fica preso na fila', async () => {
  const calls=[];const save=createProgressSaver(async s=>{calls.push(s);return true;});
  await save(1); const p=save(1); queueMicrotask(()=>save(2));await p;await flush();assert.deepEqual(calls,[1,2]);
});
test('callbacks reais de pausa preservam seek ao zero antes do próximo timeupdate', async () => {
  for(const kind of ['nativePause','jwPause']){
    const bodies=[];const h=harness(async(_,o)=>{bodies.push(JSON.parse(o.body));return {ok:true};});
    h.state.position.current=90;await h.save();h.video.currentTime=0;h.player.position=0;
    h[kind]();await flush();assert.deepEqual(bodies.map(b=>b.progressoSeg),[90,0]);
    h[kind]();await flush();assert.equal(bodies.length,2);
  }
});
test('cleanup e nova montagem de efeitos na mesma identidade não duplicam envio nem listeners', async () => {
  let count=0;const send=async()=>{count++;return {ok:true};};const first=harness(send);
  first.state.position.current=30;first.cleanup();await flush();assert.equal(first.events.size,0);
  const second=harness(send,'ep1',first.state);assert.equal(second.events.size,2);
  second.document.visibilityState='hidden';second.events.get('visibilitychange')();second.cleanup();
  await flush();assert.equal(count,1);assert.equal(second.events.size,0);
});
test('troca de episódio com envio antigo em andamento mantém payloads independentes', async () => {
  const bodies=[];let resolveOld;
  const old=harness(async(_,o)=>{bodies.push(JSON.parse(o.body));return new Promise(r=>{resolveOld=r;});});
  old.state.position.current=100;const saving=old.save();await flush();old.cleanup();
  const next=harness(async(_,o)=>{bodies.push(JSON.parse(o.body));return {ok:true};},'ep2');
  await next.save();next.state.position.current=7;await next.save();resolveOld({ok:true});await saving;
  assert.deepEqual(bodies.map(b=>[b.episodioId,b.progressoSeg]),[['ep1',100],['ep2',7]]);
});
test('navegação real de episódio aguarda a gravação consolidada antes de router.push', async () => {
  let finish;const h=harness(async()=>new Promise(r=>{finish=r;}));h.state.position.current=100;
  h.navigate('/assistir/proximo');await flush();assert.equal(h.navigations.length,0);
  finish({ok:true});await flush();assert.deepEqual(h.navigations,['/assistir/proximo']);
});
