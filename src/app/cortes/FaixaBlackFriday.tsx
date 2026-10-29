import { ArrowDown } from "lucide-react";
import styles from "./cortes.module.css";

/** Faixa de campanha. Sem contador, sem escassez e sem preço: os valores vêm da vitrine abaixo. */
export function FaixaBlackFriday() {
  return (
    <aside className={styles.bfBanner} aria-label="Campanha Esquenta Black Friday 2026">
      <span className={styles.bfTag}>Esquenta Black Friday 2026</span>
      <p>Obaflix Cortes: escolha o plano Start, Pro ou AI. 30 dias de acesso, pagamento único por Pix.</p>
      <a href="#lancamento" className={styles.bfLink}>Ver os planos <ArrowDown size={15} aria-hidden /></a>
    </aside>
  );
}
