import { FUSO_COMERCIAL_MINUTOS } from "@/lib/billing/vigencia";

const DIA_MS = 86400000;
const FUSO_MS = FUSO_COMERCIAL_MINUTOS * 60000;

/** "AAAA-MM-DD" do dia comercial (America/Sao_Paulo, UTC-3) do instante. */
export function commercialDay(instant: Date): string {
  return new Date(instant.getTime() + FUSO_MS).toISOString().slice(0, 10);
}

/** Meia-noite do dia comercial de `now`, como instante UTC. */
export function startOfCommercialDay(now: Date): Date {
  return new Date(Date.parse(`${commercialDay(now)}T00:00:00.000Z`) - FUSO_MS);
}

/**
 * Novos usuários por dia comercial nos últimos `days` dias (inclui hoje).
 * "Hoje" no painel é o dia no Brasil, não o dia UTC do servidor da Vercel:
 * cadastro às 22h de Brasília conta no dia em que aconteceu.
 */
export function usersPerDay(createdAt: Date[], now: Date, days = 30) {
  const start = startOfCommercialDay(now);
  const daily = new Map<string, number>();
  for (let i = days - 1; i >= 0; i--) daily.set(commercialDay(new Date(start.getTime() - i * DIA_MS)), 0);
  for (const created of createdAt) {
    const date = commercialDay(created);
    if (daily.has(date)) daily.set(date, (daily.get(date) ?? 0) + 1);
  }
  return [...daily].map(([date, count]) => ({ date, count }));
}

/**
 * Limites de janela dos cards do dashboard. 7 e 30 dias são janelas móveis a
 * partir de agora; "hoje" começa na meia-noite comercial.
 */
export function dashboardWindows(now: Date) {
  return {
    startToday: startOfCommercialDay(now),
    sevenDaysAgo: new Date(now.getTime() - 7 * DIA_MS),
    thirtyDaysAgo: new Date(now.getTime() - 30 * DIA_MS),
    inSevenDays: new Date(now.getTime() + 7 * DIA_MS),
  };
}
