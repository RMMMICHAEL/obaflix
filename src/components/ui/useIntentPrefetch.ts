"use client";

import { useCallback, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import {
  INTENT_PREFETCH_DELAY_MS,
  readConnection,
  shouldPrefetchOnIntent,
} from "@/lib/intent-prefetch";

/**
 * Dedupe em escopo de módulo: o mesmo destino aparece em várias prateleiras
 * (o card de "O Mentalista" pode estar em 3 fileiras da home). Guardar os hrefs
 * já preparados aqui — e não no estado de cada card — garante um prefetch só por
 * destino em toda a página, mesmo entre instâncias diferentes do card.
 */
const jaPreparados = new Set<string>();

/**
 * Aquece a imagem relevante do destino. `decode()` descomprime o bitmap fora da
 * thread principal; qualquer erro (imagem ausente, browser sem decode) é
 * irrelevante e engolido — esta preparação nunca pode travar a navegação.
 */
function prepararImagem(src?: string | null) {
  if (!src || typeof window === "undefined") return;
  const img = new window.Image();
  img.src = src;
  img.decode?.().catch(() => {});
}

/**
 * Prefetch por intenção para um card. Em vez do prefetch indiscriminado por
 * viewport do <Link> (que prepara o catálogo inteiro ao rolar), só prepara o
 * destino quando o ponteiro pousa ~180ms sobre o card ou ele recebe foco.
 *
 * - Dispara em hover (mouse) e foco (teclado); não em touch, onde o toque já é
 *   a própria navegação.
 * - Cancela se o ponteiro/foco sair antes dos 180ms.
 * - Deduplica por destino (Set de módulo).
 * - Respeita saveData / conexão 2g (ver shouldPrefetchOnIntent).
 */
export function useIntentPrefetch(href: string, imagemRelevante?: string | null) {
  const router = useRouter();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cancelar = useCallback(() => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  }, []);

  // Prepara o destino de imediato. Reaproveitado pela janela de intenção (no fim
  // do timer) e pelo toque (onde a navegação é iminente e não há o que esperar).
  const disparar = useCallback(() => {
    if (jaPreparados.has(href)) return; // destino já preparado
    if (!shouldPrefetchOnIntent(readConnection())) return;
    jaPreparados.add(href);
    router.prefetch(href);
    prepararImagem(imagemRelevante);
  }, [href, imagemRelevante, router]);

  const iniciar = useCallback(() => {
    if (jaPreparados.has(href)) return; // destino já preparado
    if (timer.current) return; // já agendado neste card
    if (!shouldPrefetchOnIntent(readConnection())) return;
    timer.current = setTimeout(() => {
      timer.current = null;
      disparar();
    }, INTENT_PREFETCH_DELAY_MS);
  }, [href, disparar]);

  // Timer pendente não pode sobreviver ao card: ao desmontar, cancela.
  useEffect(() => cancelar, [cancelar]);

  return {
    // Mouse e teclado: espera a janela de intenção (~180ms) antes de preparar.
    onMouseEnter: iniciar,
    onMouseLeave: cancelar,
    onFocus: iniciar,
    onBlur: cancelar,
    // Toque: não há hover no celular. Em vez de reativar o prefetch por viewport
    // (que prepararia o catálogo inteiro), prepara só ESTE destino no primeiro
    // contato do dedo — a folga até o clique real já adianta o RSC. Dedupe e
    // saveData/2g continuam valendo via disparar().
    onTouchStart: disparar,
  };
}
