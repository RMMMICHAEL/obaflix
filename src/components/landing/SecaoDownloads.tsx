"use client";

import { useState } from "react";
import { Check, Copy, Monitor, Smartphone, Tv } from "lucide-react";
import { CODIGO_DOWNLOADER, type Instalador } from "@/config/downloads";

/**
 * Os três instaladores.
 *
 * As URLs chegam por prop a partir de `src/config/downloads.ts` — este
 * componente não conhece nenhum endereço. Quando a URL está vazia (R2 ainda em
 * configuração) o botão fica desabilitado e diz isso com todas as letras, em vez
 * de apontar para um link que não existe.
 */

type Card = {
  chave: string;
  icone: React.ReactNode;
  nome: string;
  descricao: string;
  rotuloBotao: string;
  instalador: Instalador;
  destaque?: boolean;
};

function BotaoDownload({
  instalador,
  rotulo,
  destaque,
}: {
  instalador: Instalador;
  rotulo: string;
  destaque?: boolean;
}) {
  const pronto = instalador.url.length > 0;

  if (!pronto) {
    return (
      <button
        type="button"
        disabled
        aria-disabled
        title="O link definitivo ainda está sendo configurado"
        className="w-full cursor-not-allowed rounded-xl border border-dashed border-white/20 bg-white/[0.04] px-4 py-3 text-sm font-semibold text-white/45"
      >
        Aguardando link definitivo
      </button>
    );
  }

  return (
    <a
      href={instalador.url}
      rel="noopener nofollow"
      className={
        destaque
          ? "block w-full rounded-xl bg-gradient-to-b from-red-500 to-red-700 px-4 py-3 text-center text-sm font-bold text-white shadow-lg shadow-red-900/40 transition hover:brightness-110 active:scale-[0.98]"
          : "block w-full rounded-xl bg-white px-4 py-3 text-center text-sm font-bold text-zinc-950 transition hover:bg-white/90 active:scale-[0.98]"
      }
    >
      {rotulo}
    </a>
  );
}

function CopiarCodigo() {
  const [copiado, setCopiado] = useState(false);

  async function copiar() {
    try {
      await navigator.clipboard.writeText(CODIGO_DOWNLOADER);
    } catch {
      // Navegador sem permissão de área de transferência: o código continua
      // visível na tela para ser digitado à mão. Não há erro a mostrar.
      return;
    }
    setCopiado(true);
    setTimeout(() => setCopiado(false), 2000);
  }

  return (
    <div className="mt-4 rounded-xl border border-white/10 bg-black/40 p-3">
      <p className="text-[11px] font-semibold uppercase tracking-wider text-red-400">
        Instalar pelo Downloader
      </p>
      <p className="mt-1 text-xs text-white/50">
        Abra o app Downloader na TV e digite o código:
      </p>
      <div className="mt-2 flex items-center gap-2">
        <span className="flex-1 rounded-lg bg-white/10 px-3 py-2 text-center font-mono text-xl font-bold tracking-[0.2em] text-white">
          {CODIGO_DOWNLOADER}
        </span>
        <button
          type="button"
          onClick={copiar}
          aria-label="Copiar código do Downloader"
          className="inline-flex items-center gap-1.5 rounded-lg border border-white/15 bg-white/5 px-3 py-2 text-xs font-semibold text-white transition hover:bg-white/10 active:scale-95"
        >
          {copiado ? <Check size={15} className="text-emerald-400" /> : <Copy size={15} />}
          {copiado ? "Copiado" : "Copiar código"}
        </button>
      </div>
    </div>
  );
}

export function SecaoDownloads({
  android,
  androidTv,
  windows,
}: {
  android: Instalador;
  androidTv: Instalador;
  windows: Instalador;
}) {
  const cards: Card[] = [
    {
      chave: "android",
      icone: <Smartphone size={22} />,
      nome: "Android",
      descricao: "Celulares e tablets. Instale o APK e entre com sua conta.",
      rotuloBotao: "Baixar APK",
      instalador: android,
    },
    {
      chave: "android-tv",
      icone: <Tv size={22} />,
      nome: "Android TV",
      descricao: "Smart TV, TV Box e Fire Stick, com controle remoto.",
      rotuloBotao: "Baixar APK",
      instalador: androidTv,
      destaque: true,
    },
    {
      chave: "windows",
      icone: <Monitor size={22} />,
      nome: "Windows",
      descricao: "Aplicativo para PC e notebook, com instalação rápida.",
      rotuloBotao: "Baixar para Windows",
      instalador: windows,
    },
  ];

  return (
    <section id="baixar" className="scroll-mt-20 px-4 py-14 sm:px-6 sm:py-20 lg:px-10">
      <div className="mx-auto max-w-6xl">
        <div className="text-center">
          <p className="text-xs font-bold uppercase tracking-[0.25em] text-red-500">
            Baixe o aplicativo
          </p>
          <h2 className="mt-3 text-3xl font-black tracking-tight text-white sm:text-4xl lg:text-5xl">
            Escolha o seu aparelho
          </h2>
          <p className="mx-auto mt-3 max-w-xl text-sm text-white/50 sm:text-base">
            Uma conta só, em todos os aparelhos. Continue de onde parou.
          </p>
        </div>

        <div className="mt-10 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {cards.map((card) => (
            <article
              key={card.chave}
              className={`obaflix-reveal relative flex flex-col rounded-2xl border p-5 backdrop-blur transition duration-300 sm:p-6 ${
                card.destaque
                  ? "border-red-500/35 bg-gradient-to-b from-red-950/40 to-zinc-900/60 shadow-xl shadow-red-950/30"
                  : "border-white/10 bg-zinc-900/50 hover:border-white/20"
              }`}
            >
              {card.destaque ? (
                <span className="absolute -top-2.5 left-5 rounded-full bg-red-600 px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-white">
                  Mais usado
                </span>
              ) : null}

              <div className="flex items-center gap-3">
                <span className="grid h-11 w-11 place-items-center rounded-xl bg-white/10 text-white">
                  {card.icone}
                </span>
                <div>
                  <h3 className="text-lg font-bold text-white">{card.nome}</h3>
                  <p className="text-[11px] text-white/40">
                    {[card.instalador.versao, card.instalador.tamanho].filter(Boolean).join(" · ") ||
                      "Versão em preparação"}
                  </p>
                </div>
              </div>

              <p className="mt-3 flex-1 text-sm leading-relaxed text-white/55">{card.descricao}</p>

              <div className="mt-5">
                <BotaoDownload
                  instalador={card.instalador}
                  rotulo={card.rotuloBotao}
                  destaque={card.destaque}
                />
                {card.chave === "android-tv" ? <CopiarCodigo /> : null}
              </div>
            </article>
          ))}
        </div>

        <p className="mt-8 text-center text-xs text-white/30">
          Downloads servidos diretamente pelo nosso armazenamento de arquivos.
        </p>
      </div>
    </section>
  );
}
