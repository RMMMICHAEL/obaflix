# Cortes / downloads / IA — separação por permissão de servidor

Base: `origin/main` @799b24e. Branch isolada `feat/cortes-permissoes` (não interfere
na PR #84 `codex/obaflix-cortes` nem em `feat/multi-scene-download`).

## Estado real (auditado)

- **Modelo de direito** (`prisma/schema.prisma` `Plano`): capability por campo, default
  mais restritivo; a lógica nunca ramifica pelo id do plano, só pelo direito. Hoje existe
  **um único** direito de download: `downloads Boolean @default(false)`. Ele cobre, sem
  distinção, download comum, corte único e múltiplos cortes.
- **Resolver** (`src/lib/entitlements.ts` `resolverEntitlements`): **não aceita assinaturas
  simultâneas** — com 2+ válidas lança `assinaturas_ambiguas` (falha fechada). Não há
  stacking nem fluxo de upgrade que encerre a anterior.
- **/api/player/fontes**: a ação (`acao:true`) de `download`/`transmissao` é liberada por
  `autorizarPorAnuncio` (`src/lib/ads/enforcement.ts`). Essa função resolve `direitos` mas
  só os usa para `exigeAnuncio()` — **não** confere `direitos.downloads`. O direito de
  download só viaja como sinal **advisory** ao cliente (`direitos` na resposta, ~linha 565).
  Lote de cortes = **1 concessão** para N trechos (`feat/multi-scene-download`).
- **MONETIZACAO_ATIVA** é flag de anúncios; a decisão de direito é independente dela.

## Arquitetura mínima (sem migration, sem mudança de comportamento)

Um único ponto de decisão no servidor, `finalidade → direito exigido`, default-deny:

```
reproducao  → (nenhum)
download    → downloads
corte       → downloads        # hoje reusa o mesmo direito
cortes      → downloads        # idem; vira direito próprio quando existir
transmissao → (nenhum)         # como hoje
ia / desconhecida → DENY       # nasce negada: não libera de graça por acidente
```

Enforçar esse mapa no gate da ação (`fontes` acao / `autorizarPorAnuncio`) fecha a lacuna
advisory **para finalidades novas** sem alterar download/transmissão atuais. Ganho concreto
e seguro hoje: IA e finalidades futuras já nascem negadas no servidor.

## PARA AQUI — exige migration + decisão comercial

1. **Separar corte único / múltiplos cortes / IA como capacidades pagas distintas** exige
   campo(s) novo(s) em `Plano` (ex.: `cortesNivel "nenhum"|"individual"|"multiplo"`,
   `ia Boolean`), além de `apenasDireitos`, `argumentosDaConsulta` (select), serialização de
   cache e seed. **Coluna nova = migration.** Opção mínima: default `"nenhum"`/`false`
   (restritivo) para não conceder a planos existentes por acidente.
2. **Plano "Cortes" incluir entretenimento:** como não há stacking, o Cortes não soma a um
   plano de entretenimento — precisa ser **uma** assinatura que já ligue `filmes/series/
   downloads` + direito de cortes. O que o Cortes concede e o preço são **decisão comercial**.
3. **Risco de bloqueio por ambiguidade:** vender Cortes a quem já tem assinatura ativa cria
   2 assinaturas válidas → `resolverEntitlements` lança `assinaturas_ambiguas` e **bloqueia a
   reprodução**. O fluxo de compra do Cortes **precisa encerrar/substituir** a assinatura
   anterior — esse fluxo de upgrade ainda não existe (código + decisão comercial pendentes).

## Reuso

Múltiplos cortes já implementados em `feat/multi-scene-download` (1 lote = 1 autorização,
`finalidade=download`). Integração = apontar a finalidade de cortes para o novo direito
quando ele existir; até lá ela usa `downloads` e **não** libera nada novo. Usuários e planos
tradicionais permanecem intactos (nenhuma assinatura existente é tocada).
