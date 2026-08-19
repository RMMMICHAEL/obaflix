// Gera o .ico multi-resolução do app desktop e o favicon do site a partir de um PNG.
//
//   node scripts/gerar-icones.js <origem.png>
//
// Por que montar o ICO na mão: o ImageMagick não está instalado e as bibliotecas
// de ICO do npm ou só emitem PNG-in-ICO (que versões antigas do Explorer ignoram
// nos tamanhos pequenos) ou arrastam dependências nativas. O formato é simples o
// bastante para escrever direto: DIB de 32 bits nos tamanhos pequenos, que é o que
// o Windows sempre soube ler, e PNG só no quadro de 256 px, onde ele é o padrão.

const fs = require("fs");
const path = require("path");
const sharp = require("sharp");

const SIZES = [16, 24, 32, 48, 64, 128, 256];

/** Quadro no formato clássico: BITMAPINFOHEADER + BGRA de baixo para cima + máscara AND. */
function frameDib(rgba, size) {
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0); // biSize
  header.writeInt32LE(size, 4); // biWidth
  header.writeInt32LE(size * 2, 8); // biHeight = XOR + AND
  header.writeUInt16LE(1, 12); // biPlanes
  header.writeUInt16LE(32, 14); // biBitCount
  header.writeUInt32LE(0, 16); // biCompression = BI_RGB

  const xor = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    // O DIB é armazenado da última linha para a primeira.
    const src = (size - 1 - y) * size * 4;
    const dst = y * size * 4;
    for (let x = 0; x < size; x += 1) {
      const s = src + x * 4;
      const d = dst + x * 4;
      xor[d] = rgba[s + 2];     // B
      xor[d + 1] = rgba[s + 1]; // G
      xor[d + 2] = rgba[s];     // R
      xor[d + 3] = rgba[s + 3]; // A
    }
  }

  // Máscara AND: zerada, porque a transparência real vem do canal alfa do XOR.
  // As linhas são alinhadas em 4 bytes.
  const maskRow = Math.ceil(size / 32) * 4;
  const mask = Buffer.alloc(maskRow * size);

  header.writeUInt32LE(xor.length + mask.length, 20); // biSizeImage
  return Buffer.concat([header, xor, mask]);
}

async function buildIco(source, sizes) {
  const frames = [];
  for (const size of sizes) {
    const image = sharp(source).resize(size, size, { fit: "cover", kernel: "lanczos3" });
    if (size >= 256) {
      // ensureAlpha: sem canal alfa o sharp grava colorType 2 (RGB) e o decoder
      // de ICO do Turbopack recusa o arquivo ("The PNG is not in RGBA format").
      frames.push({ size, data: await image.ensureAlpha().png({ compressionLevel: 9 }).toBuffer(), png: true });
    } else {
      const { data } = await image.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      frames.push({ size, data: frameDib(data, size), png: false });
    }
  }

  const dir = Buffer.alloc(6);
  dir.writeUInt16LE(0, 0); // reservado
  dir.writeUInt16LE(1, 2); // tipo 1 = ícone
  dir.writeUInt16LE(frames.length, 4);

  let offset = 6 + frames.length * 16;
  const entries = [];
  for (const frame of frames) {
    const entry = Buffer.alloc(16);
    entry.writeUInt8(frame.size >= 256 ? 0 : frame.size, 0); // 0 significa 256
    entry.writeUInt8(frame.size >= 256 ? 0 : frame.size, 1);
    entry.writeUInt8(0, 2); // paleta
    entry.writeUInt8(0, 3); // reservado
    entry.writeUInt16LE(1, 4); // planos
    entry.writeUInt16LE(32, 6); // bits por pixel
    entry.writeUInt32LE(frame.data.length, 8);
    entry.writeUInt32LE(offset, 12);
    entries.push(entry);
    offset += frame.data.length;
  }

  return Buffer.concat([dir, ...entries, ...frames.map((f) => f.data)]);
}

(async () => {
  const source = process.argv[2];
  if (!source || !fs.existsSync(source)) {
    console.error("uso: node scripts/gerar-icones.js <origem.png>");
    process.exit(1);
  }

  const meta = await sharp(source).metadata();
  console.log(`origem: ${meta.width}x${meta.height} alpha=${Boolean(meta.hasAlpha)}`);
  if (meta.width < 256 || meta.height < 256) {
    console.warn("AVISO: origem menor que 256x256 — o quadro grande sairá interpolado.");
  }

  const alvos = [
    { arquivo: path.join(__dirname, "..", "desktop", "build", "icon.ico"), sizes: SIZES },
    { arquivo: path.join(__dirname, "..", "src", "app", "favicon.ico"), sizes: [16, 32, 48, 64, 128, 256] },
  ];

  for (const { arquivo, sizes } of alvos) {
    fs.mkdirSync(path.dirname(arquivo), { recursive: true });
    const ico = await buildIco(source, sizes);
    fs.writeFileSync(arquivo, ico);
    console.log(`ok  ${arquivo}  ${(ico.length / 1024).toFixed(1)} kB  quadros=${sizes.join(",")}`);
  }

  // PNG grande para lojas/README e para quem precisar reexportar sem perder o original.
  const png512 = path.join(__dirname, "..", "desktop", "build", "icon.png");
  await sharp(source).resize(512, 512, { fit: "cover", kernel: "lanczos3" }).png().toFile(png512);
  console.log(`ok  ${png512}  512x512`);
})();
