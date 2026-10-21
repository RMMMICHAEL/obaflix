"use client";

import { useEffect, useState } from "react";
import { ArrowUpRight } from "lucide-react";
import { LinkAssinatura } from "@/components/ui/LinkAssinatura";
import styles from "./cortes.module.css";

type Preco = { id: string; rotulo: string; duracaoDias: number | null; duracaoMeses: number | null; precoCentavos: number; moeda: string };
type PlanoDaApi = { id: string; compravel: boolean; precos: Preco[] };

const PLANOS = [
  { id: "cortes-start", nome: "Start", texto: "Trecho individual: marque início e fim no player e baixe só a cena." },
  { id: "cortes-pro", nome: "Pro", texto: "Trecho individual e lote: monte uma lista de cenas e baixe todas de uma vez." },
] as const;

const dinheiro = (centavos: number, moeda: string) =>
  new Intl.NumberFormat("pt-BR", { style: "currency", currency: moeda }).format(centavos / 100);
const duracao = (p: Preco) => p.duracaoDias ?? (p.duracaoMeses ?? 0) * 30;

/**
 * Start e Pro com preço e disponibilidade da mesma fonte do checkout
 * (`GET /api/billing/plans`). Sem preço ativo, nada é vendido: o cartão diz
 * "em breve". O AI não é vendido.
 */
export function PlanosCortes() {
  // null = carregando; depois, os planos Cortes ativos devolvidos pela API.
  const [planos, setPlanos] = useState<Record<string, PlanoDaApi> | null>(null);

  useEffect(() => {
    let vivo = true;
    fetch("/api/billing/plans", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : { planos: [] }))
      .then((dados) => {
        const lista: PlanoDaApi[] = Array.isArray(dados?.planos) ? dados.planos : [];
        if (vivo) setPlanos(Object.fromEntries(lista.map((p) => [p.id, p])));
      })
      .catch(() => { if (vivo) setPlanos({}); });
    return () => { vivo = false; };
  }, []);

  return (
    <div className={styles.planList} aria-busy={planos === null}>
      {PLANOS.map(({ id, nome, texto }) => {
        const plano = planos?.[id];
        const preco = plano?.compravel ? [...plano.precos].sort((a, b) => duracao(a) - duracao(b))[0] : null;
        return (
          <article key={id}>
            <span>OBAFLIX CORTES</span>
            <h3>{nome}</h3>
            <p>{texto}</p>
            {preco ? (
              <>
                <p className={styles.planPrice}>
                  {dinheiro(preco.precoCentavos, preco.moeda)} <span>/ {preco.rotulo}</span>
                </p>
                <LinkAssinatura
                  href={`/checkout?planoId=${encodeURIComponent(id)}&planoPrecoId=${encodeURIComponent(preco.id)}`}
                  className={styles.primary}
                  data-cortes-cta={`plano-${nome.toLowerCase()}`}
                >
                  Assinar {nome} <ArrowUpRight size={17} aria-hidden />
                </LinkAssinatura>
              </>
            ) : (
              <small>{planos === null ? "Carregando…" : "Preço em breve"}</small>
            )}
          </article>
        );
      })}
      <article>
        <span>OBAFLIX CORTES</span>
        <h3>AI</h3>
        <p>Visão de uma modalidade com inteligência artificial, ainda em desenvolvimento.</p>
        <small>Em breve · IA indisponível atualmente</small>
      </article>
    </div>
  );
}
