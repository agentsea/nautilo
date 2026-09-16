-- ISSUE-M076 — Memory ↔ Namespace M:N junction (additive phase).
-- Backfills from legacy memories.namespace_id; column dropped in 0036.

BEGIN;

CREATE TABLE "memory_namespaces" (
	"memory_id" uuid NOT NULL,
	"namespace_id" uuid NOT NULL,
	"attached_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memory_namespaces_memory_id_namespace_id_pk" PRIMARY KEY("memory_id","namespace_id")
);

ALTER TABLE "memory_namespaces" ADD CONSTRAINT "memory_namespaces_memory_id_memories_id_fk" FOREIGN KEY ("memory_id") REFERENCES "public"."memories"("id") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "memory_namespaces" ADD CONSTRAINT "memory_namespaces_namespace_id_namespaces_id_fk" FOREIGN KEY ("namespace_id") REFERENCES "public"."namespaces"("id") ON DELETE restrict ON UPDATE no action;

CREATE INDEX "idx_memory_namespaces_namespace" ON "memory_namespaces" USING btree ("namespace_id");

CREATE INDEX "idx_memory_namespaces_memory" ON "memory_namespaces" USING btree ("memory_id");

INSERT INTO memory_namespaces (memory_id, namespace_id, attached_at)
SELECT id, namespace_id, COALESCE(updated_at, created_at, now())
FROM memories
WHERE namespace_id IS NOT NULL
ON CONFLICT DO NOTHING;

COMMIT;
