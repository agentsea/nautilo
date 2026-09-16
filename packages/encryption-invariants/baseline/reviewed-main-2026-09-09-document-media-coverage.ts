import type { EncryptionCoverageEntry } from "../src/model";
import type { ReviewedDebtLink, RetiredFrozenDebt } from "../src/registry";

/** Exact current-main documentMedia inventory; content remains linked to frozen debt. */
export const REVIEWED_MAIN_2026_09_09_DOCUMENTMEDIA_COVERAGE_ENTRIES: readonly EncryptionCoverageEntry[] = [
  {
    "id": "main.2026-09-09.document-media.metadata.1",
    "surface": "db",
    "locator": "public.video_generation_links",
    "classification": "bounded_metadata",
    "owner": "packages/db",
    "readers": [
      "packages/server",
      "packages/runtime"
    ],
    "writers": [
      "packages/server",
      "packages/runtime"
    ],
    "migrationState": "not_applicable",
    "plaintextReason": "The Video project link stores opaque identities, ownership coordinates, revisions, timestamps, and a one-way brief digest. Human-authored shot_label is reviewed separately as plaintext content debt.",
    "metadataAllowlist": [
      "public.video_generation_links"
    ],
    "retention": "Owning configuration, crypto-repair, Session, or Video-project lifecycle.",
    "testEvidence": [
      "packages/encryption-invariants/tests/integration/reviewed-main-2026-09-09-document-media-security.test.ts"
    ]
  },
  {
    "id": "main.2026-09-09.document-media.metadata.2",
    "surface": "db",
    "locator": "public.video_generation_links.actor_user_id",
    "classification": "bounded_metadata",
    "owner": "packages/db",
    "readers": [
      "packages/server",
      "packages/runtime"
    ],
    "writers": [
      "packages/server",
      "packages/runtime"
    ],
    "migrationState": "not_applicable",
    "plaintextReason": "The Video project link stores opaque identities, ownership coordinates, revisions, timestamps, and a one-way brief digest. Human-authored shot_label is reviewed separately as plaintext content debt.",
    "metadataAllowlist": [
      "public.video_generation_links.actor_user_id"
    ],
    "retention": "Owning configuration, crypto-repair, Session, or Video-project lifecycle.",
    "testEvidence": [
      "packages/encryption-invariants/tests/integration/reviewed-main-2026-09-09-document-media-security.test.ts"
    ]
  },
  {
    "id": "main.2026-09-09.document-media.metadata.3",
    "surface": "db",
    "locator": "public.video_generation_links.admitted_at",
    "classification": "bounded_metadata",
    "owner": "packages/db",
    "readers": [
      "packages/server",
      "packages/runtime"
    ],
    "writers": [
      "packages/server",
      "packages/runtime"
    ],
    "migrationState": "not_applicable",
    "plaintextReason": "The Video project link stores opaque identities, ownership coordinates, revisions, timestamps, and a one-way brief digest. Human-authored shot_label is reviewed separately as plaintext content debt.",
    "metadataAllowlist": [
      "public.video_generation_links.admitted_at"
    ],
    "retention": "Owning configuration, crypto-repair, Session, or Video-project lifecycle.",
    "testEvidence": [
      "packages/encryption-invariants/tests/integration/reviewed-main-2026-09-09-document-media-security.test.ts"
    ]
  },
  {
    "id": "main.2026-09-09.document-media.metadata.4",
    "surface": "db",
    "locator": "public.video_generation_links.brief_digest",
    "classification": "bounded_metadata",
    "owner": "packages/db",
    "readers": [
      "packages/server",
      "packages/runtime"
    ],
    "writers": [
      "packages/server",
      "packages/runtime"
    ],
    "migrationState": "not_applicable",
    "plaintextReason": "The Video project link stores opaque identities, ownership coordinates, revisions, timestamps, and a one-way brief digest. Human-authored shot_label is reviewed separately as plaintext content debt.",
    "metadataAllowlist": [
      "public.video_generation_links.brief_digest"
    ],
    "retention": "Owning configuration, crypto-repair, Session, or Video-project lifecycle.",
    "testEvidence": [
      "packages/encryption-invariants/tests/integration/reviewed-main-2026-09-09-document-media-security.test.ts"
    ]
  },
  {
    "id": "main.2026-09-09.document-media.metadata.5",
    "surface": "db",
    "locator": "public.video_generation_links.created_at",
    "classification": "bounded_metadata",
    "owner": "packages/db",
    "readers": [
      "packages/server",
      "packages/runtime"
    ],
    "writers": [
      "packages/server",
      "packages/runtime"
    ],
    "migrationState": "not_applicable",
    "plaintextReason": "The Video project link stores opaque identities, ownership coordinates, revisions, timestamps, and a one-way brief digest. Human-authored shot_label is reviewed separately as plaintext content debt.",
    "metadataAllowlist": [
      "public.video_generation_links.created_at"
    ],
    "retention": "Owning configuration, crypto-repair, Session, or Video-project lifecycle.",
    "testEvidence": [
      "packages/encryption-invariants/tests/integration/reviewed-main-2026-09-09-document-media-security.test.ts"
    ]
  },
  {
    "id": "main.2026-09-09.document-media.metadata.6",
    "surface": "db",
    "locator": "public.video_generation_links.document_revision",
    "classification": "bounded_metadata",
    "owner": "packages/db",
    "readers": [
      "packages/server",
      "packages/runtime"
    ],
    "writers": [
      "packages/server",
      "packages/runtime"
    ],
    "migrationState": "not_applicable",
    "plaintextReason": "The Video project link stores opaque identities, ownership coordinates, revisions, timestamps, and a one-way brief digest. Human-authored shot_label is reviewed separately as plaintext content debt.",
    "metadataAllowlist": [
      "public.video_generation_links.document_revision"
    ],
    "retention": "Owning configuration, crypto-repair, Session, or Video-project lifecycle.",
    "testEvidence": [
      "packages/encryption-invariants/tests/integration/reviewed-main-2026-09-09-document-media-security.test.ts"
    ]
  },
  {
    "id": "main.2026-09-09.document-media.metadata.7",
    "surface": "db",
    "locator": "public.video_generation_links.id",
    "classification": "bounded_metadata",
    "owner": "packages/db",
    "readers": [
      "packages/server",
      "packages/runtime"
    ],
    "writers": [
      "packages/server",
      "packages/runtime"
    ],
    "migrationState": "not_applicable",
    "plaintextReason": "The Video project link stores opaque identities, ownership coordinates, revisions, timestamps, and a one-way brief digest. Human-authored shot_label is reviewed separately as plaintext content debt.",
    "metadataAllowlist": [
      "public.video_generation_links.id"
    ],
    "retention": "Owning configuration, crypto-repair, Session, or Video-project lifecycle.",
    "testEvidence": [
      "packages/encryption-invariants/tests/integration/reviewed-main-2026-09-09-document-media-security.test.ts"
    ]
  },
  {
    "id": "main.2026-09-09.document-media.metadata.8",
    "surface": "db",
    "locator": "public.video_generation_links.namespace_id",
    "classification": "bounded_metadata",
    "owner": "packages/db",
    "readers": [
      "packages/server",
      "packages/runtime"
    ],
    "writers": [
      "packages/server",
      "packages/runtime"
    ],
    "migrationState": "not_applicable",
    "plaintextReason": "The Video project link stores opaque identities, ownership coordinates, revisions, timestamps, and a one-way brief digest. Human-authored shot_label is reviewed separately as plaintext content debt.",
    "metadataAllowlist": [
      "public.video_generation_links.namespace_id"
    ],
    "retention": "Owning configuration, crypto-repair, Session, or Video-project lifecycle.",
    "testEvidence": [
      "packages/encryption-invariants/tests/integration/reviewed-main-2026-09-09-document-media-security.test.ts"
    ]
  },
  {
    "id": "main.2026-09-09.document-media.metadata.9",
    "surface": "db",
    "locator": "public.video_generation_links.owner_id",
    "classification": "bounded_metadata",
    "owner": "packages/db",
    "readers": [
      "packages/server",
      "packages/runtime"
    ],
    "writers": [
      "packages/server",
      "packages/runtime"
    ],
    "migrationState": "not_applicable",
    "plaintextReason": "The Video project link stores opaque identities, ownership coordinates, revisions, timestamps, and a one-way brief digest. Human-authored shot_label is reviewed separately as plaintext content debt.",
    "metadataAllowlist": [
      "public.video_generation_links.owner_id"
    ],
    "retention": "Owning configuration, crypto-repair, Session, or Video-project lifecycle.",
    "testEvidence": [
      "packages/encryption-invariants/tests/integration/reviewed-main-2026-09-09-document-media-security.test.ts"
    ]
  },
  {
    "id": "main.2026-09-09.document-media.metadata.10",
    "surface": "db",
    "locator": "public.video_generation_links.project_artifact_internal_id",
    "classification": "bounded_metadata",
    "owner": "packages/db",
    "readers": [
      "packages/server",
      "packages/runtime"
    ],
    "writers": [
      "packages/server",
      "packages/runtime"
    ],
    "migrationState": "not_applicable",
    "plaintextReason": "The Video project link stores opaque identities, ownership coordinates, revisions, timestamps, and a one-way brief digest. Human-authored shot_label is reviewed separately as plaintext content debt.",
    "metadataAllowlist": [
      "public.video_generation_links.project_artifact_internal_id"
    ],
    "retention": "Owning configuration, crypto-repair, Session, or Video-project lifecycle.",
    "testEvidence": [
      "packages/encryption-invariants/tests/integration/reviewed-main-2026-09-09-document-media-security.test.ts"
    ]
  },
  {
    "id": "main.2026-09-09.document-media.metadata.11",
    "surface": "db",
    "locator": "public.video_generation_links.receipt_id",
    "classification": "bounded_metadata",
    "owner": "packages/db",
    "readers": [
      "packages/server",
      "packages/runtime"
    ],
    "writers": [
      "packages/server",
      "packages/runtime"
    ],
    "migrationState": "not_applicable",
    "plaintextReason": "The Video project link stores opaque identities, ownership coordinates, revisions, timestamps, and a one-way brief digest. Human-authored shot_label is reviewed separately as plaintext content debt.",
    "metadataAllowlist": [
      "public.video_generation_links.receipt_id"
    ],
    "retention": "Owning configuration, crypto-repair, Session, or Video-project lifecycle.",
    "testEvidence": [
      "packages/encryption-invariants/tests/integration/reviewed-main-2026-09-09-document-media-security.test.ts"
    ]
  },
  {
    "id": "main.2026-09-09.document-media.metadata.12",
    "surface": "db",
    "locator": "public.video_generation_links.request_id",
    "classification": "bounded_metadata",
    "owner": "packages/db",
    "readers": [
      "packages/server",
      "packages/runtime"
    ],
    "writers": [
      "packages/server",
      "packages/runtime"
    ],
    "migrationState": "not_applicable",
    "plaintextReason": "The Video project link stores opaque identities, ownership coordinates, revisions, timestamps, and a one-way brief digest. Human-authored shot_label is reviewed separately as plaintext content debt.",
    "metadataAllowlist": [
      "public.video_generation_links.request_id"
    ],
    "retention": "Owning configuration, crypto-repair, Session, or Video-project lifecycle.",
    "testEvidence": [
      "packages/encryption-invariants/tests/integration/reviewed-main-2026-09-09-document-media-security.test.ts"
    ]
  },
  {
    "id": "main.2026-09-09.document-media.metadata.13",
    "surface": "db",
    "locator": "public.video_generation_links.room_id",
    "classification": "bounded_metadata",
    "owner": "packages/db",
    "readers": [
      "packages/server",
      "packages/runtime"
    ],
    "writers": [
      "packages/server",
      "packages/runtime"
    ],
    "migrationState": "not_applicable",
    "plaintextReason": "The Video project link stores opaque identities, ownership coordinates, revisions, timestamps, and a one-way brief digest. Human-authored shot_label is reviewed separately as plaintext content debt.",
    "metadataAllowlist": [
      "public.video_generation_links.room_id"
    ],
    "retention": "Owning configuration, crypto-repair, Session, or Video-project lifecycle.",
    "testEvidence": [
      "packages/encryption-invariants/tests/integration/reviewed-main-2026-09-09-document-media-security.test.ts"
    ]
  },
  {
    "id": "main.2026-09-09.document-media.metadata.14",
    "surface": "db",
    "locator": "public.video_generation_links.shot_id",
    "classification": "bounded_metadata",
    "owner": "packages/db",
    "readers": [
      "packages/server",
      "packages/runtime"
    ],
    "writers": [
      "packages/server",
      "packages/runtime"
    ],
    "migrationState": "not_applicable",
    "plaintextReason": "The Video project link stores opaque identities, ownership coordinates, revisions, timestamps, and a one-way brief digest. Human-authored shot_label is reviewed separately as plaintext content debt.",
    "metadataAllowlist": [
      "public.video_generation_links.shot_id"
    ],
    "retention": "Owning configuration, crypto-repair, Session, or Video-project lifecycle.",
    "testEvidence": [
      "packages/encryption-invariants/tests/integration/reviewed-main-2026-09-09-document-media-security.test.ts"
    ]
  },
  {
    "id": "main.2026-09-09.document-media.metadata.15",
    "surface": "db",
    "locator": "public.video_generation_links.take_id",
    "classification": "bounded_metadata",
    "owner": "packages/db",
    "readers": [
      "packages/server",
      "packages/runtime"
    ],
    "writers": [
      "packages/server",
      "packages/runtime"
    ],
    "migrationState": "not_applicable",
    "plaintextReason": "The Video project link stores opaque identities, ownership coordinates, revisions, timestamps, and a one-way brief digest. Human-authored shot_label is reviewed separately as plaintext content debt.",
    "metadataAllowlist": [
      "public.video_generation_links.take_id"
    ],
    "retention": "Owning configuration, crypto-repair, Session, or Video-project lifecycle.",
    "testEvidence": [
      "packages/encryption-invariants/tests/integration/reviewed-main-2026-09-09-document-media-security.test.ts"
    ]
  }
];

