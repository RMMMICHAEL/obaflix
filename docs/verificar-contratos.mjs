// Verificação leve dos contratos críticos (docs/CONTRATOS_CRITICOS.md). Uso: node docs/verificar-contratos.mjs
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";

const lê = (p) => readFileSync(p, "utf8");
const falhas = [];
const exige = (ok, msg) => { if (!ok) falhas.push(msg); };

const config = lê("composeApp/src/commonMain/kotlin/com/nuvio/app/integration/obaflix/ObaflixConfig.kt");
exige(/PRODUCTION_BASE_URL = "https:\/\/obaflix\.vercel\.app"/.test(config), "domínio principal deve ser https://obaflix.vercel.app");
for (const h of ["obaflixbr.com", "obaflix.online"]) exige(config.includes(`https://${h}`), `origem oficial ausente: ${h}`);

const gradle = lê("androidApp/build.gradle.kts");
exige(/create\("playstore"\)[\s\S]{0,200}obaflixPlayDistribution"\] = "true"/.test(gradle), "playstore deve ter play_distribution=true");
exige(/obaflixPremiumDemo"\] = "false"/.test(gradle), "playstore deve forçar premium_demo=false");
exige(/applicationId = "com\.obaflix\.nativelab"/.test(gradle), "applicationId padrão deve continuar de laboratório");
exige(gradle.includes('variant.applicationId.set("com.obaflix")'), "pacote oficial com.obaflix ausente nos canais oficiais");
exige(gradle.includes("obaflixExternalOfficial"), "flag do APK externo ausente");

const manifestoMain = lê("androidApp/src/main/AndroidManifest.xml");
exige(!manifestoMain.includes("REQUEST_INSTALL_PACKAGES"), "manifest principal (inclui Play) não pode pedir REQUEST_INSTALL_PACKAGES");
exige(manifestoMain.includes('android:scheme="obaflix"') || manifestoMain.includes("auth/callback") || manifestoMain.includes('"auth"'), "filtro obaflix://auth/callback ausente");

// REQUEST_INSTALL_PACKAGES só pode existir no source set `full`.
const raízes = ["androidApp/src", "composeApp/src"];
const achados = [];
const varre = (d) => {
  for (const n of readdirSync(d)) {
    if (n === "build" || n === "node_modules") continue;
    const p = join(d, n);
    if (statSync(p).isDirectory()) varre(p);
    else if (n === "AndroidManifest.xml" && lê(p).includes("REQUEST_INSTALL_PACKAGES")) achados.push(p.replaceAll("\\", "/"));
  }
};
raízes.forEach(varre);
for (const p of achados) exige(/\/(full|androidFull)\//.test(p), `REQUEST_INSTALL_PACKAGES fora do flavor full: ${p}`);

// Nenhuma URL de deployment Preview embutida no código de produção.
const preview = execSync("git grep -nE \"https://[a-z0-9-]+-[a-z0-9]{8,}-michaeltrader\.vercel\.app\" -- composeApp/src/commonMain composeApp/src/androidMain androidApp/src/main || true", { encoding: "utf8" }).trim();
exige(preview === "", `URL de Preview embutida: ${preview.split("\n")[0]}`);

// Segredos de assinatura nunca versionados.
const versionados = execSync("git ls-files", { encoding: "utf8" }).split("\n").filter((f) => /\.(jks|keystore|p12)$/i.test(f));
exige(versionados.length === 0, `keystore versionado: ${versionados.join(", ")}`);

// Contratos de produto presentes.
const tem = (padrão) => execSync(`git grep -l "${padrão}" -- composeApp/src || true`, { encoding: "utf8" }).trim() !== "";
exige(tem("isOfficialAddon"), "proteção de addon oficial ausente");
exige(tem("seja-premium"), "plano seja-premium ausente");
exige(tem("ObaflixDataImport"), "importação de dados ausente");

// Atualizador externo: ligado só no flavor full; o Play nunca tem atualizador próprio.
const pol = (v) => lê(`composeApp/src/${v}/kotlin/com/nuvio/app/core/build/AppFeaturePolicy.android.kt`);
exige(pol("androidPlaystore").includes("inAppUpdaterEnabled: Boolean = false"), "Play não pode ter atualizador próprio");
exige(pol("androidFull").includes("inAppUpdaterEnabled: Boolean = true"), "atualizador do APK externo desligado");

// Imagens da importação normalizadas como no catálogo; progresso só local; Google nativo sem decidir identidade no cliente.
const imp = lê("composeApp/src/commonMain/kotlin/com/nuvio/app/integration/obaflix/ObaflixDataImport.kt");
exige(!/poster = media\.text\("poster"\)/.test(imp), "importação grava poster bruto (use image())");
exige(/remoteSyncEnabled = false/.test(lê("composeApp/src/commonMain/kotlin/com/nuvio/app/integration/obaflix/ObaflixProgressSyncAdapter.kt")), "progresso remoto deve ficar desligado");
exige(lê("composeApp/src/commonMain/kotlin/com/nuvio/app/integration/obaflix/ObaflixGoogleLogin.kt").includes("/api/desktop-auth/google-native"), "login Google nativo deve validar o token no backend");

if (falhas.length) { console.error("CONTRATOS QUEBRADOS:\n- " + falhas.join("\n- ")); process.exit(1); }
console.log("contratos ok");
