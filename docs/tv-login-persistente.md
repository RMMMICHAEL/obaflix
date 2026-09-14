# Android TV — login persistente

Estado em 2026-09-14, branch `fix/tv-login-persistente` (base `main`). Mudam o app
de TV e, sem alteração de comportamento, a injeção de banco em `tvPairing.ts`
para teste. Android mobile, Electron, checkout e schema não mudam.

## 1. Como a sessão funciona

| Peça | Onde vive | Validade |
|---|---|---|
| Access token | só em memória (`SessaoTv`) | 15 min |
| Refresh token | cifrado em disco (`ArmazenamentoSessao`: EncryptedSharedPreferences; envelope AES-GCM + Keystore como alternativa) | 60 dias, rotativo, com detecção de reuso |
| `deviceId` | junto do refresh, cifrado | enquanto o aparelho não for revogado |
| Identidade do aparelho | `fingerprint` = SHA-256 de ANDROID_ID + modelo + fabricante, recalculado a cada abertura | estável entre reinícios |
| Senha | nunca chega à TV — o login é por pareamento com o celular | — |

Na abertura, sem access token em memória, a TV troca o refresh por um par novo
(`POST /api/tv/session`) antes de entrar.

### Access vencido ≠ renovação recusada

| Situação | Sinal | O que a TV faz |
|---|---|---|
| Access vencido | 401 numa rota da API | renova e refaz a chamada uma vez; o usuário não percebe |
| Renovação adiada | rede, timeout, 5xx, 429 na renovação | mantém a credencial; esta chamada fica sem dado (canal: `FalhaTemporaria`); a próxima tenta de novo |
| Renovação recusada | 401 em `POST /api/tv/session` (revogado, expirado, reuso, outro aparelho) | apaga a credencial e volta ao pareamento |

`ChamadaAutenticada.kt` implementa essa separação; `ApiObaflix` usa o mesmo
caminho para catálogo e concessão de canal.

## 2. Diagnóstico

### 2.1 Causa principal (corrigida)

`SessaoAtual.restaurar` tratava **qualquer** falha de renovação como "sem
sessão" e mostrava o pareamento:

- ao ligar a TV, o Wi-Fi costuma subir alguns segundos depois do app; a
  renovação dava `UnknownHostException`/timeout → pareamento;
- 5xx, 429 (bloqueio temporário por IP) e resposta ilegível tinham o mesmo
  efeito;
- a credencial continuava guardada e válida, mas a pessoa pareava de novo.

Agravantes corrigidos junto:

- a restauração rodava no `LaunchedEffect` da Activity; uma Activity recriada
  refazia a verificação e, com falha de rede naquele instante, derrubava para
  o pareamento quem já estava dentro;
- renovações simultâneas com o mesmo refresh pareceriam reuso no servidor e
  revogariam a família inteira;
- logo após o boot, o Keystore de alguns aparelhos ainda não abre; a falha
  fazia `EncryptedSharedPreferences` cair para outro cofre, **vazio**;
- recusa definitiva durante o uso apagava a credencial sem sair da Home;
- na concessão de canal, falha temporária de renovação virava `SemSessao`.

### 2.2 Causa confirmada em builds de teste (não alterada)

`obaflix.allowedSigningCerts` em `android/gradle.properties` vale para **todos**
os builds. APK assinado com outra chave é marcado `UNTRUSTED` e a sessão fica
**só em memória** por decisão de segurança (`sessao_volatil_apk_reassinado`).
Evidência: `tv-debug.apk` é assinado com `CN=Android Debug`, digest
`d65f5e4c…`; a lista aceita só `bdf64ebf…`. Todo APK debug pede login a cada
reinício do processo.

### 2.3 Identidade do aparelho

ANDROID_ID não muda ao reiniciar. Muda com reset de fábrica e, no Android 8+,
é diferente para cada chave de assinatura: trocar entre APK debug e release
gera outro `fingerprint`, o servidor responde 401 e o pareamento é exigido.

## 3. O que mudou

- `RestauracaoSessao.kt` (puro): só **401** ou **ausência de credencial** levam
  ao pareamento. O resto é temporário: splash com "Conectando…" / "Sem conexão.
  Tentando entrar na sua conta…", novas tentativas em 2 s, 4 s, 8 s, 15 s e
  depois a cada 30 s, sem apagar nada. Armazenamento ilegível 5 vezes seguidas
  cai no pareamento, para um Keystore quebrado não prender a TV.
- `ChamadaAutenticada.kt` (puro): access vencido × renovação adiada ×
  renovação recusada.
