import "server-only";

const publicValue = (value: string | undefined) => value?.trim() || undefined;

/** Only these public transparency fields may be rendered. Never serialize env. */
export function getLegalConfig() {
  const email = publicValue(process.env.OBAFLIX_PRIVACY_CONTACT_EMAIL);
  return {
    name: publicValue(process.env.OBAFLIX_LEGAL_NAME),
    document: publicValue(process.env.OBAFLIX_LEGAL_DOCUMENT),
    address: publicValue(process.env.OBAFLIX_LEGAL_ADDRESS),
    dpo: publicValue(process.env.OBAFLIX_DPO_NAME),
    email: email && /^[^\s@?&#%]+@[^\s@?&#%]+\.[^\s@?&#%]+$/.test(email) ? email : undefined,
  };
}

export const LEGAL_UPDATED_AT = "8 de outubro de 2026";
