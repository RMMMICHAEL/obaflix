/**
 * Faixa editorial para as seções de ranking.
 *
 * Motivo de existir: com todas as prateleiras usando o mesmo fundo e o mesmo
 * espaçamento, o Top 10 se perdia no meio da página — a sensação de ranking
 * vinha só do número dentro do card. Aqui a diferença é da seção inteira:
 * fundo levemente elevado e mais respiro vertical que as fileiras comuns.
 *
 * O lift usa a mesma escala OKLCH de hue 25 do resto do app (neutro tingido
 * para a marca, nunca cinza puro) e desaparece nas bordas por gradiente, em
 * vez de terminar numa linha reta: uma faixa com borda dura leria como cartão,
 * e cartão aninhado em prateleira é ruído.
 */
export function Top10Band({ children }: { children: React.ReactNode }) {
  return (
    <section className="relative py-6 md:py-10">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 -z-10"
        style={{
          background:
            "linear-gradient(to bottom, transparent, oklch(0.19 0.014 25) 18%, oklch(0.19 0.014 25) 82%, transparent)",
        }}
      />
      {children}
    </section>
  );
}
