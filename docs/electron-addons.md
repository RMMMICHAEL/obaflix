# Addons no Electron — primeira etapa

Implementação local em 20/10/2026, a partir de `f5f9971`, na branch `feat/cortes-permissoes`.

## Uso

No player Electron atualizado, abra **Addons**, ative FenixFlix ou Brazuca Torrents e use **Buscar fontes**. Escolha uma fonte disponível. A ativação é local, no arquivo `addons.json` do perfil do aplicativo. Nenhum addon vem ativado.

O servidor e o Electron precisam conter esta mudança. Em aplicativos antigos sem o método de bridge `addons`, o painel não aparece. Uma sessão de reprodução aberta antes desta versão precisa ser reaberta para receber o contexto necessário.

## Fluxo

1. O fluxo existente de anúncio/autorização abre a sessão de fontes. O servidor armazena nela o alvo canônico do conteúdo, incluindo finalidade e identificadores.
2. O painel consulta um addon por vez pelo IPC `desktop-addons`. Só a janela principal e seu frame principal, da origem Obaflix, alcançam esse IPC.
3. Antes da consulta e da resolução, o processo principal consulta `POST /api/player/addons` usando os cookies da própria sessão Electron. O endpoint confere usuário, origem, limite de chamadas, dono da sessão, ambiente Electron, finalidade de reprodução e autorização atual de catálogo.
4. O endpoint devolve somente tipo e identificador. Não recebe nem busca URLs de addons. IMDb já cadastrado dispensa consulta externa; o fallback TMDB usa o cache existente e só ocorre sob demanda.
5. O cliente nativo consulta o protocolo Stremio por HTTPS, limita tempo/tamanho/redirecionamentos e fixa o endereço DNS público conferido na conexão JSON.
6. A interface recebe descrições e identificadores opacos de fontes. A resolução confere novamente a autorização e a associação à sessão antes de entregar a URL.
7. O player reaproveita a reprodução HTTP existente e sua preparação de CDN. A expansão assíncrona dos servidores preserva a fonte local selecionada.

Não há streaming de vídeo pela Vercel. O cliente mantém cache de consulta por sessão durante 60 segundos e compartilha requisições simultâneas. Uma resposta de erro não fica armazenada como sucesso.

## Compatibilidade nesta etapa

- Dois addons conhecidos, ativados explicitamente.
- Manifests com recursos em formato de string ou objeto, tipos e prefixos.
- Filmes e séries por IMDb; episódio em coordenadas canônicas.
- Fontes HTTPS diretas, incluindo HLS reconhecido por extensão, e Referer.
- Fontes externas, torrents e headers adicionais recebem explicação de incompatibilidade.
- Downloads e cortes permanecem disponíveis nos servidores existentes. Fontes de addons não os habilitam nesta etapa; elas não são registradas como fontes de download autorizadas no backend.

Não há mecanismo P2P/torrent nesta entrega. Não há garantia de codec, CORS ou formato para toda URL HTTP. Cabeçalhos Authorization/Cookie/User-Agent específicos, arquivos sem formato compatível com Chromium, legendas de addon e links assinados que exijam renovação própria precisam de etapas seguintes. Não foi copiado o player Kotlin/mpv do Nuvio.

## Código aberto estudado

Referência NuvioDesktop: revisão apresentada pela busca `1229b26cb536ffcc76b95fdfd7cb5d26923f8ca2`. Leituras completas feitas na branch `Dev`.

- [AddonManifestParser](https://github.com/NuvioMedia/NuvioDesktop/blob/Dev/composeApp/src/commonMain/kotlin/com/nuvio/app/features/addons/AddonManifestParser.kt): herança de tipos/prefixos e recursos em dois formatos.
- [AddonModels](https://github.com/NuvioMedia/NuvioDesktop/blob/Dev/composeApp/src/commonMain/kotlin/com/nuvio/app/features/addons/AddonModels.kt): compatibilidade por recurso, tipo e prefixo.
- [AddonTransportUrls](https://github.com/NuvioMedia/NuvioDesktop/blob/Dev/composeApp/src/commonMain/kotlin/com/nuvio/app/features/addons/AddonTransportUrls.kt): endereço de transporte, query de configuração e codificação do identificador.
- [StreamsRepository](https://github.com/NuvioMedia/NuvioDesktop/blob/Dev/composeApp/src/commonMain/kotlin/com/nuvio/app/features/streams/StreamsRepository.kt): separação entre grupo de addon, carregamento e erro. O Nuvio também possui debrid/plugins e seleção automática, que não foram incorporados.
- [Stream do NuvioTV](https://github.com/NuvioMedia/NuvioTV/blob/dev/app/src/main/java/com/nuvio/tv/domain/model/Stream.kt): distinção entre fonte direta e torrent.
- [Protocolo público Stremio](https://github.com/Stremio/stremio-addon-sdk/blob/master/docs/protocol.md).

O código novo implementa o protocolo público em JavaScript/TypeScript para os contratos do Obaflix. Não incorpora trechos Kotlin do Nuvio nem altera a licença do aplicativo. Uma incorporação futura de módulos GPL requer avaliação específica.

## Validação e limites

Testes de protocolo, DNS/HTTPS, compatibilidade, cache, concorrência, sessão trocada/expirada, direito ausente, parâmetros falsificados e IPC não confiável. Teste da interface com componente real, preload real e IPC real em Electron isolado, usando respostas de fontes simuladas. Esse teste confirma ativar, buscar, selecionar fonte HTTP e bloquear torrent; não comprova reprodução real dos provedores.

As consultas públicas anteriores retornaram manifests válidos e lista vazia para Big Buck Bunny. Na execução do cliente novo, FenixFlix respondeu corretamente sem fontes para o filme de teste e Brazuca atingiu o timeout de 10 segundos. Nenhuma mídia dos addons foi baixada.

Build Next/Prisma executado sem banco remoto: URL de banco substituída por endereço local inoperante, chaves TMDB/Upstash retiradas do processo e telemetria Next desativada. Nenhuma migration, seed, flag pública, produção, push, merge, deploy ou instalação do aplicativo foi alterada.

Correção de testes anteriores: três casos de `planosCortes.test.ts` ainda esperavam recusa de download completo. O HEAD já libera essa operação em `downloadPermitido`, desde `e04ecc8`. A política comercial permaneceu inalterada; somente essas expectativas e seus títulos foram atualizados. A integração não modifica essa regra.


### Resultado final

- 17 testes novos passaram (9 nativos, 5 de sessão/regra e 3 da rota).
- A regressão inicial identificou três expectativas antigas de download completo, corrigidas para refletir o HEAD. A regressão final aprovou 93 testes Electron, 1.903 testes web e 11 testes de progresso (2.007 no total, zero falhas).
- Os 50 testes focados de autorização/download/preparação passaram após a revisão.
- TypeScript sem erros e build completo aprovado, com avisos anteriores de lint.
- Interface real do componente em Electron, preload e IPC: ativar, buscar, selecionar HTTPS e bloquear P2P aprovados com dublês locais.
- O runtime isolado existente foi reutilizado. A instalação 1.0.14 não foi substituída; não foi gerado instalador.

Por serem entradas não confiáveis, playlists de addon não são percorridas pelo aprendizado de hosts do Node. HLS que exija Referer em outros hosts poderá precisar de adaptação adicional. Essa restrição não muda o aprendizado dos provedores existentes.

Próximo passo: validar uma mídia autorizada que um dos addons realmente retorne e, separadamente, implementar o transporte P2P necessário para fontes torrent.
