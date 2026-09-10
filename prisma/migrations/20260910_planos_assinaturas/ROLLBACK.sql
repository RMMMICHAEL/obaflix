-- Rollback de 20260910_planos_assinaturas.
--
-- ESTE ARQUIVO NAO E EXECUTADO POR NADA. Fica versionado ao lado da migration
-- para que desfazer nao dependa de alguem reescrever o SQL sob pressao.
--
-- Antes de rodar isto, saiba que quase nunca e o que voce quer:
--
--   1. O rollback real da Fase 1 e reverter o PR. Nenhuma rota le estas
--      tabelas, entao o aplicativo volta ao estado anterior mesmo com elas
--      presentes no banco. E instantaneo e nao perde nada.
--
--   2. Se o incomodo for so o plano padrao:
--        DELETE FROM "Plano" WHERE "id" = 'gratuito';
--      Seguro enquanto nenhuma Assinatura o referenciar — a FK e RESTRICT e
--      recusa o DELETE se referenciar, que e o comportamento desejado.
--
--   3. So chegue ate aqui se as tabelas precisarem sumir de fato.
--
-- A partir do momento em que existir UMA linha em "Assinatura", este arquivo
-- deixa de ser seguro: ele apaga direito de conta paga. Confira antes.
--
--   SELECT count(*) FROM "Assinatura";   -- precisa ser 0

-- Ordem inversa da criacao, por causa das chaves estrangeiras.
DROP TABLE IF EXISTS "Assinatura";
DROP TABLE IF EXISTS "PlanoPreco";
DROP TABLE IF EXISTS "Plano";
