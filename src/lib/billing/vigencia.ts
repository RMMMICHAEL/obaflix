/**
 * Vigência de assinatura: duração, renovação, upgrade e downgrade. Módulo puro.
 *
 * ## Regras aprovadas (2026-09-13)
 *
 * - **Meses de calendário.** 5 meses e 1 ano somam meses no calendário; quando o
 *   dia não existe no mês final, vale o último dia daquele mês (31/01 + 1 mês =
 *   28 ou 29/02).
 * - **Renovação do mesmo plano** acrescenta a nova duração ao vencimento atual.
 * - **Upgrade** é imediato e preserva como crédito o valor proporcional do
 *   período ainda não utilizado, calculado só pelo servidor.
 * - **Downgrade** só entra em vigor ao terminar o período já pago.
 *
 * ## Fuso
 *
 * "Dia do mês" depende do fuso. A referência comercial é o horário de Brasília
 * (UTC−3, sem horário de verão desde 2019). O instante de início é convertido
 * para o relógio de Brasília, os meses são somados ali, e o resultado volta a
 * instante UTC — o horário do dia é preservado.
 *
 * ## Ordem entre planos
 *
 * Upgrade e downgrade comparam `Plano.ordem`, a escada comercial gravada no
 * banco — nunca nome ou id de plano.
 */

/** Minutos em relação a UTC do fuso comercial (America/Sao_Paulo). */
export const FUSO_COMERCIAL_MINUTOS = -180;

export const MESES_MAXIMOS = 24;

export type Duracao = { tipo: "dias"; dias: number } | { tipo: "meses"; meses: number };

function instanteValido(d: Date): boolean {
  return d instanceof Date && !Number.isNaN(d.getTime());
}

/** Soma `meses` de calendário a `inicio`, com o último dia do mês quando o dia não existe. */
export function somarMesesCalendario(inicio: Date, meses: number): Date {
  if (!instanteValido(inicio) || !Number.isInteger(meses) || meses < 1 || meses > MESES_MAXIMOS) {
    throw new Error("periodo_invalido");
  }
  const deslocamento = FUSO_COMERCIAL_MINUTOS * 60_000;
  const local = new Date(inicio.getTime() + deslocamento);

  const mesTotal = local.getUTCMonth() + meses;
  const ano = local.getUTCFullYear() + Math.floor(mesTotal / 12);
  const mes = mesTotal % 12;
  const ultimoDia = new Date(Date.UTC(ano, mes + 1, 0)).getUTCDate();
  const dia = Math.min(local.getUTCDate(), ultimoDia);

  const fimLocal = Date.UTC(
    ano, mes, dia,
    local.getUTCHours(), local.getUTCMinutes(), local.getUTCSeconds(), local.getUTCMilliseconds(),
  );
  return new Date(fimLocal - deslocamento);
}

/** Fim de um período que começa em `inicio`. */
export function fimDoPeriodo(inicio: Date, duracao: Duracao): Date {
  if (duracao.tipo === "meses") return somarMesesCalendario(inicio, duracao.meses);
  if (!instanteValido(inicio) || !Number.isInteger(duracao.dias) || duracao.dias <= 0) {
    throw new Error("periodo_invalido");
  }
  return new Date(inicio.getTime() + duracao.dias * 86_400_000);
}

/**
 * Quantos meses de adicional uma duração cobra.
 *
 * Adicionais têm preço mensal e acompanham a assinatura inteira. 30 dias é o
 * "mês" comercial do plano mensal; qualquer outra quantidade de dias não tem
 * equivalência aprovada e é recusada (`null`), em vez de arredondada.
 */
export function mesesCobraveis(duracao: Duracao): number | null {
  if (duracao.tipo === "meses") {
    return Number.isInteger(duracao.meses) && duracao.meses >= 1 && duracao.meses <= MESES_MAXIMOS ? duracao.meses : null;
  }
  return duracao.dias === 30 ? 1 : null;
}

