import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ler = (arquivo: string) => readFileSync(join(process.cwd(), arquivo), "utf8");
const player = ler("src/components/player/CustomPlayer.tsx");
test("grid e continuar assistindo usam páginas que montam player com progresso e identidade próprios", () => {
  assert.ok(ler("src/app/serie/[id]/EpisodeGrid.tsx").includes('href={`/assistir/serie/${serieId}/t${ep.temporada}/ep${ep.numeroEp}`}'));
  const continuar = ler("src/components/ui/ContinuarAssistindo.tsx");
  assert.ok(continuar.includes('`/assistir/filme/${item.id}`'));
  assert.ok(continuar.includes('`/assistir/serie/${item.id}/t${item.temporada}/ep${item.numeroEp}`'));
  const serie = ler("src/app/assistir/serie/[id]/[temp]/[ep]/page.tsx");
  const filme = ler("src/app/assistir/filme/[id]/page.tsx");
  assert.ok(serie.includes('key={episodio.id}'));
  assert.ok(filme.includes('key={filme.id}'));
  for (const pagina of [serie, filme]) assert.ok(pagina.includes('initialProgressoSeg={historico?.progressoSeg ?? 0}'));
});
test("anterior, próximo, contador e auto-next dos dois players usam a transição central", () => {
  assert.equal((player.match(/navegarEpisodioRef\.current\(url\)/g) ?? []).length, 2, "auto-next JW e vídeo nativo");
  assert.equal((player.match(/navegarEpisodioRef\.current\(nextUrl\)/g) ?? []).length, 3, "próximo cabeçalho, controle e contador");
  assert.ok(player.includes('navegarEpisodioRef.current(prevUrl)'));
  assert.ok(player.includes('saveProgressRef.current().catch(() => {}).then(() => router.push(url)).catch(() => {})'));
  assert.ok(player.includes('setNavegandoEpisodio(true)'));
  assert.ok(player.includes('const [carregamentoInicial, setCarregamentoInicial] = useState(true)'));
  assert.ok(player.includes('1000 - (Date.now() - entradaEmRef.current)'));
});
test("mídia só abre depois do fluxo; recuperação permanece em memória", () => {
  const trecho = player.slice(player.indexOf('const abrirSessao = useCallback'), player.indexOf('abrirSessaoRef.current = abrirSessao'));
  assert.ok(trecho.indexOf('await executarFluxoDeAnuncio') < trecho.indexOf('await fetch("/api/player/fontes"'));
  assert.ok(trecho.includes('instanciaDaChamada !== instanciaPlaybackRef.current'));
  assert.ok(player.includes('recuperacaoPlaybackRef.current = null'));
  assert.ok(!/localStorage[^\n]*(recuperacao|instancia)/.test(player));
  assert.ok(player.includes('if (retry) iniciarDownload(retry.operacao.modo, true)'));
  assert.ok(ler("src/components/player/useAnuncio.tsx").includes('if (resolverRef.current !== resolve) return'));
});
