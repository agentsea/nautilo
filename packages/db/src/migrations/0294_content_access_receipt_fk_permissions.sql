-- Custom SQL migration file, put your code below! --
--> statement-breakpoint
-- CONTENT_ACCESS_OPERATIONS_FK_PERMISSIONS
-- Preserve the immutable row/table guards installed by 0282. Their nested
-- parent-absence checks admit only FK cleanup; direct mutation still fails.
GRANT UPDATE, DELETE ON TABLE "content_access_operations" TO "nautilo";--> statement-breakpoint
REVOKE TRUNCATE, REFERENCES, TRIGGER ON TABLE "content_access_operations" FROM "nautilo";
