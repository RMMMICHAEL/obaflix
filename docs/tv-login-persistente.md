# Android TV — login persistente

Estado em 2026-09-13, branch `feat/tv-planos-promocao`. Só o app de TV mudou;
Android mobile, Electron e backend não foram alterados.

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

## 2. Diagnóstico

### 2.1 Causa principal (corrigida)

`SessaoAtual.restaurar` tratava **qualquer** falha de renovação como "sem
sessão" e mostrava o pareamento:

- ao ligar a TV, o Wi-Fi costuma subir alguns segundos depois do app; a
  renovação dava `UnknownHostException`/timeout → pareamento;
- 5xx, 429 (bloqueio temporário por IP) e resposta ilegível tinham o mesmo
  efeito;
- a credencial continuava guardada e válida, mas a pessoa pareava de novo — e
  o novo pareamento criava uma nova família de tokens.

Agravantes corrigidos junto:

- a restauração rodava no `LaunchedEffect` da Activity; uma Activity recriada
  refazia a verificação e, com falha de rede naquele instante, derrubava para
  o pareamento quem já estava dentro;
- renovações simultâneas com o mesmo refresh (várias telas recebendo 401 ao
  mesmo tempo) pareceriam reuso no servidor e revogariam a família inteira;
- logo após o boot, o Keystore de alguns aparelhos ainda não abre. A falha
  fazia `EncryptedSharedPreferences` cair para outro cofre, **vazio**, e a
  sessão guardada parecia inexistente;
- recusa definitiva durante o uso (401 na renovação) apagava a credencial mas
  não mudava o estado — a Home ficava aberta sem sessão.

### 2.2 Causa confirmada em builds de teste (não alterada)

`obaflix.allowedSigningCerts` em `android/gradle.properties` vale para **todos**
os builds. APK assinado com outra chave é marcado `UNTRUSTED` e a sessão fica
**só em memória** por decisão de segurança (`sessao_volatil_apk_reassinado`).
Evidência: `tv-debug.apk` é assinado com `CN=Android Debug`, digest
`d65f5e4c…`, e a lista aceita só `bdf64ebf…`. Todo APK debug pede login a cada
reinício do processo. Se o aparelho relatado usa um APK de teste ou reassinado,
esta é a causa — verificável no logcat pelo evento `sessao_volatil_apk_reassinado`.

### 2.3 Identidade do aparelho

ANDROID_ID não muda ao reiniciar. Muda com reset de fábrica e, no Android 8+,
é diferente para cada chave de assinatura: alternar entre APK debug e release
gera outro `fingerprint`, o servidor responde 401 e o pareamento é exigido —
comportamento correto.

## 3. O que mudou

- `RestauracaoSessao.kt` (puro, testado em JVM): só **401** ou **ausência de
  credencial** levam ao pareamento. Rede, timeout, 5xx, 429, 400 e armazenamento
  momentaneamente ilegível são temporários: a TV fica em "Conectando…" /
  "Sem conexão. Tentando entrar na sua conta…" e tenta de novo (2 s, 4 s, 8 s,
  15 s, depois a cada 30 s), sem apagar nada.
- Armazenamento ilegível 5 vezes seguidas cai no pareamento, para um Keystore
  quebrado não prender a TV no carregamento.
- `SessaoAtual`: restauração no escopo do processo, uma vez por processo;
  estado `Reconectando` na splash, nunca a tela de login antes da decisão.
- `PareamentoTv.renovarDetalhado`: uma renovação por vez no processo; refresh
  lido dentro da trava; disco antes da memória; 401 limpa a credencial, zera o
  access token e volta ao pareamento.
- `ArmazenamentoSessao.leitura`: distingue "não há credencial" de "não deu para
  ler agora"; se o cofre principal existe mas não abre, a falha não é memorizada.

Mantido: refresh rotativo com expiração, revogação e detecção de reuso; nenhum
token permanente; nenhuma senha; logout (`sair`) apaga a credencial local
mesmo sem resposta do servidor. A sessão restaurada não autoriza nada sozinha:
reprodução, planos, canais e VIP continuam decididos no servidor a cada
chamada.

## 4. Risco residual e alteração mínima de backend proposta

Se o servidor gira o refresh e a resposta se perde (timeout depois do commit),
a TV fica com o token já usado; a próxima renovação é tratada como reuso, a
família é revogada e o pareamento é exigido. A trava no processo e a gravação
em disco antes da memória não cobrem esse caso.

**Proposta (não implementada):** janela curta de reapresentação em
`renovarSessao` — um refresh já usado, reapresentado em até 60 s pelo mesmo
`fingerprint`, com sucessores ainda não usados, revoga esses sucessores e emite
um novo par na mesma família. Fora dessas condições, continua reuso.
Contrapartida: quem roubar o refresh e o usar dentro da janela, antes do
aparelho legítimo, fica com a sessão e o aparelho legítimo é deslogado (hoje
os dois caem). Sem schema novo. Precisa de decisão antes de implementar.

## 5. Testes

`RestauracaoSessaoTest` (JVM):

| Cenário | Esperado |
|---|---|
| Fechar e reabrir / processo encerrado / TV religada, com rede | entra sem parear |
| Religada sem rede, depois a rede volta | espera com backoff e entra |
| Rede fora por muito tempo | nunca vira pareamento; espera com teto |
| Access expirado, refresh válido | renova e entra (mesmo caminho da reabertura) |
| Logout explícito (credencial ausente) | pareamento, sem chamar a rede |
| Aparelho revogado / refresh recusado (401) | pareamento |
| Recusa depois de falhas temporárias | pareamento |
| Keystore lento no boot | espera e entra |
| Keystore quebrado de vez | pareamento, sem travar |
| Credencial apagada durante a espera | pareamento |
| Status HTTP | só 401 é definitivo |

Testes JVM não substituem o aparelho: o smoke abaixo continua pendente.

## 6. Smoke em TV física — roteiro

Usar um APK **assinado com a chave de release** (o debug sempre perde a sessão,
seção 2.2), apontando para o ambiente isolado.

1. Parear a TV. Navegar até a Home.
2. Voltar até sair do app; abrir de novo → entra direto.
3. Configurações → Apps → Obaflix TV → Forçar parada; abrir → entra direto.
4. Desligar a TV da tomada por 30 s; religar; abrir o app assim que possível →
   "Conectando…" e depois a Home, sem QR.
5. Desligar o roteador; abrir o app → "Sem conexão. Tentando entrar na sua
   conta…"; religar o roteador → entra sozinho em até 30 s.
6. Deixar 20 min sem uso (access expira); abrir um conteúdo → carrega sem pedir
   login.
7. Perfil → Sair → volta ao pareamento; fechar e abrir → continua no pareamento.
8. Parear de novo; no site, remover o aparelho; na TV, abrir algo ou reabrir o
   app → pareamento.

Fotografar a tela nos passos 4, 5, 7 e 8.
