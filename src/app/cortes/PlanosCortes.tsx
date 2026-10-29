"use client";

import { useEffect, useState } from "react";
import { ArrowUpRight, Check } from "lucide-react";
import { LinkAssinatura } from "@/components/ui/LinkAssinatura";
import { acaoNoPlanoCortes } from "@/lib/billing/checkout";
import styles from "./cortes.module.css";
import { enviarEventoMeta } from "@/lib/metaPixelCortes";

type Preco = { id: string; rotulo: string; duracaoDias: number | null; duracaoMeses: number | null; precoCentavos: number; moeda: string };
type PlanoDaApi = { id: string; compravel: boolean; precos: Preco[] };

const PLANOS = [
  {
    id: "cortes-start", nome: "Start", destaque: false,
    texto: "Para quem precisa separar um trecho de cada vez, direto no player.",
    beneficios: ["Seleção manual de início e fim", "Prévia do trecho antes de exportar", "Exportação de trechos individuais", "No app Obaflix para Windows"],
  },
  {
    id: "cortes-pro", nome: "Pro", destaque: true,
    texto: "O melhor caminho para quem monta vídeos com várias cenas.",
    beneficios: ["Tudo do Start", "Lista com vários trechos", "Exportação em lote", "Organize as cenas antes de exportar"],
  },
  {
    id: "cortes-ai", nome: "AI", destaque: false,
    texto: "Descreva o tema: a IA usa as legendas para sugerir momentos e horários.",
    beneficios: ["Tudo do Pro", "Sugestões de cortes por tema ou roteiro", "Usa as legendas do episódio com Gemini", "Até 5 análises a cada 24 horas"],
  },
] as const;

const dinheiro = (centavos: number, moeda: string) =>
  new Intl.NumberFormat("pt-BR", { style: "currency", currency: moeda }).format(centavos / 100);
const duracao = (p: Preco) => p.duracaoDias ?? (p.duracaoMeses ?? 0) * 30;

/**
 * Start, Pro e AI com preço e disponibilidade da mesma fonte do checkout
 * (`GET /api/billing/plans`). Sem preço ativo, nada é vendido: o cartão diz
 * "em breve".
 */
const ROTULO = { assinar: "Quero o", renovar: "Renovar", upgrade: "Fazer upgrade para" } as const;

/** Sem `situacao` (landing): todo cartão oferece compra nova. */
export function PlanosCortes({ situacao = { logado: false, atual: null } }: { situacao?: { logado: boolean; atual: string | null } }) {
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
      {PLANOS.map(({ id, nome, texto, destaque, beneficios }) => {
        const plano = planos?.[id];
        const preco = plano?.compravel ? [...plano.precos].sort((a, b) => duracao(a) - duracao(b))[0] : null;
        const decisao = acaoNoPlanoCortes(id, situacao);
        const atual = situacao.logado && situacao.atual === id;
        return (
          <article key={id} aria-current={atual ? "true" : undefined} data-destaque={destaque ? "true" : "false"}>
            <span className={styles.planBadge}>
              {atual ? "Seu plano atual" : destaque ? "RECOMENDADO" : "OBAFLIX CORTES"}
            </span>
            <h3>{nome}</h3>
            <p className={styles.planPitch}>{texto}</p>
            {/* Preço só da API: sem preço ativo no banco, o plano não é vendável e nada é exibido como valor. */}
            {preco && (
              <p className={styles.planPrice}>
                {dinheiro(preco.precoCentavos, preco.moeda)} <span>/ {preco.rotulo}</span>
              </p>
            )}
            <ul className={styles.planBenefits} aria-label={`Benefícios do Cortes ${nome}`}>
              {beneficios.map((item) => (
                <li key={item}>
                  <Check size={15} aria-hidden />
                  <span>{item}</span>
                </li>
              ))}
            </ul>
            {decisao.acao === "incluido" ? (
              <p className={styles.planUnavail}>Incluído no seu plano atual</p>
            ) : preco ? (
              <>
                <LinkAssinatura
                  href={`${decisao.href}&planoPrecoId=${encodeURIComponent(preco.id)}`}
                  className={`${styles.primary} ${styles.planBuy}`}
                  data-cortes-cta={`plano-${nome.toLowerCase()}-${decisao.acao}`}
                  onClick={() => enviarEventoMeta("InitiateCheckout", {
                    content_ids: [id], content_type: "product", currency: "BRL",
                    value: (preco.precoCentavos + 99) / 100, num_items: 1,
                  })}
                >
                  {ROTULO[decisao.acao]} Cortes {nome} <ArrowUpRight size={19} aria-hidden />
                </LinkAssinatura>
              </>
            ) : (
              <p className={styles.planUnavail}>{planos === null ? "Verificando disponibilidade…" : "Preço em breve"}</p>
            )}
            <p className={styles.planFoot}>Pagamento por Pix · sem renovação automática</p>
          </article>
        );
      })}
    </div>
  );
}
