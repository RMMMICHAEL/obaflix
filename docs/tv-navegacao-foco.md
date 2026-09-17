# Android TV - Navegacao por foco

> **Baseline final desta rodada:** `a6bdff5` (0.7.26). A arquitetura de foco da Home
> nao mudou desde `846d4bf0dee2`, onde foi estabilizada.
> Branch `feat/tv-planos-promocao`, PR `#27`, fechamento tecnico em 2026-09-15, atualizado em 2026-09-16.
> Handoff completo: [`android-tv-final.md`](android-tv-final.md).

O commit acima e a referencia do codigo que produziu o APK final.
Commits posteriores exclusivamente documentais nao substituem essa baseline de codigo.

## Decisao canonica

A navegacao da Home deve usar a busca de foco 2D padrao do Jetpack Compose.

A implementacao aprovada usa LazyRow com Modifier.focusGroup().

Nao reintroduzir sem nova evidencia concreta:

- focusProperties.enter para forcar entrada no primeiro card;
- FocusRequester especial do primeiro card;
- scrollToItem(0) ao sair da fileira;
- bridge global de UP e DOWN;
- troca da LazyColumn por workaround de foco.

Fileiras vazias devem ser ignoradas.

## Historico

O commit f8182b7 introduziu entrada forcada pelo primeiro card.

O commit 543702d removeu focusProperties.enter porque o D-pad podia travar ao atravessar fileiras em TV fisica.

A referencia estavel ficou na TV 0.7.28, commit 1ab5e48.

A correcao atual restaura essa arquitetura conhecida como boa, adaptada apenas ao necessario nas APIs atuais.

## Validacao

Testes JVM e compilacao de homologacao passaram na validacao anterior.

Smoke aprovado:

SMOKE_0728_NAVEGACAO_VERTICAL_OK

Fluxo validado:

- barra superior para destaque;
- destaque para primeira fileira;
- RIGHT duas vezes;
- DOWN para outra fileira;
- LEFT continuando funcional;
- UP retornando para a fileira anterior;
- PID estavel;
- foco sem cair no FrameLayout raiz.

O SHA-256 423795074125a1a308d418a53ccfcae71cb235f3d4aa51df95314c3b686e1035 pertence somente aquela compilacao (`846d4bf0dee2`) e nao deve ser usado como constante futura.

Observacao de UX aceita (nao bloqueante): ao navegar verticalmente entre fileiras o foco mantem a posicao horizontal aproximada, em vez de entrar no primeiro item. Nao reintroduzir `focusProperties.enter` para isso: na 0.7.27 congelou o D-pad em TV fisica.

Mudancas futuras na arquitetura de foco exigem regressao reproduzivel, evidencia de foco vivo, comparacao com a versao conhecida como boa e teste real de D-pad.
