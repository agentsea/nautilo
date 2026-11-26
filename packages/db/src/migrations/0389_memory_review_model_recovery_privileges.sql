-- Memory review model-recovery diagnostics are product-owned control state.
-- Remove the broad default Agent grant applied when the table was created.
REVOKE ALL PRIVILEGES ON TABLE "memory_review_model_recoveries"
  FROM PUBLIC, "nautilo_agent", "nautilo_crypto";
