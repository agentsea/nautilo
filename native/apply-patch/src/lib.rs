//! Nautilo's narrow, product-owned extraction of Codex apply-patch.
//!
//! Upstream source: OpenAI Codex `3389fa554e953d07a12a34f5681aae46f17958f8`,
//! Apache-2.0.  This module intentionally does not import Codex's executable,
//! protocol, sandbox, network, PTY, or filesystem abstraction layers.  Nautilo
//! modifications: a deterministic plan-before-commit engine and a
//! one-request/one-result JSON protocol. Patch paths retain the pinned
//! upstream relative-or-absolute behavior; the enclosing Nautilo
//! Sandbox/Namespace boundary, not this engine, supplies filesystem authority.

pub mod engine;
pub mod parser;
pub mod protocol;
pub mod seek_sequence;

pub const UPSTREAM_REVISION: &str = env!("NAUTILO_APPLY_PATCH_UPSTREAM_REVISION");
pub const PROTOCOL_VERSION: &str = "nautilo.apply_patch/v1";
pub const RUNTIME_VERSION: &str = env!("CARGO_PKG_VERSION");
pub const PROVENANCE_FORMAT: &str = env!("NAUTILO_APPLY_PATCH_PROVENANCE_FORMAT");
pub const UPSTREAM_LICENSE_SHA256: &str = env!("NAUTILO_APPLY_PATCH_LICENSE_SHA256");
pub const UPSTREAM_NOTICE_SHA256: &str = env!("NAUTILO_APPLY_PATCH_NOTICE_SHA256");
pub const NAUTILO_EXTRACTION_REVISION: &str = env!("NAUTILO_APPLY_PATCH_EXTRACTION_REVISION");
