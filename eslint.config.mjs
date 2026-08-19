import nextCoreWebVitals from "eslint-config-next/core-web-vitals";
import nextTypescript from "eslint-config-next/typescript";

export default [
  {
    ignores: [
      ".next/**",
      "node_modules/**",
      "analysis/**",
      "releases/**",
      "obaflix-superflix/**",
      "android/**",
      "desktop/dist/**",
      "cloudflare-worker/**",
      "public/**",
    ],
  },
  ...nextCoreWebVitals,
  ...nextTypescript,
  {
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": "off",
    },
  },
  {
    // Processo main do Electron e scripts Node CLI sao CommonJS por exigencia
    // do runtime — `require` aqui e correto, nao um resquicio a migrar.
    files: ["desktop/electron/**/*.js", "scripts/**/*.{js,mjs,ts}"],
    rules: {
      "@typescript-eslint/no-require-imports": "off",
      "import/no-anonymous-default-export": "off",
    },
  },
  {
    // Regras do React Compiler introduzidas pelo eslint-config-next 16.
    // O codigo atual as viola em pontos pre-existentes; ficam como aviso ate
    // a refatoracao dedicada dos componentes, para nao travar o lint agora.
    files: ["src/**/*.{ts,tsx}"],
    rules: {
      "react-hooks/set-state-in-effect": "warn",
      "react-hooks/purity": "warn",
      "react-hooks/refs": "warn",
      "react-hooks/immutability": "warn",
    },
  },
];
