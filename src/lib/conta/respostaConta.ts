/**
 * Classificação das respostas que a página `/conta` consome
 * (`/api/user/watchlist`, `/api/user/history`, `/api/billing/me`).
 *
 * Existe porque a página é um client component: a lógica de "o que fazer com uma
 * resposta" precisa viver fora do React para ser exercitada por teste, sem DOM.
 *
 * ## O bug que isto fecha
 *
 * A versão anterior fazia `fetch(...).then(r => r.json()).then(setWatchlist)` sem
 * olhar `r.ok`. Quando a sessão era revogada (conta excluída noutro navegador) ou
 * limitada, `/api/user/watchlist` respondia **401/429 com um OBJETO**
 * (`{ error: "..." }`). Esse objeto ia para `setWatchlist`, e o render seguinte
 * fazia `watchlist.length` / `watchlist.map(...)` sobre um objeto → exceção de
 * cliente ("Application error"). A página só se recuperava após um reload, quando
 * o `useSession` reconsultava o servidor e redirecionava ao login.
 *
 * ## Contrato
 *
 *   - **401** → `revogada`: a sessão em memória não vale mais no servidor. A
 *     página encerra com segurança (signOut → /login), sem renderizar dados
 *     antigos.
 *   - **não-OK** (429, 5xx, …) → `vazio`: estado seguro, nunca um objeto de erro
 *     no lugar da lista.
 *   - **OK + JSON no formato esperado** → `ok` com os dados.
 *   - **OK + JSON inválido ou no formato errado** → `vazio` (fail-safe, sem quebrar
 *     o render).
 */

/** Só o que precisamos de um `Response` — facilita o teste com objetos simples. */
export interface RespostaMinima {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}

export type ResultadoConta<T> =
  | { tipo: "revogada" }
  | { tipo: "ok"; dados: T }
  | { tipo: "vazio" };

/** 401 é o sinal de sessão revogada/expirada no servidor. */
export function sessaoRevogada(status: number): boolean {
  return status === 401;
}

/**
 * Lista (watchlist/histórico): devolve sempre algo seguro para `.map`. Nunca
 * deixa um objeto de erro virar "a lista".
 */
export async function classificarLista(r: RespostaMinima): Promise<ResultadoConta<unknown[]>> {
  if (sessaoRevogada(r.status)) return { tipo: "revogada" };
  if (!r.ok) return { tipo: "vazio" };
  try {
    const dados = await r.json();
    return Array.isArray(dados) ? { tipo: "ok", dados } : { tipo: "vazio" };
  } catch {
    return { tipo: "vazio" };
  }
}

/**
 * Plano comercial (`/api/billing/me`): objeto ou nada. Mantém o mesmo tratamento
 * de 401 (revogada) das listas, para a página encerrar por qualquer dos sinais.
 */
export async function classificarPlano(r: RespostaMinima): Promise<ResultadoConta<Record<string, unknown>>> {
  if (sessaoRevogada(r.status)) return { tipo: "revogada" };
  if (!r.ok) return { tipo: "vazio" };
  try {
    const dados = await r.json();
    return dados && typeof dados === "object" && !Array.isArray(dados)
      ? { tipo: "ok", dados: dados as Record<string, unknown> }
      : { tipo: "vazio" };
  } catch {
    return { tipo: "vazio" };
  }
}
