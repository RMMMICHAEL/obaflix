"use client";

import { useState } from "react";
import { ArrowRight, Check, FileVideo, Mic, Scissors } from "lucide-react";
import styles from "./cortes.module.css";

const steps = [
  {
    title: "O roteiro pede imagens",
    text: "A narração está na timeline do seu editor. Falta encontrar os momentos que vão contar essa história.",
  },
  {
    title: "Encontre e marque no player",
    text: "No Obaflix, navegue até a cena, selecione início e fim e confira a prévia. Repita para cada trecho necessário.",
  },
  {
    title: "Prepare e leve para o editor",
    text: "Baixe os trechos individualmente. Depois, importe e posicione os arquivos no editor para acompanhar a narração.",
  },
];
const clips = ["A viagem começa", "Um novo caminho", "A chegada"];

export function CortesDemo() {
  const [step, setStep] = useState(0);
  return (
    <div className={styles.demo}>
      <div
        className={styles.demoSteps}
        role="group"
        aria-label="Etapas da demonstração"
      >
        {steps.map((item, index) => (
          <button
            key={item.title}
            type="button"
            aria-pressed={step === index}
            onClick={() => setStep(index)}
            aria-controls="cortes-demo-painel"
          >
            <span>0{index + 1}</span>
            {
              ["Só a narração", "Seleção no Obaflix", "Material preparado"][
                index
              ]
            }
            {step === index && <ArrowRight size={17} aria-hidden />}
          </button>
        ))}
      </div>
      <div className={styles.demoBody} id="cortes-demo-painel">
        <div
          className={styles.demoDescription}
          aria-live="polite"
          aria-atomic="true"
        >
          <span className={styles.demoStepNumber}>0{step + 1}</span>
          <h3>{steps[step].title}</h3>
          <p>{steps[step].text}</p>
          {step === 1 && (
            <div className={styles.demoSelection}>
              <Scissors size={18} aria-hidden />
              <div>
                <span>
                  Início <b>00:24:18</b>
                </span>
                <span>
                  Fim <b>00:24:30</b>
                </span>
              </div>
              <small>12 segundos selecionados</small>
            </div>
          )}
          {step === 2 && (
            <ul className={styles.exportList}>
              {clips.map((clip, i) => (
                <li key={clip}>
                  <FileVideo size={16} aria-hidden />
                  <span>
                    0{i + 1} · {clip}.mp4
                  </span>
                  <Check size={14} aria-hidden />
                </li>
              ))}
            </ul>
          )}
        </div>
        <div
          className={styles.timeline}
          aria-label={
            step === 0
              ? "Editor externo: faixa de vídeo vazia e narração pronta"
              : step === 1
                ? "Trechos selecionados no Obaflix, ainda fora do editor"
                : "Editor externo: exemplo de trechos importados sobre a narração"
          }
        >
          <div className={styles.timelineTop}>
            <span>
              {step === 1
                ? "OBAFLIX / SELEÇÃO DE TRECHO"
                : "SEU EDITOR / PROJETO EXEMPLO"}
            </span>
            <span>00:00:36</span>
          </div>
          <div className={styles.ruler}>
            <span>00:00</span>
            <span>00:12</span>
            <span>00:24</span>
            <span>00:36</span>
          </div>
          <div className={styles.videoTrack}>
            {step === 0 ? (
              <p>As imagens da sua história entram aqui.</p>
            ) : (
              clips.map((clip, i) => (
                <div
                  className={`${styles.timelineClip} ${step === 1 ? styles.pendingClip : ""}`}
                  key={clip}
                >
                  <span
                    className={styles.miniScene}
                    aria-hidden
                    style={{ filter: `hue-rotate(${i * 22}deg)` }}
                  />
                  <span>{clip}</span>
                </div>
              ))
            )}
          </div>
          <div className={styles.audioTrack}>
            <span>
              <Mic size={13} aria-hidden /> Sua narração
            </span>
            <div className={styles.waveform} aria-hidden>
              {Array.from({ length: 64 }, (_, i) => (
                <i key={i} style={{ height: `${18 + ((i * 17 + 7) % 68)}%` }} />
              ))}
            </div>
          </div>
          <p className={styles.timelineHint}>
            {step === 0
              ? "A história já tem voz. Agora, encontre as imagens."
              : step === 1
                ? "Representação de três seleções feitas uma por vez, sem fila automática."
                : "Montagem manual no seu editor. O Obaflix prepara os arquivos."}
          </p>
        </div>
      </div>
      <div className={styles.demoBottom}>
        <p>Demonstração ilustrativa, sem processamento de vídeo.</p>
        <button type="button" onClick={() => setStep((step + 1) % 3)}>
          {step === 2 ? "Recomeçar" : "Próxima etapa"}
          <ArrowRight size={16} aria-hidden />
        </button>
      </div>
    </div>
  );
}
