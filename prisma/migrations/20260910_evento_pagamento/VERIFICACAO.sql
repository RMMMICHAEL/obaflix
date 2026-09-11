SELECT relrowsecurity FROM pg_class WHERE oid = '"EventoPagamento"'::regclass;
SELECT count(*) AS policies FROM pg_policies WHERE tablename = 'EventoPagamento';
SELECT indexname FROM pg_indexes WHERE tablename = 'EventoPagamento';
