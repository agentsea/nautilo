ALTER TABLE "crypto_delivery_operations" DROP CONSTRAINT "crypto_delivery_operations_kind";--> statement-breakpoint
ALTER TABLE "crypto_delivery_operations" ADD CONSTRAINT "crypto_delivery_operations_kind" CHECK ("crypto_delivery_operations"."kind" in (
        'first_device_bootstrap', 'device_add', 'device_recovery',
        'device_revoke', 'recovery_rotate', 'human_add', 'human_remove',
        'domain_rebootstrap', 'namespace_bootstrap'
      ));