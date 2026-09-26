/**
 * "Só a seleção mais recente vale" — lógica pura, sem React.
 *
 * Abrir um canal pode esperar uma resposta de rede (o fluxo de anúncio do
 * Electron/Android). Se o usuário escolhe A e logo depois B, a resposta de A
 * pode chegar **depois** da de B; sem esta guarda ela selecionaria A de novo e
 * dispararia um `/play` que ninguém pediu. Cada abertura recebe um número; ao
 * voltar da espera, só efetiva quem ainda é o número mais recente.
 */
export interface SelecaoMaisRecente {
  /** Registra uma nova tentativa de seleção e devolve o token dela. */
  iniciar: () => number;
  /** `true` só se nenhuma tentativa mais nova começou depois deste token. */
  vale: (token: number) => boolean;
}

export function criarSelecaoMaisRecente(): SelecaoMaisRecente {
  let atual = 0;
  return {
    iniciar: () => ++atual,
    vale: (token) => token === atual,
  };
}