/** Um período pago que ainda não terminou: o vigente ou um agendado. */
export interface PeriodoPago {
  id: string;
  planoId: string;
  /** `Plano.ordem`. */
  ordemDoPlano: number;
  iniciaEm: Date;
  terminaEm: Date;
  /** O que foi cobrado por este período, adicionais incluídos. */
  valorPagoCentavos: number;
}

export type Operacao =
  | { tipo: "nova"; iniciaEm: Date }
  | { tipo: "renovacao"; iniciaEm: Date }
  | { tipo: "downgrade"; iniciaEm: Date }
  | { tipo: "upgrade"; iniciaEm: Date; substitui: string[] };

/**
 * Que operação é esta compra, e quando o período novo começa.
 *
 * - sem período pago em aberto: **nova**, a partir de agora;
 * - mesmo plano do último período da cadeia: **renovação**, no fim da cadeia;
 * - plano de ordem menor que o último da cadeia: **downgrade**, no fim da cadeia;
 * - plano de ordem maior que o vigente: **upgrade**, agora, substituindo o
 *   vigente e os agendados (o tratamento dos agendados depende de regra aprovada
 *   — ver `docs/planos-comerciais.md`).
 */
export function classificarOperacao(entrada: {
  periodos: PeriodoPago[];
  plano: { id: string; ordem: number };
  agora: Date;
}): Operacao {
  const { agora, plano } = entrada;
  const abertos = entrada.periodos
    .filter((p) => p.terminaEm.getTime() > agora.getTime())
    .sort((a, b) => a.iniciaEm.getTime() - b.iniciaEm.getTime());

  if (abertos.length === 0) return { tipo: "nova", iniciaEm: agora };

  const vigente = abertos.find((p) => p.iniciaEm.getTime() <= agora.getTime()) ?? abertos[0];
  const ultimo = abertos[abertos.length - 1];

  if (plano.ordem > vigente.ordemDoPlano) {
    return { tipo: "upgrade", iniciaEm: agora, substitui: abertos.map((p) => p.id) };
  }
  if (plano.id === ultimo.planoId) return { tipo: "renovacao", iniciaEm: ultimo.terminaEm };
  return { tipo: "downgrade", iniciaEm: ultimo.terminaEm };
}

/**
 * O valor não utilizado de um período, em centavos, arredondado para baixo.
 *
 * Proporcional ao tempo restante, em milissegundos: o período vigente vale a
 * fração que falta; um período que ainda não começou vale inteiro.
 *
 * Aritmética inteira exata (`BigInt`): `valor × restante ÷ total` com divisão
 * inteira, que já é o arredondamento para baixo. Em ponto flutuante, um quociente
 * logo abaixo de um inteiro pode ser arredondado para cima pela divisão e o
 * `Math.floor` devolveria um centavo a mais — exatamente o erro que a regra
 * aprovada proíbe.
 */
export function valorNaoUtilizado(periodo: PeriodoPago, agora: Date): number {
  const inicio = periodo.iniciaEm.getTime();
  const fim = periodo.terminaEm.getTime();
  const t = agora.getTime();
  if (!Number.isSafeInteger(periodo.valorPagoCentavos) || periodo.valorPagoCentavos <= 0) return 0;
  if (!Number.isSafeInteger(inicio) || !Number.isSafeInteger(fim) || !Number.isSafeInteger(t) || fim <= inicio) return 0;
  if (t >= fim) return 0;
  if (t <= inicio) return periodo.valorPagoCentavos;
  return proporcaoParaBaixo(periodo.valorPagoCentavos, fim - t, fim - inicio);
}

/** `floor(valor × parte ÷ total)` exato, para inteiros não negativos. */
export function proporcaoParaBaixo(valor: number, parte: number, total: number): number {
  if (![valor, parte, total].every(Number.isSafeInteger) || valor < 0 || parte < 0 || total <= 0) {
    throw new Error("proporcao_invalida");
  }
  return Number((BigInt(valor) * BigInt(parte)) / BigInt(total));
}
