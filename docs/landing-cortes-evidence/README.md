# Evidências da landing /cortes

Execução local em build de produção, Lighthouse 13.5.0 e Chrome for Testing 142.0.7444.175. Uma medição válida por perfil, throttling padrão do Lighthouse. Resultados de laboratório, sem dados de tráfego real ou PageSpeed/CrUX de produção.

| Perfil | Desempenho | Acessibilidade | LCP | CLS | TBT |
|---|---:|---:|---:|---:|---:|
| Mobile | 90 | 100 | 3,46 s | 0 | 104 ms |
| Desktop | 100 | 100 | 0,73 s | 0,00066 | 0 ms |

O LCP mobile ainda está acima de 2,5 s. O relatório aponta CSS bloqueante compartilhado e da rota. O bundle React compartilhado também aparece como oportunidade. Não foi alterado o layout global nem o comportamento do site para melhorar o score. Não há baseline Lighthouse válido anterior para afirmar ganho em LCP.

INP de campo não medido. Duas interações locais (CTA e FAQ por Enter) produziram amostras EventTiming de 40 e 24 ms; são evidência de funcionamento local, não um INP representativo. TBT não substitui INP. Referência: https://web.dev/articles/inp.

## Capturas

- [Desktop completo](desktop.png) e [hero desktop](desktop-hero.png).
- [Mobile 390 px completo](mobile.png) e [hero mobile](mobile-hero.png).
- [Mobile 320 px](mobile-320.png).
- [Desktop anterior à revisão](before-desktop.png), apenas comparação visual, não baseline de desempenho.

## Verificações

20 testes de roteamento, SEO e recorte aprovados. Lint, tipos e build aprovados; avisos existentes fora da landing. CTA principal e final chegam a #demonstracao; FAQ abre por Enter; um H1; todos os destinos de âncoras existem; a landing não contém formulário nem link externo. Zero erros de JavaScript no navegador. Larguras 320, 390, 768 e 1440 px sem overflow horizontal. CTA principal termina em y=425 px no viewport 320x740 e y=365 px no viewport 390x844.

A renderização da rota permanece dinâmica por herança do layout. O build registra 1,34 kB específicos e 88,7 kB no primeiro carregamento, ante 3,9 kB / 91,3 kB da implementação anterior. Isso não prova melhora equivalente nas métricas de campo.

## Reproduzir

Use Node/npm existentes. Em Windows, pare apenas o servidor desta cópia antes de gerar Prisma, para evitar bloqueio da DLL. Use credenciais de teste locais, sem serviços de produção; o smoke anônimo não precisa de banco. Para `next start`, defina NEXTAUTH_SECRET efêmero e NEXTAUTH_URL local, sem versionar valores. Defina CHROME_PATH para um Chrome compatível; Chrome 155 retornou NO_NAVSTART e esses resultados foram descartados.

```powershell
npm run lint
npx tsc --noEmit
node --test --import tsx src/lib/__tests__/siteModeCortes.test.ts src/lib/__tests__/siteModeCatalogo.test.ts src/lib/__tests__/siteModeAssinatura.test.ts src/lib/__tests__/siteModeTikTok.test.ts src/lib/__tests__/seoCatalogoFechado.test.ts src/lib/__tests__/recorte.test.ts
npm run build
npm run start -- -p 3218
# Em outro terminal, com o servidor pronto:
npx --yes lighthouse@13.5.0 http://localhost:3218/cortes --only-categories=performance,accessibility --chrome-flags="--headless" --output=json --output-path=mobile-lighthouse.json
npx --yes lighthouse@13.5.0 http://localhost:3218/cortes --preset=desktop --only-categories=performance,accessibility --chrome-flags="--headless" --output=json --output-path=desktop-lighthouse.json
```

Relatórios completos em mobile-lighthouse.json e desktop-lighthouse.json; resumo estruturado em summary.json. Capturas são da página comercial local, não do Electron. A gravação real do aplicativo continua pendente.
