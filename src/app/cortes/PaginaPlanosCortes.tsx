"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { ArrowUpRight } from "lucide-react";
import { PLANOS_CORTES_HREF } from "@/lib/billing/checkout";
import { PlanosCortes } from "./PlanosCortes";
import styles from "./cortes.module.css";

type Me = { cortes?: { plano: { id: string; nome: string }; terminaEm: string } | null };

/**
 * `/planos?familia=cortes`: contratar, renovar ou atualizar o Obaflix Cortes, com
 * a identidade da landing /cortes. Abre no navegador externo pelo Electron, que
 * não compartilha a sessão do app: renovar e upgrade pedem login aqui.
 */
export function PaginaPlanosCortes() {
  // undefined = carregando; null = sem sessão neste navegador.
  const [me, setMe] = useState<Me | null | undefined>(undefined);

  useEffect(() => {
    let vivo = true;
    fetch("/api/billing/me", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((dados) => { if (vivo) setMe(dados); })
      .catch(() => { if (vivo) setMe(null); });
    return () => { vivo = false; };
  }, []);

  const logado = !!me;
  const atual = me?.cortes ?? null;
  const login = `/login?callbackUrl=${encodeURIComponent(PLANOS_CORTES_HREF)}`;

  return (
    <div data-obaflix-landing className={styles.page} id="inicio">
      <a className={styles.skip} href="#conteudo">Pular para o conteúdo</a>
      <header className={styles.header}>
        <Link href="/cortes" className={styles.brand} aria-label="Obaflix Cortes">
          <span>OBA<span>FLIX</span></span>
          <i />
          <b>CORTES</b>
        </Link>
        <Link href="/cortes" className={styles.headerCta}>
          Conheça o Cortes <ArrowUpRight size={16} aria-hidden />
        </Link>
      </header>

      <section className={styles.section} id="conteudo" aria-labelledby="planos-titulo">
        <div className={styles.sectionIntro}>
          <div>
            <p className={styles.overline}>Planos Obaflix Cortes</p>
            <h1 id="planos-titulo">Contrate, renove ou faça upgrade.</h1>
          </div>
          <p aria-live="polite">
            {me === undefined ? "Verificando sua conta…"
              : atual ? `Seu plano: ${atual.plano.nome} · válido até ${new Date(atual.terminaEm).toLocaleDateString("pt-BR")}.`
              : logado ? "Você ainda não tem o Obaflix Cortes. Escolha um plano para começar."
              : <>Compra nova sem cadastro: o acesso chega por e-mail. Já assina o Cortes? <Link href={login} className={styles.textLink}>Entre</Link> para renovar ou fazer upgrade.</>}
          </p>
        </div>
        <PlanosCortes situacao={{ logado, atual: atual?.plano.id ?? null }} />
        <p className={styles.note}>
          Pagamento por Pix, sem renovação automática. No upgrade de Start para Pro, o crédito
          do período restante é descontado no checkout. Renovação e upgrade exigem estar
          conectado à sua conta neste navegador. O Cortes não altera seu plano Básico, Plus ou Premium.
        </p>
      </section>
    </div>
  );
}
