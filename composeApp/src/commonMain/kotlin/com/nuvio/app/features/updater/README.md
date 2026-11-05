# Obaflix Android: atualização direta preparada, desativada

Base: `e5f2e9d`. Não há endpoint Android de manifesto confirmado neste repositório.
Os workflows consultados publicam releases GitHub do projeto original; não há configuração R2 reutilizável.
O módulo `obaflix-core-extractor` tem `UPDATE_MANIFEST_URL` vazio e um esquema Obaflix
com `schemaVersion`, `android` e `androidTv`. O novo leitor reutiliza a entrada `android`;
o atualizador da TV e os arquivos desktop/iOS não foram alterados.

## Configuração pendente

`DirectApkUpdateConfig.stableManifestUrl` e `betaManifestUrl` ficam vazios.
Somente preencher com endpoints HTTPS reais confirmados. Links de APK/AAB não são manifestos.
O host autorizado é `app.obaflix.online`; não há caminhos de produção presumidos.
Caso os artefatos reais usem outro host R2/CDN, confirmar sua titularidade antes de
alterar a lista, hoje restrita a esse host. Redirecionamentos são recusados.
Os caminhos `test-only` nos testes são dados fictícios locais e não são configuração.

O JSON esperado tem `schemaVersion: 1` e uma entrada opcional `android` com:
`versionName` (texto), `versionCode` (inteiro positivo), `url` (HTTPS), `size` (bytes,
positivo, até 2 GiB), `sha256` (64 caracteres hexadecimais) e `notes` (texto opcional).
Tamanho e hash são obrigatórios nesta integração, mesmo que o parser antigo os aceite como opcionais.
`androidTv` e campos adicionais são ignorados. Manifestos são limitados a 64 KiB.
Stable e beta têm URLs independentes; nenhum canal recorre ao GitHub do Nuvio no Android.

## Comportamento e limites

O gate global continua `false` em full e Play. URL vazia também impede suporte e consultas.
A variante full guarda uma tentativa por canal a cada quatro horas, inclusive entre reinícios;
checagens automáticas não abrem banner. Falhas respeitam o mesmo intervalo.
Download usa o progresso/interface existentes, sem instalar ou reabrir banner ao concluir.
Instalar exige outro clique e confirmação do instalador Android. O APK é conferido novamente
imediatamente antes desse passo, fora da thread de interface: tamanho, SHA256, pacote, versionCode e certificados atuais idênticos
aos da instalação. Rotação de chave não foi habilitada: requer validação separada.
Arquivos parciais são removidos. O FileProvider e as permissões existentes foram preservados;
`REQUEST_INSTALL_PACKAGES` já pertence somente às variantes full.

Play continua isolado, sem download/instalação externa e sem consulta ao GitHub.
Uma futura integração Play In-App Updates depende da biblioteca/configuração Gradle e da
publicação Play reais; esses arquivos compartilhados não foram alterados. O mecanismo da loja
não está implementado nesta preparação, nem foi habilitado.

## Antes de ativar

Confirmar endpoint/esquema reais, artefato publicado e seu certificado; validar HTTP, falhas,
progresso, troca de canal e instalação em aparelho sem interromper reprodução. Nenhum APK/AAB foi
gerado e nenhuma consulta/publicação em produção foi feita. A ativação global fica para alteração
coordenada com Claude no arquivo compartilhado de política, fora desta Fase F.

Testes locais: `DirectApkUpdateTest`, `ApkUpdateValidationTest`, `UpdaterDistributionBoundaryTest`,
mais regressões de versões, canais e seleção de releases. Compilação isolada dos arquivos Android
contra SDK 36, com rede/resources externos substituídos por doubles somente no harness de teste.
Isso não equivale a um build completo nem a validar um APK real ou o instalador em aparelho.
