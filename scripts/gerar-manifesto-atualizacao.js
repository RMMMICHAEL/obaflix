// Gera o manifesto central de atualização (JSON) a partir dos APK já
// construídos, para publicar no R2 ao lado dos próprios instaladores.
//
// versionName e versionCode NUNCA são digitados à mão aqui: saem direto de
// android/app/build.gradle e android/tv/build.gradle (a mesma fonte que o
// build real usa), porque o manifesto só serve para uma coisa — dizer se há
// uma versão mais nova do que a instalada — e ela tem de bater exatamente com
// o binário que está sendo publicado. tamanho e sha256 saem do próprio
// arquivo. Nada aqui depende do NOME do arquivo/URL para decidir versão: só
// dos campos declarados no manifesto (ver android/core-extractor/.../update/UpdateManifest.kt).
//
// Uso:
//   node scripts/gerar-manifesto-atualizacao.js \
//     --android-apk releases/Obaflix-1.0.9.apk \
//     --android-url https://app.obaflix.online/Obaflix-1.0.9.apk \
//     --tv-apk releases/Obaflix-TV-0.7.20.apk \
//     --tv-url https://app.obaflix.online/Obaflix-TV-0.7.20.apk \
//     [--out releases/update-manifest.json]
//
// Qualquer uma das duas plataformas pode ser omitida (--android-apk/--tv-apk
// ausentes): o manifesto sai só com a que foi informada, exatamente como
// UpdateManifestParser trata uma plataforma ausente — nunca como erro.
//
// O arquivo gerado NÃO é publicado sozinho: depois de gerado, suba-o para o
// R2 manualmente (mesmo processo que já existe para os próprios APK), no
// mesmo caminho declarado em android/gradle.properties
// (obaflix.updateManifestUrl) — hoje, https://app.obaflix.online/update-manifest.json.

"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const RAIZ = path.join(__dirname, "..");

function lerArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const chave = argv[i];
    if (!chave.startsWith("--")) continue;
    const nome = chave.slice(2);
    const valor = argv[i + 1];
    if (valor === undefined || valor.startsWith("--")) {
      args[nome] = true;
    } else {
      args[nome] = valor;
      i += 1;
    }
  }
  return args;
}

/** Lê versionName/versionCode de um build.gradle — a mesma fonte que o Gradle usa. */
function lerVersaoDoGradle(caminhoGradle) {
  const texto = fs.readFileSync(caminhoGradle, "utf8");
  const versionCode = texto.match(/versionCode\s+(\d+)/);
  const versionName = texto.match(/versionName\s+"([^"]+)"/);
  if (!versionCode || !versionName) {
    throw new Error(`não encontrei versionCode/versionName em ${caminhoGradle}`);
  }
  return { versionCode: Number(versionCode[1]), versionName: versionName[1] };
}

function sha256DoArquivo(caminho) {
  const hash = crypto.createHash("sha256");
  hash.update(fs.readFileSync(caminho));
  return hash.digest("hex");
}

function construirEntrada(caminhoApk, url, caminhoGradle) {
  if (!fs.existsSync(caminhoApk)) {
    throw new Error(`APK não encontrado: ${caminhoApk}`);
  }
  if (!url || !url.startsWith("https://")) {
    throw new Error(`URL precisa ser https:// — recebido: ${url}`);
  }
  const { versionCode, versionName } = lerVersaoDoGradle(caminhoGradle);
  const tamanho = fs.statSync(caminhoApk).size;
  return {
    versionName,
    versionCode,
    url,
    size: tamanho,
    sha256: sha256DoArquivo(caminhoApk),
  };
}

function main() {
  const args = lerArgs(process.argv.slice(2));

  const manifesto = { schemaVersion: 1 };

  if (args["android-apk"]) {
    if (!args["android-url"]) throw new Error("--android-apk exige --android-url");
    manifesto.android = construirEntrada(
      path.resolve(args["android-apk"]),
      args["android-url"],
      path.join(RAIZ, "android/app/build.gradle"),
    );
  }

  if (args["tv-apk"]) {
    if (!args["tv-url"]) throw new Error("--tv-apk exige --tv-url");
    manifesto.androidTv = construirEntrada(
      path.resolve(args["tv-apk"]),
      args["tv-url"],
      path.join(RAIZ, "android/tv/build.gradle"),
    );
  }

  if (!manifesto.android && !manifesto.androidTv) {
    throw new Error("nada para gerar: informe --android-apk e/ou --tv-apk");
  }

  const destino = path.resolve(args.out || "releases/update-manifest.json");
  fs.mkdirSync(path.dirname(destino), { recursive: true });
  fs.writeFileSync(destino, JSON.stringify(manifesto, null, 2) + "\n", "utf8");

  console.log(`manifesto escrito em ${destino}`);
  if (manifesto.android) {
    console.log(
      `  android:    versionCode=${manifesto.android.versionCode} versionName=${manifesto.android.versionName} ` +
        `tamanho=${manifesto.android.size}B sha256=${manifesto.android.sha256.slice(0, 12)}…`,
    );
  }
  if (manifesto.androidTv) {
    console.log(
      `  androidTv:  versionCode=${manifesto.androidTv.versionCode} versionName=${manifesto.androidTv.versionName} ` +
        `tamanho=${manifesto.androidTv.size}B sha256=${manifesto.androidTv.sha256.slice(0, 12)}…`,
    );
  }
  console.log(
    "\nPróximo passo (manual): suba este arquivo para o R2 no caminho declarado em " +
      "android/gradle.properties (obaflix.updateManifestUrl), junto com o(s) APK.",
  );
}

main();
