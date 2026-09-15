# Backlog de produto apos fechamento da Android TV

## Baseline congelada da Android TV

A Android TV foi fechada e congelada nesta rodada em 2026-09-15.

- baseline de codigo homologada: `846d4bf0dee2`;
- branch: `feat/tv-planos-promocao`;
- PR: `#27`;
- handoff: [`android-tv-final.md`](android-tv-final.md);
- arquitetura de foco: [`tv-navegacao-foco.md`](tv-navegacao-foco.md).

Os itens deste backlog sao trabalho futuro e nao reabrem nem alteram silenciosamente essa baseline.

Este backlog nao bloqueia a release atual da TV.

## 1. Ranking canonico e Top 10 Hoje

O backend deve definir a ordem de Popular, Melhor Avaliacao, Top Hoje e Top 10 Hoje.

Website, Android, Android TV e Electron devem exibir a mesma ordem para o mesmo estado de atualizacao.

Os clientes nao devem decidir ranking de forma independente.

Top 10 Hoje deve ser diferente de Em Alta e pode alimentar futuramente os grandes destaques da Home.

## 2. Planos e Checkout

A tela de Planos da Android TV deve servir como referencia visual para Android e Electron.

Preco, desconto, telas, adicionais, total e status da assinatura devem ser confirmados pelo backend.

Na TV, o QR Code deve preservar o plano escolhido e apontar diretamente para o checkout canonico daquele plano.

Android e Electron devem concluir checkout dentro do aplicativo quando possivel.

## 3. Filtros do catalogo

Reorganizar Ano e Ordenar e impedir mudancas involuntarias causadas apenas pelo movimento de foco.

## 4. Colecoes

Colecoes e franquias devem ser definidas pelo backend e compartilhadas entre plataformas.

## 5. Kids

Expandir depois das prioridades anteriores com Filmes, Series, Desenhos, faixa etaria, genero, ano, ranking, franquias e colecoes quando os metadados permitirem.

## Ordem

1. fechar e congelar Android TV;
2. ranking canonico e Top 10 Hoje;
3. Planos e Checkout multiplataforma;
4. filtros do catalogo;
5. Colecoes;
6. expansao de Kids.

Electron continua sendo uma implementacao separada da Android TV, mesmo quando o comportamento esperado for equivalente.
