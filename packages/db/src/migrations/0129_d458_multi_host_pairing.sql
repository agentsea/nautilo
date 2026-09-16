DROP INDEX "uq_remote_controller_bindings_controller_active";--> statement-breakpoint
CREATE UNIQUE INDEX "uq_remote_controller_bindings_controller_relay_active" ON "remote_controller_bindings" USING btree ("controller_installation_id","relay_token_id") WHERE "remote_controller_bindings"."revoked_at" IS NULL;