- `SessaoAtual`: restauração no escopo do processo, uma vez por processo.
- `PareamentoTv.renovarDetalhado`: uma renovação por vez no processo; refresh
  lido dentro da trava; disco antes da memória; 401 limpa a credencial e volta
  ao pareamento.
- `ArmazenamentoSessao.leitura`: distingue "não há credencial" de "não deu para
  ler agora"; cofre principal existente mas ilegível não cai num cofre vazio.
- `tvPairing.ts`: `renovarSessao` aceita o banco por parâmetro, só para teste.
  Regra de reuso inalterada.

Mantido: refresh rotativo com expiração, revogação e detecção de reuso; nenhum
token permanente; nenhuma senha; logout apaga a credencial local mesmo sem
resposta do servidor. A sessão restaurada não autoriza nada sozinha.

## 4. Resposta perdida após a rotação

**Comportamento atual, mantido e testado.** Se o servidor gira o refresh e a
resposta não chega, a TV fica com o token antigo. A próxima renovação é reuso:
a família inteira é revogada — inclusive o sucessor que se perdeu — e o
pareamento é exigido. Fingerprint igual não muda isso.

Testes: `tvSessaoRenovacao.test.ts` (regra real do servidor, banco em memória)
e `SessaoComServidorSimuladoTest` (cliente + servidor simulado).

**Janela de 60 s: não implementada**, por decisão. O fingerprint é hash de
identificadores do aparelho — quem copia o refresh pode copiar o fingerprint.

### Proposta de recuperação com garantias explícitas (não implementada)

Só vale a pena se o smoke mostrar que o cenário acontece na prática.

1. **Prova de posse:** no pareamento, a TV gera um par de chaves **não
   exportável** no Android Keystore e registra a chave pública no `TvDevice`.
   Toda renovação é assinada (hash do refresh + chave de idempotência +
   carimbo de tempo).
2. **Chave de idempotência:** gerada antes do envio e gravada cifrada em disco
   junto do refresh; o servidor guarda o hash dela no sucessor que emitiu.
3. **Reapresentação aceita somente se todas valerem:**
   - assinatura válida da chave registrada do aparelho;
   - mesma chave de idempotência que gerou o sucessor;
   - sucessor ainda não usado nem revogado;
   - dentro de um prazo curto após o uso.

   Nesse caso o sucessor é revogado e um par novo é emitido na mesma família.
4. **Qualquer divergência** → regra atual: família revogada.
5. **Garantias:** um refresh copiado do disco não basta (falta a chave privada
   não exportável); um refresh interceptado não basta (falta a assinatura);
   nenhum token vira permanente; revogação do aparelho continua imediata.
6. **Limites:** aparelhos sem Keystore com chave assimétrica utilizável ficam
   com o comportamento atual. Exige colunas novas (`TvDevice.chavePublica`,
   `TvRefreshToken.idempotenciaHash`), migration e mudança no app — tudo
   dependente de autorização.

## 5. Testes

| Arquivo | Cenários |
|---|---|
| `RestauracaoSessaoTest` (JVM) | reabrir / processo encerrado / religar; sem rede e recuperação; rede fora por muito tempo; logout; revogado/401; recusa após falhas temporárias; Keystore lento; Keystore quebrado; credencial apagada durante a espera; só 401 definitivo |
| `SessaoComServidorSimuladoTest` (JVM) | access vencido renova e refaz; access válido não renova; reabrir três vezes; servidor fora adia sem apagar; abrir sem internet; aparelho revogado; logout; resposta perdida após rotação |
| `tvSessaoRenovacao.test.ts` (web) | rotação consome o antigo; resposta perdida vira reuso e revoga o sucessor; insistência não aceita reuso; aparelho revogado; fingerprint de outro aparelho não consome o token; refresh desconhecido e expirado |

Testes não substituem o aparelho: o smoke abaixo continua pendente.

## 6. APK de teste

Build type `homologacao` (o Android não aceita nome começando com "test"): mesmo
código e **mesma assinatura da release** (a única que persiste a sessão), pacote
`com.obaflix.tv.homologacao`, versão com sufixo `-homologacao`,
auto-atualização desligada e URL do ambiente isolado obrigatória. O build
recusa URL ausente, sem `https://` ou igual à de Production. **Não é release e
não deve ser publicado.**

Pré-requisitos: `android/key.properties` de release na máquina de build (não
versionado) e a URL do ambiente isolado já provisionado.

```bash
cd android && ./gradlew :tv:assembleHomologacao -Pobaflix.urlTeste=https://<ambiente-de-teste>
```

