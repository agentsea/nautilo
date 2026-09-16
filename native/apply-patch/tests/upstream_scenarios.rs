//! Portable scenario harness copied from the pinned Codex fixture corpus.
//! Nautilo's harness intentionally asserts preflight-without-mutation for the
//! upstream partial-success scenario rather than reproducing that rejected
//! runtime boundary.

use nautilo_apply_patch::engine::{commit, plan};
use nautilo_apply_patch::parser::parse_patch;
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

const SCENARIOS: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/upstream-scenarios");
const EXPECTED_SCENARIO_IDS: &[&str] = &[
    "001_add_file",
    "002_multiple_operations",
    "003_multiple_chunks",
    "004_move_to_new_directory",
    "005_rejects_empty_patch",
    "006_rejects_missing_context",
    "007_rejects_missing_file_delete",
    "008_rejects_empty_update_hunk",
    "009_requires_existing_file_for_update",
    "010_move_overwrites_existing_destination",
    "011_add_overwrites_existing_file",
    "012_delete_directory_fails",
    "013_rejects_invalid_hunk_header",
    "014_update_file_appends_trailing_newline",
    "015_failure_after_partial_success_leaves_changes",
    "016_pure_addition_update_chunk",
    "017_whitespace_padded_hunk_header",
    "018_whitespace_padded_patch_markers",
    "019_unicode_simple",
    "020_delete_file_success",
    "020_whitespace_padded_patch_marker_lines",
    "021_update_file_deletion_only",
    "022_update_file_end_of_file_marker",
];

#[test]
fn portable_upstream_scenarios_match_expected_or_reject_before_mutation() {
    let mut scenarios: Vec<PathBuf> = fs::read_dir(SCENARIOS)
        .expect("scenario directory")
        .map(|entry| entry.expect("scenario entry").path())
        .filter(|path| path.is_dir())
        .collect();
    scenarios.sort();
    let ids: Vec<&str> = scenarios
        .iter()
        .map(|scenario| {
            scenario
                .file_name()
                .and_then(|name| name.to_str())
                .expect("scenario id")
        })
        .collect();
    assert_eq!(ids, EXPECTED_SCENARIO_IDS, "scenario corpus drift");

    for scenario in scenarios {
        let id = scenario
            .file_name()
            .and_then(|name| name.to_str())
            .expect("scenario id");
        let temp = temp_root(id);
        if scenario.join("input").is_dir() {
            copy_tree(&scenario.join("input"), &temp);
        }
        let before = snapshot(&temp);
        let patch = fs::read_to_string(scenario.join("patch.txt")).expect("patch");
        let parsed = parse_patch(&patch);
        let planned = parsed.and_then(|patch| plan(&temp, &patch));
        if id == "015_failure_after_partial_success_leaves_changes" {
            assert!(planned.is_err(), "rejected boundary must fail in preflight");
            assert_eq!(snapshot(&temp), before, "preflight failure must not mutate");
        } else if id.contains("rejects")
            || id == "009_requires_existing_file_for_update"
            || id == "012_delete_directory_fails"
        {
            assert!(planned.is_err(), "{id} must reject");
            assert_eq!(snapshot(&temp), before, "{id} must not mutate");
        } else {
            let report = commit(&temp, &planned.expect("accepted plan"));
            assert!(!report.partial, "{id}: {:#?}", report.error);
            assert!(report.error.is_none(), "{id}: {:#?}", report.error);
            assert!(report.operations.iter().all(|operation| {
                operation.state == nautilo_apply_patch::engine::OperationState::Applied
            }));
            assert_eq!(
                snapshot(&temp),
                snapshot(&scenario.join("expected")),
                "{id}"
            );
        }
        fs::remove_dir_all(&temp).expect("remove temp root");
    }
}

#[test]
fn parent_relative_path_matches_upstream_resolution() {
    let root = temp_root("parent-relative");
    let target = root.parent().unwrap().join(format!(
        "nautilo-apply-patch-parent-relative-{}.txt",
        std::process::id()
    ));
    let patch = format!(
        "*** Begin Patch\n*** Add File: ../{}\n+no\n*** End Patch",
        target.file_name().unwrap().to_string_lossy()
    );
    let parsed = parse_patch(&patch).unwrap();
    let planned = plan(&root, &parsed).unwrap();
    let report = commit(&root, &planned);
    assert!(report.error.is_none(), "{report:#?}");
    assert_eq!(fs::read_to_string(&target).unwrap(), "no\n");
    fs::remove_dir_all(root).unwrap();
    fs::remove_file(target).unwrap();
}

#[test]
fn absolute_path_matches_upstream_resolution() {
    let root = temp_root("absolute");
    let target = root.parent().unwrap().join(format!(
        "nautilo-apply-patch-absolute-{}.txt",
        std::process::id()
    ));
    let patch = format!(
        "*** Begin Patch\n*** Add File: {}\n+absolute\n*** End Patch",
        target.display()
    );
    let parsed = parse_patch(&patch).unwrap();
    let planned = plan(&root, &parsed).unwrap();
    let report = commit(&root, &planned);
    assert!(report.error.is_none(), "{report:#?}");
    assert_eq!(fs::read_to_string(&target).unwrap(), "absolute\n");
    fs::remove_dir_all(root).unwrap();
    fs::remove_file(target).unwrap();
}

fn temp_root(label: &str) -> PathBuf {
    let value = std::env::temp_dir().join(format!(
        "nautilo-apply-patch-{label}-{}",
        std::process::id()
    ));
    let _ = fs::remove_dir_all(&value);
    fs::create_dir_all(&value).expect("temp root");
    value
}

fn copy_tree(source: &Path, destination: &Path) {
    for entry in fs::read_dir(source).expect("read source") {
        let entry = entry.expect("source entry");
        let target = destination.join(entry.file_name());
        if entry.file_type().expect("source type").is_dir() {
            fs::create_dir_all(&target).expect("mkdir");
            copy_tree(&entry.path(), &target);
        } else {
            fs::copy(entry.path(), target).expect("copy input");
        }
    }
}

fn snapshot(root: &Path) -> BTreeMap<PathBuf, Vec<u8>> {
    let mut entries = BTreeMap::new();
    if root.is_dir() {
        snapshot_inner(root, root, &mut entries);
    }
    entries
}

fn snapshot_inner(base: &Path, directory: &Path, entries: &mut BTreeMap<PathBuf, Vec<u8>>) {
    for entry in fs::read_dir(directory).expect("read snapshot") {
        let entry = entry.expect("snapshot entry");
        let path = entry.path();
        if entry.file_type().expect("snapshot type").is_dir() {
            snapshot_inner(base, &path, entries);
        } else {
            entries.insert(
                path.strip_prefix(base).expect("relative").to_path_buf(),
                fs::read(path).expect("read file"),
            );
        }
    }
}
