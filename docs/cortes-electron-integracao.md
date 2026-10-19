# Integração comercial de cortes no Electron — 19/10/2026

Branch: `feat/cortes-permissoes`.

- A resposta existente de `/api/player/fontes` inclui `cortesNivel` e o estado do controle. Não foi criada requisição HTTP nem consulta adicional para projetar os campos.
- Com controle desligado, downloads e cortes mantêm os gates anteriores, inclusive com monetização ativa. Ligado, completo depende de `downloads`; individual depende de `individual/lote/ia`; lote depende de `lote/ia`. `ia` não implementa geração por IA.
- Opções bloqueadas orientam a contratação do recurso correspondente. Recusa do servidor após abertura do editor também apresenta essa orientação. Nenhum checkout foi criado.
- Autorização única por lote, retry vinculado à operação e correções de navegação/progresso do player foram preservados.

## Validação local

- Electron: 84 testes passaram.
- Web: 1.865 testes passaram; mais 11 testes de progresso passaram.
- Após a suíte, acrescentado teste dos gates reais da interface: arquivo de cortes reexecutado, 34/34 passaram. Cobertura inclui quatro níveis, nível inválido, flag desligada, planos tradicionais, falta de direito, assinatura vencida e operação falsificada.
- Testes focados de cortes, entitlements, downloads/lote e autorização: 164/164 passaram antes do teste adicional da interface.
- Build completo (`prisma generate && next build`) passou: compilação, tipos, lint, 26 páginas estáticas e traces. Permanecem avisos preexistentes de lint.
- `qrcode@1.5.4` e `@types/qrcode@1.5.6` estavam declarados no manifesto/lockfile, mas ausentes da instalação. `npm ci --no-audit --no-fund` restaurou 443 pacotes, sem mudar manifestos ou lockfiles. Prisma foi gerado pelo próprio build, sem migration.
- Uma tentativa de build encontrou falha TLS de Google Fonts. A execução final passou com `NODE_OPTIONS=--dns-result-order=ipv4first` apenas no processo, sem alteração persistente de configuração.

## Segurança e consumo

Revisados: resposta autenticada de direitos, validação do tipo na rota, regras de autorização e gates antes do IPC. Encontrado: operação fora do domínio podia ser tratada como individual/completo. Mitigação: helper nega tipo inválido e rota responde 400 quando o controle está ativo. Nenhum token, provider, credencial ou URL de mídia novo foi exposto.

Sem chamada adicional do cliente. A resolução existente fornece ambos os direitos; com controle ativo e monetização desligada, ela passa a resolver os direitos efetivos para não conceder permissões por padrão.

Limite existente: o Electron recebe bytes de reprodução; o gate comercial não é DRM nem impede recorte externo de mídia já obtida. Não houve teste manual no aplicativo empacotado nem geração de instalador; não foram alterados os arquivos nativos do Electron.

Nenhuma migration aplicada, flag ligada, preço criado ou produção alterada. Main e PR #84 não foram modificados. Sem push, merge ou deploy.
