//! Fixed stdin/stdout JSON protocol for the Nautilo-owned runtime.

use crate::engine::{ChangeKind, CommitOperation, OperationState, commit, plan};
use crate::parser::parse_patch;
use crate::{
    NAUTILO_EXTRACTION_REVISION, PROTOCOL_VERSION, PROVENANCE_FORMAT, RUNTIME_VERSION,
    UPSTREAM_LICENSE_SHA256, UPSTREAM_NOTICE_SHA256, UPSTREAM_REVISION,
};
use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Request {
    pub patch: String,
}

#[derive(Debug, Serialize)]
pub struct Response {
    pub protocol: &'static str,
    pub runtime_version: &'static str,
    pub upstream_revision: &'static str,
    pub nautilo_extraction_revision: &'static str,
    pub ok: bool,
    pub partial: bool,
    pub planned_paths: Vec<String>,
    pub applied_paths: Vec<String>,
    /// Lower-level 0.1.2 engine plan; later phases translate this to the
    /// trusted child execution report and public result contracts.
    pub planned_operations: Vec<OperationDescriptor>,
    /// One state for every planned operation. `unknown` means the engine could
    /// not restore an operation after an execution-time failure.
    pub operation_states: Vec<OperationStateReport>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub failure_kind: Option<FailureKind>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum FailureKind {
    Parse,
    Context,
    Execution,
}

#[derive(Debug, Serialize)]
pub struct OperationDescriptor {
    pub kind: &'static str,
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub from_path: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct OperationStateReport {
    #[serde(flatten)]
    pub operation: OperationDescriptor,
    pub state: &'static str,
}

pub fn version_json() -> serde_json::Value {
    serde_json::json!({
        "protocol": PROTOCOL_VERSION,
        "runtime_version": RUNTIME_VERSION,
        "upstream_revision": UPSTREAM_REVISION,
        "nautilo_extraction_revision": NAUTILO_EXTRACTION_REVISION,
        "provenance": {
            "format": PROVENANCE_FORMAT,
            "upstream_revision": UPSTREAM_REVISION,
            "license_sha256": UPSTREAM_LICENSE_SHA256,
            "notice_sha256": UPSTREAM_NOTICE_SHA256,
        },
    })
}

pub fn execute(root: &Path, request: Request) -> Response {
    let parsed = match parse_patch(&request.patch) {
        Ok(value) => value,
        Err(error) => return failure(FailureKind::Parse, error),
    };
    let plan = match plan(root, &parsed) {
        Ok(value) => value,
        Err(error) => return failure(FailureKind::Context, error),
    };
    let planned_paths = plan
        .changes
        .iter()
        .map(|change| change.path.display().to_string())
        .collect();
    let planned_operations = plan.changes.iter().map(describe_change).collect();
    let report = commit(root, &plan);
    Response {
        protocol: PROTOCOL_VERSION,
        runtime_version: RUNTIME_VERSION,
        upstream_revision: UPSTREAM_REVISION,
        nautilo_extraction_revision: NAUTILO_EXTRACTION_REVISION,
        ok: report.error.is_none(),
        partial: report.partial,
        planned_paths,
        applied_paths: report
            .operations
            .iter()
            .filter(|operation| operation.state == OperationState::Applied)
            .map(|operation| operation.change.path.display().to_string())
            .collect(),
        planned_operations,
        operation_states: report.operations.iter().map(describe_operation).collect(),
        failure_kind: report.error.as_ref().map(|_| FailureKind::Execution),
        error: report.error,
    }
}

fn failure(kind: FailureKind, error: String) -> Response {
    Response {
        protocol: PROTOCOL_VERSION,
        runtime_version: RUNTIME_VERSION,
        upstream_revision: UPSTREAM_REVISION,
        nautilo_extraction_revision: NAUTILO_EXTRACTION_REVISION,
        ok: false,
        partial: false,
        planned_paths: Vec::new(),
        applied_paths: Vec::new(),
        planned_operations: Vec::new(),
        operation_states: Vec::new(),
        failure_kind: Some(kind),
        error: Some(error),
    }
}

fn describe_change(change: &crate::engine::PlannedChange) -> OperationDescriptor {
    OperationDescriptor {
        kind: kind_name(&change.kind),
        path: change.path.display().to_string(),
        from_path: change
            .from_path
            .as_ref()
            .map(|path| path.display().to_string()),
    }
}

fn describe_operation(operation: &CommitOperation) -> OperationStateReport {
    OperationStateReport {
        operation: describe_change(&operation.change),
        state: match operation.state {
            OperationState::Applied => "applied",
            OperationState::NotApplied => "not_applied",
            OperationState::Unknown => "unknown",
        },
    }
}

fn kind_name(kind: &ChangeKind) -> &'static str {
    match kind {
        ChangeKind::Add => "add",
        ChangeKind::Update => "update",
        ChangeKind::Move => "move",
        ChangeKind::Delete => "delete",
    }
}
