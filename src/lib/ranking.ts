/**
 * A ordenação canônica de "Em alta" e "Populares".
 *
 * ## Por que existe
 *
 * A mesma regra estava escrita quatro vezes — `HomeStreaming` (site e
 * Electron), `/android`, `/api/tv/home` e `/api/home` — e as cópias já tinham
 * divergido: as do site e do Electron ordenavam só por `popularidade`, sem o
 * desempate por `nota` que o app móvel e a TV aplicavam. Duas listas montadas a
 * partir do mesmo banco, no mesmo instante, saíam em ordens diferentes.
 *
 * ## O terceiro critério não é decoração
 *
 * `popularidade` e `nota` empatam com frequência — títulos sem sincronização
 * têm ambos nulos, e a escala do TMDB repete valores. Sem um critério final
 * **determinístico**, o Postgres devolve os empatados na ordem que o plano de
 * execução produzir, e essa ordem pode mudar entre conexões, entre réplicas e
 * entre execuções da mesma query. É por isso que a TV mostrava uma lista e o
 * aplicativo mostrava outra mesmo com o código "igual".
 *
 * `id` como desempate final resolve isso e é a mesma decisão que
 * `catalog-showcases.ts` já tinha tomado (`orderBy: [{ top250: "asc" }, { id:
 * "asc" }]`) — a deduplicação canônica que impede duplicatas de serem
 * escolhidas ao acaso. Aqui ela passa a valer também para popularidade.
 *
 * ## Consequência prática
 *
 * A ordem vira um **total order**: qualquer `take` produz um prefixo do mesmo
 * ranking. Por isso as superfícies podem continuar pedindo quantidades
 * diferentes (a TV cabe mais que o celular) sem divergir — os primeiros N são
 * os mesmos em todas.
 *
 * Cada elemento leva `as const` em vez de a lista inteira: o Prisma espera um
 * array mutável, e um `readonly` na lista toda não é atribuível ao parâmetro.
 */
export const ORDEM_POPULARIDADE = [
  { popularidade: { sort: "desc", nulls: "last" } as const },
  { nota: "desc" as const },
  { id: "asc" as const },
];

/**
 * A ordenação canônica do Top 10.
 *
 * `popularRank` é a posição que o cron `popular-sync` grava — lista ordinal do
 * TMDB, não nota. O desempate por `id` existe pelo mesmo motivo acima: dois
 * títulos podem carregar o mesmo rank durante a janela em que o sync ainda não
 * terminou de reescrever a lista.
 */
export const ORDEM_TOP10 = [
  { popularRank: "asc" as const },
  { id: "asc" as const },
];

/**
 * Quantos itens cada superfície pede.
 *
 * Não precisam ser iguais — a ordenação acima é total, então todo `take` é um
 * prefixo consistente. Ficam aqui só para o número ser encontrável a partir da
 * regra, em vez de espalhado como literal solto em quatro arquivos.
 */
export const LIMITE_VITRINE = 24;
export const LIMITE_TOP10 = 10;
