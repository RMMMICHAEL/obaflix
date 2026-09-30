"use client";

import { useEffect, useState } from "react";
import { Download, Loader2 } from "lucide-react";

import {
  DESKTOP_UPDATE_READY_EVENT,
  DOWNLOAD_ATUALIZACAO_DESKTOP,
  VERSAO_MINIMA_DESKTOP,
  desktopPrecisaAtualizar,
} from "@/lib/desktop/versaoMinima";

type DesktopBridge = {
  isDesktop?: boolean;
  getVersion?: () => Promise<string | null>;
  installUpdate?: () => Promise<unknown>;
  onUpdateReady?: (callback: (version: string) => void) => void;
};

function getDesktopBridge(): DesktopBridge | undefined {
  return (
    window as Window & {
      obaflixDesktop?: DesktopBridge;
    }
  ).obaflixDesktop;
}

function abrirInstaladorFinal() {
  // 1.0.10 e 1.0.11 interceptam window.open de HTTPS externo no processo
  // principal e encaminham ao navegador do sistema. Isso evita depender da
  // ponte openExternal, que não existe no 1.0.10 e é restrita no 1.0.11.
  window.open(
    DOWNLOAD_ATUALIZACAO_DESKTOP,
    "_blank",
    "noopener,noreferrer",
  );
}

export function DesktopVersionGate() {
  const [versaoAtual, setVersaoAtual] = useState<string | null>(null);
  const [bloqueado, setBloqueado] = useState(false);
  const [updateBaixado, setUpdateBaixado] = useState(false);
  const [acionando, setAcionando] = useState(false);

  useEffect(() => {
    const desktop = getDesktopBridge();

    if (!desktop?.getVersion) return;

    let ativo = true;

    const updateReady = () => {
      if (ativo) setUpdateBaixado(true);
    };

    window.addEventListener(
      DESKTOP_UPDATE_READY_EVENT,
      updateReady,
    );

    void Promise.resolve(desktop.getVersion())
      .then((versao) => {
        if (!ativo || typeof versao !== "string") return;

        setVersaoAtual(versao);

        if (desktopPrecisaAtualizar(versao)) {
          setBloqueado(true);
        }
      })
      .catch(() => {
        // Falha em consultar a bridge nunca deve bloquear browser/Android/TV.
      });

    return () => {
      ativo = false;

      window.removeEventListener(
        DESKTOP_UPDATE_READY_EVENT,
        updateReady,
      );
    };
  }, []);

  useEffect(() => {
    if (!bloqueado) return;

    const overflowAnterior = document.body.style.overflow;

    document.body.style.overflow = "hidden";

    const impedirEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
      }
    };

    document.addEventListener("keydown", impedirEscape, true);

    return () => {
      document.body.style.overflow = overflowAnterior;
      document.removeEventListener("keydown", impedirEscape, true);
    };
  }, [bloqueado]);

  if (!bloqueado) return null;

  const instalar = async () => {
    if (acionando) return;

    setAcionando(true);

    try {
      const desktop = getDesktopBridge();

      // installUpdate() só é usado quando o próprio Electron avisou
      // "update-downloaded". No 1.0.10 o feed antigo morreu e no 1.0.11
      // não há feed configurado; chamar quitAndInstall às cegas seria falso.
      if (updateBaixado && desktop?.installUpdate) {
        await desktop.installUpdate();
        return;
      }

      abrirInstaladorFinal();
    } catch {
      abrirInstaladorFinal();
    } finally {
      window.setTimeout(() => {
        setAcionando(false);
      }, 1000);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="obaflix-update-required-title"
      className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/95 px-5 backdrop-blur-md"
    >
      <div className="w-full max-w-md rounded-2xl border border-white/10 bg-zinc-950 p-6 text-center shadow-2xl">
        <div className="mx-auto mb-5 flex h-14 w-14 items-center justify-center rounded-full bg-[#E50914]/15">
          <Download className="h-7 w-7 text-[#E50914]" />
        </div>

        <h1
          id="obaflix-update-required-title"
          className="text-2xl font-bold text-white"
        >
          Atualização obrigatória
        </h1>

        <p className="mt-3 text-sm leading-6 text-zinc-300">
          Atualize para continuar.
        </p>

        {versaoAtual && (
          <p className="mt-2 text-xs text-zinc-500">
            Versão instalada: {versaoAtual}. Versão mínima:{" "}
            {VERSAO_MINIMA_DESKTOP}.
          </p>
        )}

        <button
          type="button"
          onClick={() => void instalar()}
          disabled={acionando}
          className="mt-6 inline-flex w-full items-center justify-center gap-2 rounded-xl bg-[#E50914] px-5 py-3 font-semibold text-white transition hover:bg-red-600 disabled:cursor-wait disabled:opacity-70"
        >
          {acionando ? (
            <Loader2 className="h-5 w-5 animate-spin" />
          ) : (
            <Download className="h-5 w-5" />
          )}
          Instalar atualização
        </button>

        <p className="mt-4 text-xs leading-5 text-zinc-500">
          Se a atualização já tiver sido baixada pelo aplicativo, ela será
          instalada diretamente. Caso contrário, o instalador oficial será
          aberto no navegador.
        </p>
      </div>
    </div>
  );
}