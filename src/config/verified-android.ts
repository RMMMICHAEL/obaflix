import type { Instalador } from "./downloads";

/** Audited 2026-10-08: R2 headers, update manifest, SHA-256 and aapt badging.
 * New/overridden binaries need a fresh audit before showing their metadata.
 */
export function verifiedAndroidMetadata(installer: Instalador) {
  if (installer.url !== "https://app.obaflix.online/Obaflix-1.0.19-ambiente.apk"
    || installer.versao !== "Versão 1.0.19" || installer.tamanho !== "12,6 MB") return null;
  return { label: `${installer.versao} · ${installer.tamanho}`, minimumAndroid: "Android 8 ou superior" };
}
