# AGENTS.md — Obaflix Android nativo

**Antes de alterar qualquer código, leia `docs/CONTRATOS_CRITICOS.md`.** Ele lista os contratos que não podem quebrar
(login Google, sessões, banco/backup, recuperação de dados, domínios/fallback, anúncios Rewarded S2S, Pix/Premium,
addons oficiais, player, certificados, distribuição/atualizador), com arquivos, riscos e testes.

Regras para toda IA e pessoa:
- Rode `node docs/verificar-contratos.mjs` e os testes do módulo (`./gradlew :composeApp:testAndroidHostTest --tests "com.nuvio.app.integration.obaflix.*"`) antes de commitar.
- Área de risco ALTO/CRÍTICO: teste novo ou existente + revisão antes de promover; commit com "Contrato: <área>".
- Sem autorização explícita do dono: nada de push na `main`, merge, deploy/banco/variáveis de Production, DNS, Google Cloud, chaves de assinatura ou manifesto de atualização.
- Nunca escreva credenciais, e-mails, senhas ou tokens em código, logs, commits ou relatórios. Keystore só em segredos do CI.
- Funcionalidade homologada não é reaberta sem pedido do dono.