export const REVIEWED_MAIN_2026_09_09_DOCUMENTMEDIA_DEBT_LINKS: readonly ReviewedDebtLink[] = [
  {
    "id": "main.2026-09-09.document-media.wire-debt.1",
    "surface": "wire",
    "locator": "app_bridge:app_to_host:nautilo.app.asset.cancel",
    "owner": "apps/workbench",
    "targetDebtIds": [
      "debt.wire.http.request.response.get.api.workspace.artifacts.id.lv68nb"
    ],
    "reason": "This exact route, app bridge message, or open leaf is another transport representation of the frozen plaintext Workspace Artifact/document/media boundary. Declaring it does not assert encryption or content-free metadata.",
    "testEvidence": [
      "packages/encryption-invariants/tests/integration/reviewed-main-2026-09-09-document-media-security.test.ts"
    ]
  },
  {
    "id": "main.2026-09-09.document-media.wire-debt.2",
    "surface": "wire",
    "locator": "app_bridge:app_to_host:nautilo.app.asset.req#read",
    "owner": "apps/workbench",
    "targetDebtIds": [
      "debt.wire.http.request.response.get.api.workspace.artifacts.id.lv68nb"
    ],
    "reason": "This exact route, app bridge message, or open leaf is another transport representation of the frozen plaintext Workspace Artifact/document/media boundary. Declaring it does not assert encryption or content-free metadata.",
    "testEvidence": [
      "packages/encryption-invariants/tests/integration/reviewed-main-2026-09-09-document-media-security.test.ts"
    ]
  },
  {
    "id": "main.2026-09-09.document-media.wire-debt.3",
    "surface": "wire",
    "locator": "app_bridge:app_to_host:nautilo.app.assets.req#pick",
    "owner": "apps/workbench",
    "targetDebtIds": [
      "debt.wire.http.request.response.get.api.workspace.artifacts.id.lv68nb"
    ],
    "reason": "This exact route, app bridge message, or open leaf is another transport representation of the frozen plaintext Workspace Artifact/document/media boundary. Declaring it does not assert encryption or content-free metadata.",
    "testEvidence": [
      "packages/encryption-invariants/tests/integration/reviewed-main-2026-09-09-document-media-security.test.ts"
    ]
  },
  {
    "id": "main.2026-09-09.document-media.wire-debt.4",
    "surface": "wire",
    "locator": "app_bridge:app_to_host:nautilo.app.document.req#authoredChange",
    "owner": "apps/workbench",
    "targetDebtIds": [
      "debt.wire.http.request.response.get.api.workspace.artifacts.id.lv68nb"
    ],
    "reason": "This exact route, app bridge message, or open leaf is another transport representation of the frozen plaintext Workspace Artifact/document/media boundary. Declaring it does not assert encryption or content-free metadata.",
    "testEvidence": [
      "packages/encryption-invariants/tests/integration/reviewed-main-2026-09-09-document-media-security.test.ts"
    ]
  },
  {
    "id": "main.2026-09-09.document-media.wire-debt.5",
    "surface": "wire",
    "locator": "app_bridge:app_to_host:nautilo.app.document.req#downloadCopy",
    "owner": "apps/workbench",
    "targetDebtIds": [
      "debt.wire.http.request.response.get.api.workspace.artifacts.id.lv68nb"
    ],
    "reason": "This exact route, app bridge message, or open leaf is another transport representation of the frozen plaintext Workspace Artifact/document/media boundary. Declaring it does not assert encryption or content-free metadata.",
    "testEvidence": [
      "packages/encryption-invariants/tests/integration/reviewed-main-2026-09-09-document-media-security.test.ts"
    ]
  },
  {
    "id": "main.2026-09-09.document-media.wire-debt.6",
    "surface": "wire",
    "locator": "app_bridge:app_to_host:nautilo.app.document.req#downloadCopy#value",
    "owner": "apps/workbench",
    "targetDebtIds": [
      "debt.wire.http.request.response.get.api.workspace.artifacts.id.lv68nb"
    ],
    "reason": "This exact route, app bridge message, or open leaf is another transport representation of the frozen plaintext Workspace Artifact/document/media boundary. Declaring it does not assert encryption or content-free metadata.",
    "testEvidence": [
      "packages/encryption-invariants/tests/integration/reviewed-main-2026-09-09-document-media-security.test.ts"
    ]
  },
  {
    "id": "main.2026-09-09.document-media.wire-debt.7",
    "surface": "wire",
    "locator": "app_bridge:app_to_host:nautilo.app.document.req#saveCopy",
    "owner": "apps/workbench",
    "targetDebtIds": [
      "debt.wire.http.request.response.get.api.workspace.artifacts.id.lv68nb"
    ],
    "reason": "This exact route, app bridge message, or open leaf is another transport representation of the frozen plaintext Workspace Artifact/document/media boundary. Declaring it does not assert encryption or content-free metadata.",
    "testEvidence": [
      "packages/encryption-invariants/tests/integration/reviewed-main-2026-09-09-document-media-security.test.ts"
    ]
  },
  {
    "id": "main.2026-09-09.document-media.wire-debt.8",
    "surface": "wire",
    "locator": "app_bridge:app_to_host:nautilo.app.document.req#saveCopy#value",
    "owner": "apps/workbench",
    "targetDebtIds": [
      "debt.wire.http.request.response.get.api.workspace.artifacts.id.lv68nb"
    ],
    "reason": "This exact route, app bridge message, or open leaf is another transport representation of the frozen plaintext Workspace Artifact/document/media boundary. Declaring it does not assert encryption or content-free metadata.",
    "testEvidence": [
      "packages/encryption-invariants/tests/integration/reviewed-main-2026-09-09-document-media-security.test.ts"
    ]
  },
  {
    "id": "main.2026-09-09.document-media.wire-debt.9",
    "surface": "wire",
    "locator": "app_bridge:app_to_host:nautilo.app.lifecycle.register",
    "owner": "apps/workbench",
    "targetDebtIds": [
      "debt.wire.http.request.response.get.api.workspace.artifacts.id.lv68nb"
    ],
    "reason": "This exact route, app bridge message, or open leaf is another transport representation of the frozen plaintext Workspace Artifact/document/media boundary. Declaring it does not assert encryption or content-free metadata.",
    "testEvidence": [
      "packages/encryption-invariants/tests/integration/reviewed-main-2026-09-09-document-media-security.test.ts"
    ]
  },
  {
    "id": "main.2026-09-09.document-media.wire-debt.10",
    "surface": "wire",
    "locator": "app_bridge:app_to_host:nautilo.app.media.cancel",
    "owner": "apps/workbench",
    "targetDebtIds": [
      "debt.wire.http.request.response.get.api.workspace.artifacts.id.lv68nb"
    ],
    "reason": "This exact route, app bridge message, or open leaf is another transport representation of the frozen plaintext Workspace Artifact/document/media boundary. Declaring it does not assert encryption or content-free metadata.",
    "testEvidence": [
      "packages/encryption-invariants/tests/integration/reviewed-main-2026-09-09-document-media-security.test.ts"
    ]
  },
  {
    "id": "main.2026-09-09.document-media.wire-debt.11",
    "surface": "wire",
    "locator": "app_bridge:app_to_host:nautilo.app.media.req#closePreview",
    "owner": "apps/workbench",
    "targetDebtIds": [
      "debt.wire.http.request.response.get.api.workspace.artifacts.id.lv68nb"
    ],
    "reason": "This exact route, app bridge message, or open leaf is another transport representation of the frozen plaintext Workspace Artifact/document/media boundary. Declaring it does not assert encryption or content-free metadata.",
    "testEvidence": [
      "packages/encryption-invariants/tests/integration/reviewed-main-2026-09-09-document-media-security.test.ts"
    ]
  },
  {
    "id": "main.2026-09-09.document-media.wire-debt.12",
    "surface": "wire",
    "locator": "app_bridge:app_to_host:nautilo.app.media.req#exportCapabilities",
    "owner": "apps/workbench",
    "targetDebtIds": [
      "debt.wire.http.request.response.get.api.workspace.artifacts.id.lv68nb"
    ],
    "reason": "This exact route, app bridge message, or open leaf is another transport representation of the frozen plaintext Workspace Artifact/document/media boundary. Declaring it does not assert encryption or content-free metadata.",
    "testEvidence": [
      "packages/encryption-invariants/tests/integration/reviewed-main-2026-09-09-document-media-security.test.ts"
    ]
  },
  {
    "id": "main.2026-09-09.document-media.wire-debt.13",
    "surface": "wire",
    "locator": "app_bridge:app_to_host:nautilo.app.media.req#exportVideo",
    "owner": "apps/workbench",
    "targetDebtIds": [
      "debt.wire.http.request.response.get.api.workspace.artifacts.id.lv68nb"
    ],
    "reason": "This exact route, app bridge message, or open leaf is another transport representation of the frozen plaintext Workspace Artifact/document/media boundary. Declaring it does not assert encryption or content-free metadata.",
    "testEvidence": [
      "packages/encryption-invariants/tests/integration/reviewed-main-2026-09-09-document-media-security.test.ts"
    ]
  },
  {
    "id": "main.2026-09-09.document-media.wire-debt.14",
    "surface": "wire",
    "locator": "app_bridge:app_to_host:nautilo.app.media.req#importVideo",
    "owner": "apps/workbench",
    "targetDebtIds": [
      "debt.wire.http.request.response.get.api.workspace.artifacts.id.lv68nb"
    ],
    "reason": "This exact route, app bridge message, or open leaf is another transport representation of the frozen plaintext Workspace Artifact/document/media boundary. Declaring it does not assert encryption or content-free metadata.",
    "testEvidence": [
      "packages/encryption-invariants/tests/integration/reviewed-main-2026-09-09-document-media-security.test.ts"
    ]
  },
  {
    "id": "main.2026-09-09.document-media.wire-debt.15",
    "surface": "wire",
    "locator": "app_bridge:app_to_host:nautilo.app.media.req#openPreview",
    "owner": "apps/workbench",
    "targetDebtIds": [
      "debt.wire.http.request.response.get.api.workspace.artifacts.id.lv68nb"
    ],
    "reason": "This exact route, app bridge message, or open leaf is another transport representation of the frozen plaintext Workspace Artifact/document/media boundary. Declaring it does not assert encryption or content-free metadata.",
    "testEvidence": [
      "packages/encryption-invariants/tests/integration/reviewed-main-2026-09-09-document-media-security.test.ts"
    ]
  },
  {
    "id": "main.2026-09-09.document-media.wire-debt.16",
    "surface": "wire",
    "locator": "app_bridge:app_to_host:nautilo.app.media.req#openWorkspaceCopy",
    "owner": "apps/workbench",
    "targetDebtIds": [
      "debt.wire.http.request.response.get.api.workspace.artifacts.id.lv68nb"
    ],
    "reason": "This exact route, app bridge message, or open leaf is another transport representation of the frozen plaintext Workspace Artifact/document/media boundary. Declaring it does not assert encryption or content-free metadata.",
    "testEvidence": [
      "packages/encryption-invariants/tests/integration/reviewed-main-2026-09-09-document-media-security.test.ts"
    ]
  },
  {
    "id": "main.2026-09-09.document-media.wire-debt.17",
    "surface": "wire",
    "locator": "app_bridge:app_to_host:nautilo.app.media.req#saveWorkspaceCopy",
    "owner": "apps/workbench",
    "targetDebtIds": [
      "debt.wire.http.request.response.get.api.workspace.artifacts.id.lv68nb"
    ],
    "reason": "This exact route, app bridge message, or open leaf is another transport representation of the frozen plaintext Workspace Artifact/document/media boundary. Declaring it does not assert encryption or content-free metadata.",
    "testEvidence": [
      "packages/encryption-invariants/tests/integration/reviewed-main-2026-09-09-document-media-security.test.ts"
    ]
  },
  {
    "id": "main.2026-09-09.document-media.wire-debt.18",
    "surface": "wire",
    "locator": "app_bridge:app_to_host:nautilo.app.media.req#workspaceCopyCapabilities",
    "owner": "apps/workbench",
    "targetDebtIds": [
      "debt.wire.http.request.response.get.api.workspace.artifacts.id.lv68nb"
    ],
    "reason": "This exact route, app bridge message, or open leaf is another transport representation of the frozen plaintext Workspace Artifact/document/media boundary. Declaring it does not assert encryption or content-free metadata.",
    "testEvidence": [
      "packages/encryption-invariants/tests/integration/reviewed-main-2026-09-09-document-media-security.test.ts"
    ]
  },
  {
    "id": "main.2026-09-09.document-media.wire-debt.19",
    "surface": "wire",
    "locator": "app_bridge:app_to_host:nautilo.app.video-generation.req#getTakeStatus",
    "owner": "apps/workbench",
    "targetDebtIds": [
      "debt.wire.http.request.response.get.api.workspace.artifacts.id.lv68nb"
    ],
    "reason": "This exact route, app bridge message, or open leaf is another transport representation of the frozen plaintext Workspace Artifact/document/media boundary. Declaring it does not assert encryption or content-free metadata.",
    "testEvidence": [
      "packages/encryption-invariants/tests/integration/reviewed-main-2026-09-09-document-media-security.test.ts"
    ]
  },
  {
    "id": "main.2026-09-09.document-media.wire-debt.20",
    "surface": "wire",
    "locator": "app_bridge:app_to_host:nautilo.app.video-generation.req#importReference",
    "owner": "apps/workbench",
    "targetDebtIds": [
      "debt.wire.http.request.response.get.api.workspace.artifacts.id.lv68nb"
    ],
    "reason": "This exact route, app bridge message, or open leaf is another transport representation of the frozen plaintext Workspace Artifact/document/media boundary. Declaring it does not assert encryption or content-free metadata.",
    "testEvidence": [
      "packages/encryption-invariants/tests/integration/reviewed-main-2026-09-09-document-media-security.test.ts"
    ]
  },
  {
    "id": "main.2026-09-09.document-media.wire-debt.21",
    "surface": "wire",
    "locator": "app_bridge:app_to_host:nautilo.app.video-generation.req#listTakes",
    "owner": "apps/workbench",
    "targetDebtIds": [
      "debt.wire.http.request.response.get.api.workspace.artifacts.id.lv68nb"
    ],
    "reason": "This exact route, app bridge message, or open leaf is another transport representation of the frozen plaintext Workspace Artifact/document/media boundary. Declaring it does not assert encryption or content-free metadata.",
    "testEvidence": [
      "packages/encryption-invariants/tests/integration/reviewed-main-2026-09-09-document-media-security.test.ts"
    ]
  },
  {
    "id": "main.2026-09-09.document-media.wire-debt.22",
    "surface": "wire",
    "locator": "app_bridge:app_to_host:nautilo.app.video-generation.req#previewTake",
    "owner": "apps/workbench",
    "targetDebtIds": [
      "debt.wire.http.request.response.get.api.workspace.artifacts.id.lv68nb"
    ],
    "reason": "This exact route, app bridge message, or open leaf is another transport representation of the frozen plaintext Workspace Artifact/document/media boundary. Declaring it does not assert encryption or content-free metadata.",
    "testEvidence": [
      "packages/encryption-invariants/tests/integration/reviewed-main-2026-09-09-document-media-security.test.ts"
    ]
  },
  {
    "id": "main.2026-09-09.document-media.wire-debt.23",
    "surface": "wire",
    "locator": "app_bridge:app_to_host:nautilo.app.video-generation.req#revalidateTake",
    "owner": "apps/workbench",
    "targetDebtIds": [
      "debt.wire.http.request.response.get.api.workspace.artifacts.id.lv68nb"
    ],
    "reason": "This exact route, app bridge message, or open leaf is another transport representation of the frozen plaintext Workspace Artifact/document/media boundary. Declaring it does not assert encryption or content-free metadata.",
    "testEvidence": [
      "packages/encryption-invariants/tests/integration/reviewed-main-2026-09-09-document-media-security.test.ts"
    ]
  },
  {
    "id": "main.2026-09-09.document-media.wire-debt.24",
    "surface": "wire",
    "locator": "app_bridge:app_to_host:nautilo.app.video-generation.request",
    "owner": "apps/workbench",
    "targetDebtIds": [
      "debt.wire.http.request.response.get.api.workspace.artifacts.id.lv68nb"
    ],
    "reason": "This exact route, app bridge message, or open leaf is another transport representation of the frozen plaintext Workspace Artifact/document/media boundary. Declaring it does not assert encryption or content-free metadata.",
    "testEvidence": [
      "packages/encryption-invariants/tests/integration/reviewed-main-2026-09-09-document-media-security.test.ts"
    ]
  },
  {
    "id": "main.2026-09-09.document-media.wire-debt.25",
    "surface": "wire",
    "locator": "app_bridge:app_to_host:nautilo.app.video-host-layout.req#setFullWidth",
    "owner": "apps/workbench",
    "targetDebtIds": [
      "debt.wire.http.request.response.get.api.workspace.artifacts.id.lv68nb"
    ],
    "reason": "This exact route, app bridge message, or open leaf is another transport representation of the frozen plaintext Workspace Artifact/document/media boundary. Declaring it does not assert encryption or content-free metadata.",
    "testEvidence": [
      "packages/encryption-invariants/tests/integration/reviewed-main-2026-09-09-document-media-security.test.ts"
    ]
  },
  {
    "id": "main.2026-09-09.document-media.wire-debt.26",
    "surface": "wire",
    "locator": "app_bridge:app_to_host_arbitrary:apps/workbench/src/apps/app-bridge.ts#AppDocumentSaveCopyRequest",
    "owner": "apps/workbench",
    "targetDebtIds": [
      "debt.wire.http.request.response.get.api.workspace.artifacts.id.lv68nb"
    ],
    "reason": "This exact route, app bridge message, or open leaf is another transport representation of the frozen plaintext Workspace Artifact/document/media boundary. Declaring it does not assert encryption or content-free metadata.",
    "testEvidence": [
      "packages/encryption-invariants/tests/integration/reviewed-main-2026-09-09-document-media-security.test.ts"
    ]
  },
  {
    "id": "main.2026-09-09.document-media.wire-debt.27",
    "surface": "wire",
    "locator": "app_bridge:app_to_host_arbitrary:apps/workbench/src/apps/app-bridge.ts#AppDocumentSaveCopyRequest#value",
    "owner": "apps/workbench",
    "targetDebtIds": [
      "debt.wire.http.request.response.get.api.workspace.artifacts.id.lv68nb"
    ],
    "reason": "This exact route, app bridge message, or open leaf is another transport representation of the frozen plaintext Workspace Artifact/document/media boundary. Declaring it does not assert encryption or content-free metadata.",
    "testEvidence": [
      "packages/encryption-invariants/tests/integration/reviewed-main-2026-09-09-document-media-security.test.ts"
    ]
  },
  {
    "id": "main.2026-09-09.document-media.wire-debt.28",
    "surface": "wire",
    "locator": "app_bridge:host_to_app:nautilo.app.media.export-progress",
    "owner": "apps/workbench",
    "targetDebtIds": [
      "debt.wire.http.request.response.get.api.workspace.artifacts.id.lv68nb"
    ],
    "reason": "This exact route, app bridge message, or open leaf is another transport representation of the frozen plaintext Workspace Artifact/document/media boundary. Declaring it does not assert encryption or content-free metadata.",
    "testEvidence": [
      "packages/encryption-invariants/tests/integration/reviewed-main-2026-09-09-document-media-security.test.ts"
    ]
  },
  {
    "id": "main.2026-09-09.document-media.wire-debt.29",
    "surface": "wire",
    "locator": "app_bridge:host_to_app:nautilo.app.media.promotion-progress",
    "owner": "apps/workbench",
    "targetDebtIds": [
      "debt.wire.http.request.response.get.api.workspace.artifacts.id.lv68nb"
    ],
    "reason": "This exact route, app bridge message, or open leaf is another transport representation of the frozen plaintext Workspace Artifact/document/media boundary. Declaring it does not assert encryption or content-free metadata.",
    "testEvidence": [
      "packages/encryption-invariants/tests/integration/reviewed-main-2026-09-09-document-media-security.test.ts"
    ]
  },
  {
    "id": "main.2026-09-09.document-media.wire-debt.30",
    "surface": "wire",
    "locator": "app_bridge:host_to_app_arbitrary:apps/workbench/src/apps/app-bridge.ts#VideoWorkspaceMediaExportInput",
    "owner": "apps/workbench",
    "targetDebtIds": [
      "debt.wire.http.request.response.get.api.workspace.artifacts.id.lv68nb"
    ],
    "reason": "This exact route, app bridge message, or open leaf is another transport representation of the frozen plaintext Workspace Artifact/document/media boundary. Declaring it does not assert encryption or content-free metadata.",
    "testEvidence": [
      "packages/encryption-invariants/tests/integration/reviewed-main-2026-09-09-document-media-security.test.ts"
    ]
  },
  {
    "id": "main.2026-09-09.document-media.wire-debt.31",
    "surface": "wire",
    "locator": "app_bridge:host_to_app_arbitrary:apps/workbench/src/apps/app-bridge.ts#VideoWorkspaceMediaExportInput#signal",
    "owner": "apps/workbench",
    "targetDebtIds": [
      "debt.wire.http.request.response.get.api.workspace.artifacts.id.lv68nb"
    ],
    "reason": "This exact route, app bridge message, or open leaf is another transport representation of the frozen plaintext Workspace Artifact/document/media boundary. Declaring it does not assert encryption or content-free metadata.",
    "testEvidence": [
      "packages/encryption-invariants/tests/integration/reviewed-main-2026-09-09-document-media-security.test.ts"
    ]
  },
  {
    "id": "main.2026-09-09.document-media.wire-debt.32",
    "surface": "wire",
    "locator": "app_bridge:host_to_app_arbitrary:apps/workbench/src/apps/app-bridge.ts#VideoWorkspaceMediaExportResult",
    "owner": "apps/workbench",
    "targetDebtIds": [
      "debt.wire.http.request.response.get.api.workspace.artifacts.id.lv68nb"
    ],
    "reason": "This exact route, app bridge message, or open leaf is another transport representation of the frozen plaintext Workspace Artifact/document/media boundary. Declaring it does not assert encryption or content-free metadata.",
    "testEvidence": [
      "packages/encryption-invariants/tests/integration/reviewed-main-2026-09-09-document-media-security.test.ts"
    ]
  },
  {
    "id": "main.2026-09-09.document-media.wire-debt.33",
    "surface": "wire",
    "locator": "app_bridge:host_to_app_arbitrary:apps/workbench/src/apps/app-bridge.ts#VideoWorkspaceMediaExportResult#warnings[]",
    "owner": "apps/workbench",
    "targetDebtIds": [
      "debt.wire.http.request.response.get.api.workspace.artifacts.id.lv68nb"
    ],
    "reason": "This exact route, app bridge message, or open leaf is another transport representation of the frozen plaintext Workspace Artifact/document/media boundary. Declaring it does not assert encryption or content-free metadata.",
    "testEvidence": [
      "packages/encryption-invariants/tests/integration/reviewed-main-2026-09-09-document-media-security.test.ts"
    ]
  },
  {
    "id": "main.2026-09-09.document-media.wire-debt.34",
    "surface": "wire",
    "locator": "http:request_response:GET /api/video-generations",
    "owner": "packages/server",
    "targetDebtIds": [
      "debt.wire.http.request.response.get.api.workspace.artifacts.id.lv68nb"
    ],
    "reason": "This exact route, app bridge message, or open leaf is another transport representation of the frozen plaintext Workspace Artifact/document/media boundary. Declaring it does not assert encryption or content-free metadata.",
    "testEvidence": [
      "packages/encryption-invariants/tests/integration/reviewed-main-2026-09-09-document-media-security.test.ts"
    ]
  },
  {
    "id": "main.2026-09-09.document-media.wire-debt.35",
    "surface": "wire",
    "locator": "http:request_response:GET /api/video-generations#response.body",
    "owner": "packages/server",
    "targetDebtIds": [
      "debt.wire.http.request.response.get.api.workspace.artifacts.id.lv68nb"
    ],
    "reason": "This exact route, app bridge message, or open leaf is another transport representation of the frozen plaintext Workspace Artifact/document/media boundary. Declaring it does not assert encryption or content-free metadata.",
    "testEvidence": [
      "packages/encryption-invariants/tests/integration/reviewed-main-2026-09-09-document-media-security.test.ts"
    ]
  },
  {
    "id": "main.2026-09-09.document-media.wire-debt.36",
    "surface": "wire",
    "locator": "http:request_response:GET /api/video-generations/:takeId/status",
    "owner": "packages/server",
    "targetDebtIds": [
      "debt.wire.http.request.response.get.api.workspace.artifacts.id.lv68nb"
    ],
    "reason": "This exact route, app bridge message, or open leaf is another transport representation of the frozen plaintext Workspace Artifact/document/media boundary. Declaring it does not assert encryption or content-free metadata.",
    "testEvidence": [
      "packages/encryption-invariants/tests/integration/reviewed-main-2026-09-09-document-media-security.test.ts"
    ]
  },
  {
    "id": "main.2026-09-09.document-media.wire-debt.37",
    "surface": "wire",
    "locator": "http:request_response:GET /api/video-generations/:takeId/status#response.body",
    "owner": "packages/server",
    "targetDebtIds": [
      "debt.wire.http.request.response.get.api.workspace.artifacts.id.lv68nb"
    ],
    "reason": "This exact route, app bridge message, or open leaf is another transport representation of the frozen plaintext Workspace Artifact/document/media boundary. Declaring it does not assert encryption or content-free metadata.",
    "testEvidence": [
      "packages/encryption-invariants/tests/integration/reviewed-main-2026-09-09-document-media-security.test.ts"
    ]
  },
  {
    "id": "main.2026-09-09.document-media.wire-debt.38",
    "surface": "wire",
    "locator": "http:request_response:GET /api/workspace/artifacts/:id/authored-change",
    "owner": "packages/server",
    "targetDebtIds": [
      "debt.wire.http.request.response.get.api.workspace.artifacts.id.lv68nb"
    ],
    "reason": "This exact route, app bridge message, or open leaf is another transport representation of the frozen plaintext Workspace Artifact/document/media boundary. Declaring it does not assert encryption or content-free metadata.",
    "testEvidence": [
      "packages/encryption-invariants/tests/integration/reviewed-main-2026-09-09-document-media-security.test.ts"
    ]
  },
  {
    "id": "main.2026-09-09.document-media.wire-debt.39",
    "surface": "wire",
    "locator": "http:request_response:GET /api/workspace/artifacts/:id/authored-change#request.query",
    "owner": "packages/server",
    "targetDebtIds": [
      "debt.wire.http.request.response.get.api.workspace.artifacts.id.lv68nb"
    ],
    "reason": "This exact route, app bridge message, or open leaf is another transport representation of the frozen plaintext Workspace Artifact/document/media boundary. Declaring it does not assert encryption or content-free metadata.",
    "testEvidence": [
      "packages/encryption-invariants/tests/integration/reviewed-main-2026-09-09-document-media-security.test.ts"
    ]
  },
  {
    "id": "main.2026-09-09.document-media.wire-debt.40",
    "surface": "wire",
    "locator": "http:request_response:GET /api/workspace/artifacts/by-public-id/:artifactId",
    "owner": "packages/server",
    "targetDebtIds": [
      "debt.wire.http.request.response.get.api.workspace.artifacts.id.lv68nb"
    ],
    "reason": "This exact route, app bridge message, or open leaf is another transport representation of the frozen plaintext Workspace Artifact/document/media boundary. Declaring it does not assert encryption or content-free metadata.",
    "testEvidence": [
      "packages/encryption-invariants/tests/integration/reviewed-main-2026-09-09-document-media-security.test.ts"
    ]
  },
  {
    "id": "main.2026-09-09.document-media.wire-debt.41",
    "surface": "wire",
    "locator": "http:request_response:GET /api/workspace/shared-with-me",
    "owner": "packages/server",
    "targetDebtIds": [
      "debt.wire.http.request.response.get.api.workspace.artifacts.id.lv68nb"
    ],
    "reason": "This exact route, app bridge message, or open leaf is another transport representation of the frozen plaintext Workspace Artifact/document/media boundary. Declaring it does not assert encryption or content-free metadata.",
    "testEvidence": [
      "packages/encryption-invariants/tests/integration/reviewed-main-2026-09-09-document-media-security.test.ts"
    ]
  },
  {
    "id": "main.2026-09-09.document-media.wire-debt.42",
    "surface": "wire",
    "locator": "http:request_response:POST /api/apps/:appId/video-host-attestation",
    "owner": "packages/server",
    "targetDebtIds": [
      "debt.wire.http.request.response.get.api.workspace.artifacts.id.lv68nb"
    ],
    "reason": "This exact route, app bridge message, or open leaf is another transport representation of the frozen plaintext Workspace Artifact/document/media boundary. Declaring it does not assert encryption or content-free metadata.",
    "testEvidence": [
      "packages/encryption-invariants/tests/integration/reviewed-main-2026-09-09-document-media-security.test.ts"
    ]
  },
  {
    "id": "main.2026-09-09.document-media.wire-debt.43",
    "surface": "wire",
    "locator": "http:request_response:POST /api/apps/:appId/video-host-attestation#request.body.projectArtifactId",
    "owner": "packages/server",
    "targetDebtIds": [
      "debt.wire.http.request.response.get.api.workspace.artifacts.id.lv68nb"
    ],
    "reason": "This exact route, app bridge message, or open leaf is another transport representation of the frozen plaintext Workspace Artifact/document/media boundary. Declaring it does not assert encryption or content-free metadata.",
    "testEvidence": [
      "packages/encryption-invariants/tests/integration/reviewed-main-2026-09-09-document-media-security.test.ts"
    ]
  },
  {
    "id": "main.2026-09-09.document-media.wire-debt.44",
    "surface": "wire",
    "locator": "http:request_response:POST /api/apps/:appId/video-host-attestation#request.body.roomId",
    "owner": "packages/server",
    "targetDebtIds": [
      "debt.wire.http.request.response.get.api.workspace.artifacts.id.lv68nb"
    ],
    "reason": "This exact route, app bridge message, or open leaf is another transport representation of the frozen plaintext Workspace Artifact/document/media boundary. Declaring it does not assert encryption or content-free metadata.",
    "testEvidence": [
      "packages/encryption-invariants/tests/integration/reviewed-main-2026-09-09-document-media-security.test.ts"
    ]
  },
  {
    "id": "main.2026-09-09.document-media.wire-debt.45",
    "surface": "wire",
    "locator": "http:request_response:POST /api/apps/:appId/video-host-attestation#request.body.sourceHash",
    "owner": "packages/server",
    "targetDebtIds": [
      "debt.wire.http.request.response.get.api.workspace.artifacts.id.lv68nb"
    ],
    "reason": "This exact route, app bridge message, or open leaf is another transport representation of the frozen plaintext Workspace Artifact/document/media boundary. Declaring it does not assert encryption or content-free metadata.",
    "testEvidence": [
      "packages/encryption-invariants/tests/integration/reviewed-main-2026-09-09-document-media-security.test.ts"
    ]
  },
  {
    "id": "main.2026-09-09.document-media.wire-debt.46",
    "surface": "wire",
    "locator": "http:request_response:POST /api/apps/:appId/video-host-attestation/revoke",
    "owner": "packages/server",
    "targetDebtIds": [
      "debt.wire.http.request.response.get.api.workspace.artifacts.id.lv68nb"
    ],
    "reason": "This exact route, app bridge message, or open leaf is another transport representation of the frozen plaintext Workspace Artifact/document/media boundary. Declaring it does not assert encryption or content-free metadata.",
    "testEvidence": [
      "packages/encryption-invariants/tests/integration/reviewed-main-2026-09-09-document-media-security.test.ts"
    ]
  },
  {
    "id": "main.2026-09-09.document-media.wire-debt.47",
    "surface": "wire",
    "locator": "http:request_response:POST /api/apps/:appId/video-host-attestation/revoke#request.body",
    "owner": "packages/server",
    "targetDebtIds": [
      "debt.wire.http.request.response.get.api.workspace.artifacts.id.lv68nb"
    ],
    "reason": "This exact route, app bridge message, or open leaf is another transport representation of the frozen plaintext Workspace Artifact/document/media boundary. Declaring it does not assert encryption or content-free metadata.",
    "testEvidence": [
      "packages/encryption-invariants/tests/integration/reviewed-main-2026-09-09-document-media-security.test.ts"
    ]
  },
  {
    "id": "main.2026-09-09.document-media.wire-debt.48",
    "surface": "wire",
    "locator": "http:request_response:POST /api/video-generations/:takeId/submit",
    "owner": "packages/server",
    "targetDebtIds": [
      "debt.wire.http.request.response.get.api.workspace.artifacts.id.lv68nb"
    ],
    "reason": "This exact route, app bridge message, or open leaf is another transport representation of the frozen plaintext Workspace Artifact/document/media boundary. Declaring it does not assert encryption or content-free metadata.",
    "testEvidence": [
      "packages/encryption-invariants/tests/integration/reviewed-main-2026-09-09-document-media-security.test.ts"
    ]
  },
  {
    "id": "main.2026-09-09.document-media.wire-debt.49",
    "surface": "wire",
    "locator": "http:request_response:POST /api/video-generations/:takeId/submit#response.body",
    "owner": "packages/server",
    "targetDebtIds": [
      "debt.wire.http.request.response.get.api.workspace.artifacts.id.lv68nb"
    ],
    "reason": "This exact route, app bridge message, or open leaf is another transport representation of the frozen plaintext Workspace Artifact/document/media boundary. Declaring it does not assert encryption or content-free metadata.",
    "testEvidence": [
      "packages/encryption-invariants/tests/integration/reviewed-main-2026-09-09-document-media-security.test.ts"
    ]
  },
  {
    "id": "main.2026-09-09.document-media.wire-debt.50",
    "surface": "wire",
    "locator": "http:request_response:POST /api/video-generations/prepare",
    "owner": "packages/server",
    "targetDebtIds": [
      "debt.wire.http.request.response.get.api.workspace.artifacts.id.lv68nb"
    ],
    "reason": "This exact route, app bridge message, or open leaf is another transport representation of the frozen plaintext Workspace Artifact/document/media boundary. Declaring it does not assert encryption or content-free metadata.",
    "testEvidence": [
      "packages/encryption-invariants/tests/integration/reviewed-main-2026-09-09-document-media-security.test.ts"
    ]
  },
  {
    "id": "main.2026-09-09.document-media.wire-debt.51",
    "surface": "wire",
    "locator": "http:request_response:POST /api/video-generations/prepare#response.body",
    "owner": "packages/server",
    "targetDebtIds": [
      "debt.wire.http.request.response.get.api.workspace.artifacts.id.lv68nb"
    ],
    "reason": "This exact route, app bridge message, or open leaf is another transport representation of the frozen plaintext Workspace Artifact/document/media boundary. Declaring it does not assert encryption or content-free metadata.",
    "testEvidence": [
      "packages/encryption-invariants/tests/integration/reviewed-main-2026-09-09-document-media-security.test.ts"
    ]
  },
  {
    "id": "main.2026-09-09.document-media.wire-debt.52",
    "surface": "wire",
    "locator": "http:request_response:POST /api/workspace/artifacts/:id/share",
    "owner": "packages/server",
    "targetDebtIds": [
      "debt.wire.http.request.response.get.api.workspace.artifacts.id.lv68nb"
    ],
    "reason": "This exact route, app bridge message, or open leaf is another transport representation of the frozen plaintext Workspace Artifact/document/media boundary. Declaring it does not assert encryption or content-free metadata.",
    "testEvidence": [
      "packages/encryption-invariants/tests/integration/reviewed-main-2026-09-09-document-media-security.test.ts"
    ]
  },
  {
    "id": "main.2026-09-09.document-media.wire-debt.53",
    "surface": "wire",
    "locator": "http:request_response:POST /api/workspace/artifacts/:id/share#request.body.recipientUserId",
    "owner": "packages/server",
    "targetDebtIds": [
      "debt.wire.http.request.response.get.api.workspace.artifacts.id.lv68nb"
    ],
    "reason": "This exact route, app bridge message, or open leaf is another transport representation of the frozen plaintext Workspace Artifact/document/media boundary. Declaring it does not assert encryption or content-free metadata.",
    "testEvidence": [
      "packages/encryption-invariants/tests/integration/reviewed-main-2026-09-09-document-media-security.test.ts"
    ]
  },
  {
    "id": "main.2026-09-09.document-media.video-shot-label",
    "surface": "db",
    "locator": "public.video_generation_links.shot_label",
    "owner": "packages/db",
    "targetDebtIds": [
      "debt.db.public.session_messages.content"
    ],
    "reason": "The Human-authored shot label is a retained plaintext projection of the existing Video generation prompt/project content boundary, not harmless operational metadata.",
    "testEvidence": [
      "packages/encryption-invariants/tests/integration/reviewed-main-2026-09-09-document-media-security.test.ts"
    ],
    "crossBoundaryProjection": {
      "fields": [
        "shot_label"
      ],
      "rationale": "The label is authored inside the same Video project document and accompanies the generation request; it is a compact retained projection of that existing content class."
    }
  }
];

export const RETIRED_MAIN_2026_09_09_DOCUMENTMEDIA_FROZEN_DEBT: readonly RetiredFrozenDebt[] = [];
