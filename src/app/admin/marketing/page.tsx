"use client";

import { useEffect, useMemo, useState } from "react";
import { Copy, Check, BarChart3 } from "lucide-react";
import { sanitizeUtm, buildLandingExternalUrl } from "@/lib/marketing/utm";
import styles from "./marketing.module.css";

/**
 * /admin/marketing — funil first-party da landing de download.
 *
 * Mede VISUALIZAÇÕES e CLIQUES, nunca instalações. Usa a sessão admin existente;
 * a autorização real é do endpoint `GET /api/admin/marketing/download-metrics`
 * (requireAdmin). Esta página só lê e desenha.
 */

type CampaignRow = {
  source: string; medium: string; campaign: string; content: string;
  inApp: number; openBrowser: number; browser: number; download: number;
};
type Report = {
  window: { days: number; from: string; to: string };
  summary: { inAppViews: number; openBrowserClicks: number; browserViews: number; downloadClicks: number };
  rates: { openBrowserRate: number | null; downloadClickRate: number | null; inAppToDownloadRate: number | null };
  campaigns: CampaignRow[];
  series: { day: string; inAppViews: number; downloadClicks: number }[];
};

const PERIODOS: { dias: 1 | 7 | 30; rotulo: string }[] = [
  { dias: 1, rotulo: "Hoje" },
  { dias: 7, rotulo: "7 dias" },
  { dias: 30, rotulo: "30 dias" },
];

const nf = new Intl.NumberFormat("pt-BR");
const pct = (x: number | null) => (x === null ? "—" : `${(x * 100).toFixed(1)}%`);

function LinkGenerator() {
  const [source, setSource] = useState("tiktok");
  const [medium, setMedium] = useState("promote");
  const [campaign, setCampaign] = useState("");
  const [content, setContent] = useState("");
  const [copiado, setCopiado] = useState(false);

  // Mesma sanitização do servidor: lowercase, [a-z0-9_-], ≤64, inválido some.
  const url = useMemo(
    () => buildLandingExternalUrl(sanitizeUtm({ source, medium, campaign, content })),
    [source, medium, campaign, content],
  );

  const copiar = async () => {
    try { await navigator.clipboard.writeText(url); setCopiado(true); window.setTimeout(() => setCopiado(false), 2000); } catch { setCopiado(false); }
  };

  return (
    <div className={styles.section}>
      <h2>Gerar link de campanha</h2>
      <p className={styles.hint}>Os valores são normalizados (minúsculas, sem espaços, apenas a-z 0-9 _ -). Campos não são salvos.</p>
      <div className={styles.gen}>
        <label>Source<input value={source} onChange={(e) => setSource(e.target.value)} placeholder="tiktok" /></label>
        <label>Medium<input value={medium} onChange={(e) => setMedium(e.target.value)} placeholder="promote" /></label>
        <label>Campaign<input value={campaign} onChange={(e) => setCampaign(e.target.value)} placeholder="android_outubro" /></label>
        <label>Content<input value={content} onChange={(e) => setContent(e.target.value)} placeholder="video01" /></label>
      </div>
      <div className={styles.genOut}>
        <code>{url}</code>
        <button type="button" className={styles.copyBtn} onClick={copiar}>
          {copiado ? <Check size={16} aria-hidden="true" /> : <Copy size={16} aria-hidden="true" />}
          {copiado ? "URL copiada" : "Copiar URL"}
        </button>
      </div>
    </div>
  );
}

function Chart({ series }: { series: Report["series"] }) {
  const max = Math.max(1, ...series.map((d) => Math.max(d.inAppViews, d.downloadClicks)));
  return (
    <div className={styles.section}>
      <h2>Diário</h2>
      <p className={styles.hint}>Visualizações no navegador interno e cliques no download, por dia.</p>
      <div className={styles.chart}>
        {series.map((d) => (
          <div key={d.day} className={styles.col} title={`${d.day} · interno ${d.inAppViews} · download ${d.downloadClicks}`}>
            <div className={styles.bars}>
              <div className={`${styles.bar} ${styles.view}`} style={{ height: `${(d.inAppViews / max) * 100}%` }} />
              <div className={`${styles.bar} ${styles.dl}`} style={{ height: `${(d.downloadClicks / max) * 100}%` }} />
            </div>
            <span>{d.day.slice(5)}</span>
          </div>
        ))}
      </div>
      <div className={styles.legend}>
        <span><i style={{ background: "oklch(62% .12 255)" }} />Visualizações no navegador interno</span>
        <span><i style={{ background: "oklch(56% .22 25)" }} />Cliques no download</span>
      </div>
    </div>
  );
}

