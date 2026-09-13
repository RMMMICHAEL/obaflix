import { createLucideIcon } from "lucide-react";

/**
 * Shuriken estilizada para a aba Animes.
 *
 * Desenho próprio, no mesmo traço dos ícones do lucide que a barra já usa: grade
 * 24×24, contorno em `currentColor` e espessura herdada de `strokeWidth`, então
 * o estado ativo/inativo da aba funciona igual às outras. Quatro lâminas em
 * cata-vento e o furo central. Sem imagem externa e sem arte de terceiros.
 */
export const Shuriken = createLucideIcon("Shuriken", [
  ["path", { d: "M9.5 9.5 13 2l1.5 7.5L22 13l-7.5 1.5L11 22l-1.5-7.5L2 11z", key: "laminas" }],
  ["circle", { cx: "12", cy: "12", r: "1.5", key: "furo" }],
]);
