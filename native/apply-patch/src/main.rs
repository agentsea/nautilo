//! Product-owned command entry point.  It accepts no model-controlled argv.

use nautilo_apply_patch::protocol::{FailureKind, Request, execute, version_json};
use std::io::{self, Read};

fn main() {
    let mut arguments = std::env::args();
    let _program = arguments.next();
    match (arguments.next(), arguments.next()) {
        (Some(flag), None) if flag == "--version-json" => {
            println!("{}", version_json());
            return;
        }
        (Some(_), _) => {
            eprintln!("only --version-json is supported; patch requests are stdin JSON");
            std::process::exit(2);
        }
        (None, _) => {}
    }
    let mut input = String::new();
    if let Err(error) = io::stdin().read_to_string(&mut input) {
        eprintln!("failed to read stdin: {error}");
        std::process::exit(2);
    }
    let response = match serde_json::from_str::<Request>(&input) {
        Ok(request) => execute(
            &std::env::current_dir().expect("current directory"),
            request,
        ),
        Err(error) => nautilo_apply_patch::protocol::Response {
            protocol: nautilo_apply_patch::PROTOCOL_VERSION,
            runtime_version: nautilo_apply_patch::RUNTIME_VERSION,
            upstream_revision: nautilo_apply_patch::UPSTREAM_REVISION,
            nautilo_extraction_revision: nautilo_apply_patch::NAUTILO_EXTRACTION_REVISION,
            ok: false,
            partial: false,
            planned_paths: Vec::new(),
            applied_paths: Vec::new(),
            planned_operations: Vec::new(),
            operation_states: Vec::new(),
            failure_kind: Some(FailureKind::Parse),
            error: Some(format!("invalid request JSON: {error}")),
        },
    };
    println!(
        "{}",
        serde_json::to_string(&response).expect("response JSON")
    );
    if !response.ok {
        std::process::exit(1);
    }
}
