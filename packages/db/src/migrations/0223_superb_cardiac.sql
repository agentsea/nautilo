ALTER TABLE "human_crypto_device_group_commits" DROP CONSTRAINT "human_crypto_device_group_commits_transition_size";--> statement-breakpoint
ALTER TABLE "human_crypto_device_group_commits" ADD CONSTRAINT "human_crypto_device_group_commits_transition_size" CHECK (octet_length("human_crypto_device_group_commits"."public_transition_bytes") between 1
      and 3145848);