DO $$ BEGIN IF EXISTS (SELECT 1 FROM "EventoPagamento") THEN RAISE EXCEPTION 'Rollback recusado: há histórico de pagamento.'; END IF; END $$;
DROP TABLE "EventoPagamento";
