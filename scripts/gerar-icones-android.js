// Gera os ícones de launcher do APK a partir do PNG da marca.
//
//   node scripts/gerar-icones-android.js <origem.png>
//
// O Android quer três coisas distintas do mesmo desenho:
//   1. Ícone adaptativo (API 26+): duas camadas separadas, fundo e frente. O
//      sistema recorta a forma (círculo, quadrado arredondado, "squircle") de
//      acordo com o launcher, e anima as camadas em paralaxe. A frente precisa
//      caber na zona segura central, senão o recorte come o desenho.
//   2. Ícone legado (API < 26): um PNG único já com fundo, sem recorte.
//   3. Play Store: 512x512 com fundo, fora da pasta res/.
//
// Como a arte vem achatada (logo vermelho sobre fundo quase preto), a camada da
// frente é obtida por dominância de vermelho — o fundo tem R≈G≈B e o logo tem R
// muito acima de G e B, então a separação é limpa e preserva o antialiasing.

const fs = require("fs");
const path = require("path");
const sharp = require("sharp");

const RES = path.join(__dirname, "..", "android", "app", "src", "main", "res");

// Cor do fundo, amostrada do próprio PNG (canto superior esquerdo).
const BG_HEX = "#0E0E10";

// Densidades do Android. O ícone adaptativo é sempre 108dp; a zona segura é os
// 72dp centrais, ou seja 66,6% — é por isso que o logo entra reduzido.
const DENSITIES = [
  { nome: "mdpi", adaptativo: 108, legado: 48 },
  { nome: "hdpi", adaptativo: 162, legado: 72 },
  { nome: "xhdpi", adaptativo: 216, legado: 96 },
  { nome: "xxhdpi", adaptativo: 324, legado: 144 },
  { nome: "xxxhdpi", adaptativo: 432, legado: 192 },
];

const SAFE_ZONE = 72 / 108; // 0.666…

/** Isola o logo do fundo, devolvendo um PNG RGBA com fundo transparente. */
async function recortarLogo(source) {
  const { data, info } = await sharp(source).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const out = Buffer.alloc(info.width * info.height * 4);

  for (let i = 0, o = 0; i < data.length; i += 3, o += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    // Quanto o pixel "puxa" para o vermelho. Fundo ≈ 0 (cinza), logo ≈ 220.
    const vermelhidao = r - Math.max(g, b);
    // Rampa suave: mantém as bordas antialiasadas em vez de serrilhar o recorte.
    let alpha = Math.round(((vermelhidao - 8) / (40 - 8)) * 255);
    if (alpha < 0) alpha = 0;
    if (alpha > 255) alpha = 255;
    out[o] = r;
    out[o + 1] = g;
    out[o + 2] = b;
    out[o + 3] = alpha;
  }

  return sharp(out, { raw: { width: info.width, height: info.height, channels: 4 } }).png().toBuffer();
}

/** Recorta a arte em círculo — usado no ic_launcher_round dos launchers antigos. */
function mascaraCircular(size) {
  const r = size / 2;
  return Buffer.from(
    `<svg width="${size}" height="${size}"><circle cx="${r}" cy="${r}" r="${r}" fill="#fff"/></svg>`,
  );
}

(async () => {
  const source = process.argv[2];
  if (!source || !fs.existsSync(source)) {
    console.error("uso: node scripts/gerar-icones-android.js <origem.png>");
    process.exit(1);
  }

  const meta = await sharp(source).metadata();
  console.log(`origem: ${meta.width}x${meta.height}`);
  if (meta.width < 432) console.warn("AVISO: origem menor que 432px — a camada adaptativa sairá interpolada.");

  const logo = await recortarLogo(source);

  for (const { nome, adaptativo, legado } of DENSITIES) {
    const dir = path.join(RES, `mipmap-${nome}`);
    fs.mkdirSync(dir, { recursive: true });

    // ── Camada da frente: logo dentro da zona segura, resto transparente ──
    const alvoLogo = Math.round(adaptativo * SAFE_ZONE);
    const logoRedimensionado = await sharp(logo)
      .resize(alvoLogo, alvoLogo, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 }, kernel: "lanczos3" })
      .toBuffer();
    await sharp({
      create: { width: adaptativo, height: adaptativo, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
    })
      .composite([{ input: logoRedimensionado, gravity: "centre" }])
      .png()
      .toFile(path.join(dir, "ic_launcher_foreground.png"));

    // ── Ícone legado: arte cheia, já com fundo ──
    const cheio = await sharp(source).resize(legado, legado, { fit: "cover", kernel: "lanczos3" }).png().toBuffer();
    await sharp(cheio).toFile(path.join(dir, "ic_launcher.png"));
    await sharp(cheio)
      .composite([{ input: mascaraCircular(legado), blend: "dest-in" }])
      .png()
      .toFile(path.join(dir, "ic_launcher_round.png"));

    console.log(`ok  mipmap-${nome}  frente=${adaptativo}px (logo ${alvoLogo}px)  legado=${legado}px`);
  }

  // ── XML do ícone adaptativo ──
  const dirV26 = path.join(RES, "mipmap-anydpi-v26");
  fs.mkdirSync(dirV26, { recursive: true });
  const adaptativoXml = `<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@color/ic_launcher_background" />
    <foreground android:drawable="@mipmap/ic_launcher_foreground" />
    <monochrome android:drawable="@mipmap/ic_launcher_foreground" />
</adaptive-icon>
`;
  fs.writeFileSync(path.join(dirV26, "ic_launcher.xml"), adaptativoXml);
  fs.writeFileSync(path.join(dirV26, "ic_launcher_round.xml"), adaptativoXml);
  console.log("ok  mipmap-anydpi-v26/ic_launcher.xml + ic_launcher_round.xml");

  // ── Cor de fundo como recurso ──
  const dirValues = path.join(RES, "values");
  fs.mkdirSync(dirValues, { recursive: true });
  fs.writeFileSync(
    path.join(dirValues, "ic_launcher_background.xml"),
    `<?xml version="1.0" encoding="utf-8"?>
<resources>
    <color name="ic_launcher_background">${BG_HEX}</color>
</resources>
`,
  );
  console.log(`ok  values/ic_launcher_background.xml  ${BG_HEX}`);

  // ── Play Store ──
  const playStore = path.join(RES, "..", "ic_launcher-playstore.png");
  await sharp(source).resize(512, 512, { fit: "cover", kernel: "lanczos3" }).png().toFile(playStore);
  console.log("ok  ic_launcher-playstore.png  512x512");
})();