```bash
apksigner verify --print-certs android/tv/build/outputs/apk/homologacao/tv-homologacao.apk
```

O digest SHA-256 impresso precisa ser `bdf64ebf3cc9f841a05d4a60d67c39bc957f69c0f4fd6b66c0465901f6a0de04`.

### 6.1 Crash do primeiro APK de homologação (corrigido)

**Sintoma no smoke:** o processo `com.obaflix.tv.homologacao` morria poucos
segundos após restaurar a sessão, com
`FATAL EXCEPTION: DefaultDispatcher-worker-2` e
`java.lang.IllegalArgumentException: Expected URL scheme 'http' or 'https' but no scheme was found for`.

**Retrace** (`retrace.bat` + `tv/build/outputs/mapping/homologacao/mapping.txt`):
`UpdateChecker$verificar$2` ← `Atualizador$iniciar$1` ← `AppTvKt$AppTv$1`.

**Causa:** a variante desliga a auto-atualização com `UPDATE_MANIFEST_URL = ""`.
Assim que a Home abre, o `AppTv` inicia o `Atualizador`, e
`UpdateChecker.verificar` montava `Request.Builder().url("")` antes do `try`,
numa thread do `Dispatchers.IO`. A exceção escapava e derrubava o processo. Não
tinha relação com login nem com o emulador; a validação de build só conferia
`OBAFLIX_URL`.

**Correção:**

- `UpdateChecker.manifestoConfigurado`: só https válido; vazio, sem esquema ou
  fora de https volta como `ManifestoInvalido`, sem montar requisição;
- `Atualizador`: URL desligada não abre o laço; falha numa checagem não derruba
  o processo (cancelamento preservado);
- fail-fast no Gradle do `:tv` e do `:core-extractor`: toda URL do `BuildConfig`
  da homologação precisa ser https e fora de Production; vazio só para campo
  desligado de propósito (`UPDATE_MANIFEST_URL`); a chave de release é exigida
  só para gerar/instalar o APK.

**Testes:**

- `UpdateCheckerUrlDoManifestoTest` (`core-extractor`) — reproduz o crash;
  falhava com a mesma mensagem antes da correção;
- `ConfiguracaoHomologacaoTest` (`tv/src/testHomologacao`) — confere o
  `BuildConfig` gerado da variante: URLs do `tv` e do `core` iguais, https e
  fora de Production; manifesto vazio tratado como desligado, sem lançar.

```bash
cd android && ./gradlew :core-extractor:testDebugUnitTest :tv:testHomologacaoUnitTest -Pobaflix.urlTeste=https://<ambiente-de-teste>
```

O APK gerado antes desta correção está **reprovado** e não deve ser usado.

## 7. Conferir o APK instalado na TV com problema

Com a depuração por rede ligada na TV:

```bash
adb connect <ip-da-tv>:5555
```

```bash
adb shell dumpsys package com.obaflix.tv | grep -E "versionName|versionCode"
```

```bash
adb shell pm path com.obaflix.tv
```

```bash
adb pull <caminho-impresso-acima> obaflix-tv-instalado.apk
```

```bash
apksigner verify --print-certs obaflix-tv-instalado.apk
```

```bash
adb logcat -d | grep -E "sessao_volatil_apk_reassinado|restauracao_adiada|tv_refresh_recusado|estado_nao_autenticado"
```

Digest diferente de `bdf64ebf…` confirma a causa da seção 2.2 naquele aparelho.

## 8. Smoke em TV física — roteiro

APK `homologacao` da seção 6, apontando para o ambiente isolado.

1. Parear a TV. Navegar até a Home.
2. **Fechar e reabrir:** voltar até sair do app; abrir → entra direto.
3. **Forçar parada:** Configurações → Apps → Obaflix TV (pacote `.homologacao`) → Forçar parada;
   abrir → entra direto.
4. **Desligar e religar:** tirar da tomada por 30 s; religar; abrir o app assim
   que possível → "Conectando…" e depois a Home, sem QR.
5. **Sem internet:** desligar o roteador; abrir o app → "Sem conexão. Tentando
   entrar na sua conta…"; religar o roteador → entra sozinho em até 30 s.
6. **Access vencido:** deixar 20 min sem uso; abrir um conteúdo → carrega sem
   pedir login.
7. **Logout:** Perfil → Sair → pareamento; fechar e abrir → continua no
   pareamento.
8. **Revogação:** parear de novo; no site, remover o aparelho; na TV, abrir algo
   ou reabrir → pareamento.

Registrar foto da tela nos passos 4, 5, 7 e 8 e o `logcat` do passo 8.
