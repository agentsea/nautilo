-- The quota is an authorization boundary. Default table grants would let the
-- Agent role rewrite admission receipts, so only the product owner may mutate it.
REVOKE ALL ON TABLE "soul_generation_attempts" FROM PUBLIC, "nautilo_agent", "nautilo_crypto";
