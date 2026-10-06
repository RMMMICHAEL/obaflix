"use client";

import Image from "next/image";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { ArrowRight, Download, Search, X } from "lucide-react";
import { TIKTOK_CONTENT, type TikTokContent } from "./tiktok-content";
import styles from "@/app/tiktok/tiktok.module.css";

/** Só a seleção e o dialog precisam de estado cliente. Sem fetch ou player. */
export function TikTokTrending() {
  const [selected, setSelected] = useState<TikTokContent | null>(null);
  const [query, setQuery] = useState("");
  const [failedLogo, setFailedLogo] = useState<string | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const downloadLink = useRef<HTMLAnchorElement>(null);
  const items = TIKTOK_CONTENT.filter((item) =>
    item.titulo.toLocaleLowerCase("pt-BR").includes(query.trim().toLocaleLowerCase("pt-BR")),
  );

  useEffect(() => {
    if (!selected || !dialog.current) return;
    const element = dialog.current;
    const previousOverflow = document.body.style.overflow;
    element.showModal();
    closeButton.current?.focus();
    document.body.style.overflow = "hidden";
    return () => {
      element.close();
      document.body.style.overflow = previousOverflow;
    };
  }, [selected]);

  function close() {
    dialog.current?.close();
    setSelected(null);
  }

  function keepFocusInDialog(event: KeyboardEvent<HTMLDialogElement>) {
    if (event.key !== "Tab") return;
    if (event.shiftKey && document.activeElement === closeButton.current) {
      event.preventDefault();
      downloadLink.current?.focus();
    } else if (!event.shiftKey && document.activeElement === downloadLink.current) {
      event.preventDefault();
      closeButton.current?.focus();
    }
  }

  return (
    <section id="conteudos" className={styles.section} aria-labelledby="em-alta">
      <div className={styles.sectionHeading}>
        <div>
          <p className={styles.eyebrow}>Sua próxima história começa aqui</p>
          <h2 id="em-alta">Em alta no aplicativo</h2>
          <p className={styles.secondary}>Seleção editorial de títulos do catálogo. Toque para conhecer.</p>
        </div>
        <a href="#baixar" className={styles.textLink}>Ver todos no app <ArrowRight size={16} aria-hidden="true" /></a>
      </div>
      <label id="buscar-conteudos" className={styles.search}>
        <Search size={18} aria-hidden="true" />
        <span className="sr-only">Buscar nesta seleção</span>
        <input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Buscar nesta seleção" />
      </label>
      <div className={styles.ranking} aria-label="Seleção de conteúdos">
        {items.map((item) => (
          <button key={item.titulo} type="button" className={styles.rankCard} onClick={() => setSelected(item)} aria-label={`Conhecer ${item.titulo}`} aria-haspopup="dialog">
            <span className={styles.rankNumber} aria-hidden="true">{TIKTOK_CONTENT.indexOf(item) + 1}</span>
            <span className={styles.poster}>
              <Image src={item.poster} alt="" width={342} height={513} unoptimized loading="lazy" referrerPolicy="no-referrer" />
              <span className={styles.posterCaption}>
                <strong>{item.titulo}</strong><span>{item.ano} · {item.tipo}</span>
              </span>
            </span>
          </button>
        ))}
      </div>
      {items.length === 0 ? <p role="status" className={styles.secondary}>Nenhum título nesta seleção. Explore o catálogo completo no aplicativo.</p> : null}
      <dialog
        ref={dialog}
        className={styles.modal}
        aria-labelledby="conteudo-titulo"
        aria-describedby="conteudo-descricao"
        onKeyDown={keepFocusInDialog}
        onCancel={(event) => { event.preventDefault(); close(); }}
        onClose={() => setSelected(null)}
        onClick={(event) => { if (event.target === event.currentTarget) close(); }}
      >
        {selected ? (
          <div className={styles.modalContent}>
            <div className={styles.modalBackdrop} aria-hidden="true">
              <Image src={selected.backdrop} alt="" fill unoptimized sizes="720px" referrerPolicy="no-referrer" />
            </div>
            <button ref={closeButton} type="button" className={styles.close} onClick={close} aria-label="Fechar detalhes"><X size={24} /></button>
            <div className={styles.modalDetails}>
              <p className={styles.eyebrow}>Conheça no Obaflix</p>
              {selected.logo && selected.logo !== failedLogo ? (
                <Image key={selected.logo} className={styles.contentLogo} src={selected.logo} alt="" aria-hidden="true" width={500} height={200} unoptimized referrerPolicy="no-referrer" onError={() => setFailedLogo(selected.logo ?? null)} />
              ) : null}
              <h2 id="conteudo-titulo">{selected.titulo}</h2>
              <p className={styles.metadata}>{selected.ano}<span title="Classificação original do título">{selected.classificacao}</span>{selected.tipo}</p>
              <p className={styles.secondary}>{selected.generos}</p>
              <p id="conteudo-descricao" className={styles.synopsis}>{selected.descricao}</p>
              <p className={styles.secondary}>Para assistir, baixe e instale o aplicativo no seu aparelho.</p>
              <a ref={downloadLink} href="#baixar" className={styles.primary} onClick={close}><Download size={18} aria-hidden="true" />Baixar o Obaflix</a>
            </div>
          </div>
        ) : null}
      </dialog>
    </section>
  );
}