export default function MarketingPage() {
  const [days, setDays] = useState<1 | 7 | 30>(7);
  const [report, setReport] = useState<Report | null>(null);
  const [estado, setEstado] = useState<"carregando" | "ok" | "negado" | "erro">("carregando");

  useEffect(() => {
    let vivo = true;
    setEstado("carregando");
    fetch(`/api/admin/marketing/download-metrics?days=${days}`, { credentials: "same-origin" })
      .then((r) => {
        if (r.status === 401 || r.status === 403) { if (vivo) setEstado("negado"); return null; }
        if (!r.ok) throw new Error("falha");
        return r.json();
      })
      .then((j: Report | null) => { if (j && vivo) { setReport(j); setEstado("ok"); } })
      .catch(() => { if (vivo) setEstado("erro"); });
    return () => { vivo = false; };
  }, [days]);

  const s = report?.summary;

  return (
    <div className={styles.page}>
      <div className={styles.head}>
        <div>
          <h1>Marketing — Landing de download</h1>
          <p>Visualizações e cliques da <code>/baixar</code>, atribuídos por UTM. Cada número é um acesso ou um clique — não representa pessoas únicas nem instalações do aplicativo.</p>
        </div>
        <div className={styles.periodo} role="group" aria-label="Período">
          {PERIODOS.map((p) => (
            <button key={p.dias} data-on={days === p.dias} onClick={() => setDays(p.dias)}>{p.rotulo}</button>
          ))}
        </div>
      </div>

      <div className={styles.wrap}>
        {estado === "carregando" && <p className={styles.state}>Carregando…</p>}
        {estado === "negado" && <p className={styles.state}>Acesso restrito. Entre com uma conta de administrador.</p>}
        {estado === "erro" && <p className={styles.state}>Não foi possível carregar as métricas agora.</p>}

        {estado === "ok" && report && s && (
          <>
            <div className={styles.cards}>
              <div className={styles.card}><small>Visualizações no navegador interno</small><b>{nf.format(s.inAppViews)}</b></div>
              <div className={styles.card}><small>Cliques em “Abrir no navegador”</small><b>{nf.format(s.openBrowserClicks)}</b></div>
              <div className={styles.card}><small>Visualizações no navegador externo</small><b>{nf.format(s.browserViews)}</b></div>
              <div className={`${styles.card} ${styles.accent}`}><small>Cliques em “Baixar para Android”</small><b>{nf.format(s.downloadClicks)}</b></div>
            </div>

            <div className={styles.rates}>
              <div className={styles.rate}><small>Taxa de saída do navegador interno</small><b>{pct(report.rates.openBrowserRate)}</b><em>“Abrir no navegador” ÷ visualizações internas</em></div>
              <div className={styles.rate}><small>Taxa de clique para download</small><b>{pct(report.rates.downloadClickRate)}</b><em>cliques no download ÷ visualizações externas</em></div>
              <div className={styles.rate}><small>Taxa navegador interno → download</small><b>{pct(report.rates.inAppToDownloadRate)}</b><em>cliques no download ÷ visualizações internas</em></div>
            </div>

            <Chart series={report.series} />

            <div className={styles.section}>
              <h2>Por campanha</h2>
              <p className={styles.hint}>Agrupado por campanha e vídeo. “In-app” e “Browser” são visualizações; as demais colunas são cliques.</p>
              <div className={styles.tableWrap}>
                <table className={styles.camp}>
                  <thead>
                    <tr>
                      <th>Campanha</th><th>Vídeo</th><th>Source</th><th>Medium</th>
                      <th className={styles.num}>In-app</th><th className={styles.num}>Abrir navegador</th>
                      <th className={styles.num}>Browser</th><th className={styles.num}>Download</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.campaigns.length === 0 && (
                      <tr><td colSpan={8}><p className={styles.empty}>Nenhum evento no período.</p></td></tr>
                    )}
                    {report.campaigns.map((c) => (
                      <tr key={`${c.source} ${c.medium} ${c.campaign} ${c.content}`}>
                        <td>{c.campaign}</td><td>{c.content}</td><td>{c.source}</td><td>{c.medium}</td>
                        <td className={styles.num}>{nf.format(c.inApp)}</td>
                        <td className={styles.num}>{nf.format(c.openBrowser)}</td>
                        <td className={styles.num}>{nf.format(c.browser)}</td>
                        <td className={styles.num}>{nf.format(c.download)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </>
        )}

        <LinkGenerator />

        <p className={styles.hint} style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 24 }}>
          <BarChart3 size={14} aria-hidden="true" /> Métrica operacional, não sistema antifraude: o tráfego pode ser inflado por bots e não há verificação de unicidade.
        </p>
      </div>
    </div>
  );
}
