//! Narrow JSON runtime behavior beyond the portable upstream scenario corpus.

use nautilo_apply_patch::NAUTILO_EXTRACTION_REVISION;
use nautilo_apply_patch::protocol::{FailureKind, Request, execute};
use std::fs;
use std::path::PathBuf;

const MEBIBYTE: usize = 1024 * 1024;
const WITHDRAWN_FILE_COUNT: usize = 101;
const WITHDRAWN_HUNK_COUNT: usize = 1001;

#[test]
fn successful_request_reports_exact_planned_and_applied_paths() {
    let root = temp_root("protocol-success");
    let response = execute(
        &root,
        Request {
            patch: "*** Begin Patch\n*** Add File: notes.txt\n+hello\n*** End Patch".into(),
        },
    );
    assert!(response.ok, "{response:#?}");
    assert_eq!(
        response.nautilo_extraction_revision,
        NAUTILO_EXTRACTION_REVISION
    );
    assert!(!response.partial);
    assert_eq!(response.failure_kind, None);
    assert_eq!(response.planned_paths, ["notes.txt"]);
    assert_eq!(response.applied_paths, ["notes.txt"]);
    assert_eq!(response.planned_operations.len(), 1);
    assert_eq!(response.planned_operations[0].kind, "add");
    assert_eq!(response.operation_states[0].state, "applied");
    assert_eq!(
        fs::read_to_string(root.join("notes.txt")).unwrap(),
        "hello\n"
    );
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn malformed_patch_reports_a_parse_failure() {
    let root = temp_root("protocol-parse-rejected");
    let response = execute(
        &root,
        Request {
            patch: "not a patch".into(),
        },
    );
    assert!(!response.ok);
    assert!(!response.partial);
    assert_eq!(response.failure_kind, Some(FailureKind::Parse));
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn rejected_request_preserves_the_entire_root() {
    let root = temp_root("protocol-rejected");
    fs::write(root.join("existing.txt"), "before\n").unwrap();
    let response = execute(
        &root,
        Request {
            patch: "*** Begin Patch\n*** Update File: existing.txt\n@@\n-before\n+after\n*** Update File: missing.txt\n@@\n-missing\n+created\n*** End Patch".into(),
        },
    );
    assert!(!response.ok);
    assert!(!response.partial);
    assert_eq!(response.failure_kind, Some(FailureKind::Context));
    assert!(response.applied_paths.is_empty());
    assert!(response.planned_operations.is_empty());
    assert!(response.operation_states.is_empty());
    assert_eq!(
        fs::read_to_string(root.join("existing.txt")).unwrap(),
        "before\n"
    );
    assert!(!root.join("missing.txt").exists());
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn move_is_reported_once_with_source_destination_and_applied_state() {
    let root = temp_root("protocol-move");
    fs::write(root.join("from.txt"), "before\n").unwrap();
    fs::write(root.join("to.txt"), "old destination\n").unwrap();
    let response = execute(
        &root,
        Request {
            patch: "*** Begin Patch\n*** Update File: from.txt\n*** Move to: to.txt\n@@\n-before\n+after\n*** End Patch".into(),
        },
    );
    assert!(response.ok, "{response:#?}");
    assert_eq!(response.planned_operations.len(), 1);
    assert_eq!(response.planned_operations[0].kind, "move");
    assert_eq!(response.planned_operations[0].path, "to.txt");
    assert_eq!(
        response.planned_operations[0].from_path.as_deref(),
        Some("from.txt")
    );
    assert_eq!(response.operation_states.len(), 1);
    assert_eq!(response.operation_states[0].state, "applied");
    assert_eq!(
        response.operation_states[0].operation.from_path.as_deref(),
        Some("from.txt")
    );
    assert_eq!(response.applied_paths, ["to.txt"]);
    assert!(!root.join("from.txt").exists());
    assert_eq!(fs::read_to_string(root.join("to.txt")).unwrap(), "after\n");
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn zero_line_add_is_accepted_as_an_empty_file() {
    let root = temp_root("protocol-empty-add");
    let response = execute(
        &root,
        Request {
            patch: "*** Begin Patch\n*** Add File: empty.txt\n*** End Patch".into(),
        },
    );
    assert!(response.ok, "{response:#?}");
    assert_eq!(response.operation_states[0].state, "applied");
    assert_eq!(fs::read(root.join("empty.txt")).unwrap(), Vec::<u8>::new());
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn execute_accepts_and_commits_a_patch_beyond_every_withdrawn_d448_ceiling() {
    let root = temp_root("protocol-historically-large");
    let existing = root.join("existing.txt");
    let mut existing_contents = "p".repeat(MEBIBYTE + 1);
    existing_contents.push('\n');
    for index in 0..WITHDRAWN_HUNK_COUNT {
        existing_contents.push_str(&format!("old-{index}\n"));
    }
    fs::write(&existing, &existing_contents).unwrap();

    let mut patch = String::from("*** Begin Patch\n");
    for index in 0..WITHDRAWN_FILE_COUNT {
        patch.push_str(&format!(
            "*** Add File: bulk/file-{index:03}.txt\n+{}\n",
            "x".repeat(84_000)
        ));
    }
    patch.push_str("*** Update File: existing.txt\n");
    for index in 0..WITHDRAWN_HUNK_COUNT {
        patch.push_str(&format!("@@\n-old-{index}\n+new-{index}\n"));
    }
    patch.push_str("*** End Patch");

    assert!(
        patch.len() > 8 * MEBIBYTE,
        "patch body must remain unbounded"
    );
    let response = execute(&root, Request { patch });
    assert!(response.ok, "{response:#?}");
    assert_eq!(response.planned_operations.len(), WITHDRAWN_FILE_COUNT + 1);
    assert_eq!(response.applied_paths.len(), WITHDRAWN_FILE_COUNT + 1);
    assert!(
        response
            .operation_states
            .iter()
            .all(|operation| operation.state == "applied")
    );
    assert!(fs::metadata(&existing).unwrap().len() > MEBIBYTE as u64);
    assert!(
        fs::read_to_string(&existing)
            .unwrap()
            .contains("new-1000\n")
    );
    assert!(
        !fs::read_to_string(&existing)
            .unwrap()
            .contains("old-1000\n")
    );

    let total_written_bytes =
        (WITHDRAWN_FILE_COUNT * (84_000 + 1)) as u64 + fs::metadata(&existing).unwrap().len();
    assert!(total_written_bytes > (8 * MEBIBYTE) as u64);
    fs::remove_dir_all(root).unwrap();
}

#[cfg(unix)]
#[test]
fn add_follows_an_existing_symlink_like_upstream_write_file() {
    use std::os::unix::fs::symlink;

    let root = temp_root("protocol-symlink");
    let outside = temp_root("protocol-symlink-outside").join("outside.txt");
    fs::write(&outside, "outside\n").unwrap();
    symlink(&outside, root.join("linked.txt")).unwrap();
    let response = execute(
        &root,
        Request {
            patch: "*** Begin Patch\n*** Add File: linked.txt\n+must not follow\n*** End Patch"
                .into(),
        },
    );
    assert!(response.ok, "{response:#?}");
    assert_eq!(fs::read_to_string(&outside).unwrap(), "must not follow\n");
    assert!(
        fs::symlink_metadata(root.join("linked.txt"))
            .unwrap()
            .file_type()
            .is_symlink()
    );
    fs::remove_dir_all(root).unwrap();
    fs::remove_file(outside).unwrap();
}

fn temp_root(label: &str) -> PathBuf {
    let root = std::env::temp_dir().join(format!(
        "nautilo-apply-patch-{label}-{}",
        std::process::id()
    ));
    let _ = fs::remove_dir_all(&root);
    fs::create_dir_all(&root).unwrap();
    root
}
