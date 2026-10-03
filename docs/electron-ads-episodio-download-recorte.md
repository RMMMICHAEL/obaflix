# Electron gratuito: anúncios por entrada e download, editor de recorte

Base auditada após fetch: `fe6c4e24288a8a7f0dd6812bcdf9c123c90bba9d`.
Branch: `feat/electron-ads-episodio-download-recorte`.

## Comportamento e autorização

Com `ANUNCIO_ELECTRON_ATIVO=true`, requisição Electron e direito
`anunciosObrigatorios=true`, cada entrada de reprodução pede anúncio. Não lê
`ads:pago`, não registra episódio distinto e não altera `episodiosPorAnuncio`.
Conta paga sai antes do Redis de anúncio, sem desafio ou Direct Link.
`/ads/complete` deixou de gravar marcas persistentes do Electron. As antigas
ficam ignoradas pela decisão Electron; não houve limpeza global de Redis.

Após consumir a concessão em `/fontes`, o servidor emite uma prova opaca de
recuperação com 128 bits, vinculada à conta, instância do player, finalidade e
filme/episódio. TTL: 30 minutos. O player guarda a prova apenas em ref e renova
a lease a cada 10 minutos enquanto montado, usando `/authorize`; esse heartbeat
não emite passe nem exibe anúncio. Recuperação válida recebe passe de uso único,
também preso à instância, que `/fontes` consome. Nova montagem ganha identidade
nova e não recebe a prova anterior. Respostas tardias são descartadas.

Todas as trocas internas de episódio passam pela transição central: cobre o
player imediatamente com preto/loading, preserva `saveProgress` e navega. O
convite Electron só aparece após o mínimo visual de um segundo da nova montagem.
Não existe atraso em API. Série já tinha key por episódio; filme ganhou key
para não herdar mídia e estado ao trocar de filme.

O menu Baixar e a abertura do editor não autorizam download. Cada botão normal
de download executa `liberarAcao`, consome a concessão com finalidade `download`
em `/fontes` e então chama o IPC existente. A operação captura o intervalo e a
fonte antes do anúncio. Mudança durante a autorização ou desmontagem cancela o
IPC. Concessão de reprodução não libera download.

Somente o botão Tentar novamente após falha técnica do IPC reutiliza a operação
em memória, por até cinco minutos contados da autorização original. Conta,
instância, sessão, conteúdo, episódio, modo, intervalo, fonte, URL e Referer têm
de coincidir. Edição, mudança de fonte/conta, conclusão, cancelamento e saída
invalidam a retentativa. Clique normal sempre autoriza uma ação nova.

O editor mantém texto de edição separado do intervalo numérico. Máscara aceita
quatro/seis dígitos e entrada com separadores, sem letras. Estados parciais são
preservados; cursor, Backspace, Delete e seleção são tratados. Valor válido
atualiza intervalo, alças, duração e seek. Início empurra fim quando necessário;
fim nunca fica abaixo de início + 1 s. Blur normaliza o texto contra o intervalo
e a duração. Selecionar o campo para digitar seleciona todo o texto.

## Evidência e limites da homologação

Testes de servidor usam os handlers reais e o MemoryStore de Redis, injetando
somente identidade, direitos, relógio e bloqueio de IP. Cobrem episódios 1/2/3,
reentrada, filme, pago, isolamento de concessão, lease, instância, download e
uso único. Suites existentes mantêm Android, TV, Web, flags e click-ad.

No browser, um harness local não versionado compilou o CustomPlayer real,
substituindo somente navegação Next, sessão da conta, endpoints e bridge/JW.
Foi verificado: sem mídia antes do anúncio gratuito; progresso 300 s preservado;
EP1 → EP2 com blackout imediato e modal em aproximadamente 1,17 s; nenhuma
montagem da mídia do EP2 antes do anúncio; conta paga sem modal; menu/editor
sem nova autorização; digitação real 1119 → 11:19 → seek 679; HH:MM:SS → seek
4279; Backspace; início 01:00 empurrando fim 00:50 para 01:01; download após
consumo em `/fontes`; erro técnico e retry com payload idêntico e sem nova
autorização. Caminhos grid/Continuar Assistindo/anterior/contador/auto-next
também têm verificações de integração estrutural com o player central.

A homologação do proprietário no EXE 1.0.12 e Direct Link externo reais continua
pendente. O harness não prova a abertura do navegador pelo Windows, provedores
de mídia reais ou escrita de arquivo pelo ffmpeg. O download existente não foi
reescrito e nenhum arquivo em `desktop/electron` ou Android foi alterado.

## Segurança e consumo

Revisados: autorização, conclusão, consumo em fontes, replay, escopos de
recuperação, cancelamento e ordem do IPC. A prova é emitida pelo servidor; um
booleano do React não dispensa anúncio. Passe/concessão são de uso único; alvo,
finalidade e conta continuam conferidos; passe de recuperação confere instância.
Não houve nova exposição de provider, credencial, URL interna ou dados de conta
em respostas públicas ou logs. O opaco de recuperação usa respostas no-store.

Riscos existentes: Direct Link usa verificação soft; não há confirmação
servidor-servidor de exibição. Mídia e IPC no Electron continuam no dispositivo;
o frontend normal consome a autorização comercial antes do IPC, mas um cliente
modificado não passa a ser confiável por esta mudança. O limite existente de
20 conclusões/hora também pode limitar muitos downloads consecutivos.

Lease expirada (inclusive suspensão superior a 30 minutos) ou Redis
indisponível não libera conteúdo sem prova. Recuperação não vira autorização
permanente. O custo adicional da manutenção ativa é até seis requisições/hora
por player gratuito Electron, cada uma com GET + EXPIRE no Redis; não há
consulta nova de catálogo, tráfego de vídeo no servidor ou migration.

Preview deve usar flag específica desta branch. Não ligar MONETIZACAO_ATIVA
global, não mudar Production, não mergear e não gerar instalador.
