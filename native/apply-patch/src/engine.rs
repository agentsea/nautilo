//! Nautilo-owned plan/commit engine around the extracted Codex grammar.
//!
//! The parser and context matching derive from Codex. This module is a Nautilo
//! modification: it validates patch contexts into an in-memory plan before the
//! first filesystem mutation. Filesystem authority belongs to the caller's
//! sandbox; patch paths retain the upstream relative-or-absolute behavior.
//! Commits use same-directory temporary files plus rename. A failed operation
//! reports an explicit zero-prefix or unknown state rather than claiming an
//! applied mutation.

use crate::parser::{Hunk, ParsedPatch, UpdateChunk};
use crate::seek_sequence::seek_sequence;
use std::collections::BTreeMap;
use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ChangeKind {
    Add,
    Update,
    Move,
    Delete,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PlannedChange {
    /// Destination for add/update/move, or the path removed by delete.
    pub path: PathBuf,
    /// Present only for a move. The move remains one operation in every report.
    pub from_path: Option<PathBuf>,
    pub kind: ChangeKind,
    pub contents: Option<String>,
}

#[derive(Clone, Debug)]
pub struct Plan {
    pub changes: Vec<PlannedChange>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OperationState {
    Applied,
    NotApplied,
    Unknown,
}

#[derive(Clone, Debug)]
pub struct CommitOperation {
    pub change: PlannedChange,
    pub state: OperationState,
}

#[derive(Clone, Debug)]
pub struct CommitReport {
    pub operations: Vec<CommitOperation>,
    pub partial: bool,
    pub error: Option<String>,
}

pub fn plan(root: &Path, patch: &ParsedPatch) -> Result<Plan, String> {
    let mut state = BTreeMap::<PathBuf, Option<String>>::new();
    let mut changes = Vec::new();
    for hunk in &patch.hunks {
        match hunk {
            Hunk::Add { path, contents } => {
                let path = path.clone();
                state.insert(path.clone(), Some(contents.clone()));
                changes.push(PlannedChange {
                    path,
                    from_path: None,
                    kind: ChangeKind::Add,
                    contents: Some(contents.clone()),
                });
            }
            Hunk::Delete { path } => {
                let path = path.clone();
                if load(root, &path, &mut state)?.is_none() {
                    return Err(format!("missing file for delete: {}", path.display()));
                }
                state.insert(path.clone(), None);
                changes.push(PlannedChange {
                    path,
                    from_path: None,
                    kind: ChangeKind::Delete,
                    contents: None,
                });
            }
            Hunk::Update {
                path,
                move_path,
                chunks,
            } => {
                let source = path.clone();
                let old = load(root, &source, &mut state)?
                    .ok_or_else(|| format!("missing file for update: {}", source.display()))?;
                let contents = update_contents(&source, &old, chunks)?;
                let destination = match move_path {
                    Some(path) => path.clone(),
                    None => source.clone(),
                };
                let is_move = destination != source;
                if is_move {
                    state.insert(source.clone(), None);
                }
                state.insert(destination.clone(), Some(contents.clone()));
                changes.push(PlannedChange {
                    path: destination,
                    from_path: is_move.then_some(source),
                    kind: if is_move {
                        ChangeKind::Move
                    } else {
                        ChangeKind::Update
                    },
                    contents: Some(contents),
                });
            }
        }
    }
    Ok(Plan { changes })
}

pub fn commit(root: &Path, plan: &Plan) -> CommitReport {
    commit_with(root, plan, &RealFileOps)
}

fn commit_with(root: &Path, plan: &Plan, file_ops: &dyn FileOps) -> CommitReport {
    let mut operations = Vec::with_capacity(plan.changes.len());
    for (index, change) in plan.changes.iter().enumerate() {
        match apply_change(root, change, file_ops) {
            Ok(()) => operations.push(CommitOperation {
                change: change.clone(),
                state: OperationState::Applied,
            }),
            Err((state, error)) => {
                operations.push(CommitOperation {
                    change: change.clone(),
                    state,
                });
                operations.extend(plan.changes[index + 1..].iter().cloned().map(|change| {
                    CommitOperation {
                        change,
                        state: OperationState::NotApplied,
                    }
                }));
                let partial = operations.iter().any(|operation| {
                    matches!(
                        operation.state,
                        OperationState::Applied | OperationState::Unknown
                    )
                });
                return CommitReport {
                    operations,
                    partial,
                    error: Some(error),
                };
            }
        }
    }
    CommitReport {
        operations,
        partial: false,
        error: None,
    }
}

fn apply_change(
    root: &Path,
    change: &PlannedChange,
    file_ops: &dyn FileOps,
) -> Result<(), (OperationState, String)> {
    let destination = root.join(&change.path);
    if let Some(source) = &change.from_path {
        let source = root.join(source);
        let before = destination_before(file_ops, &destination).map_err(|error| {
            (
                OperationState::NotApplied,
                format!(
                    "cannot capture move destination {}: {error}",
                    change.path.display()
                ),
            )
        })?;
        let contents = change.contents.as_deref().expect("move has contents");
        file_ops
            .write_atomically(&destination, contents.as_bytes())
            .map_err(|error| {
                (
                    OperationState::NotApplied,
                    format!("{}: {error}", change.path.display()),
                )
            })?;
        if let Err(remove_error) = file_ops.remove_file(&source) {
            let restoration = restore_destination(file_ops, &destination, &before);
            let (state, restoration_detail) = match restoration {
                Ok(()) => (
                    OperationState::NotApplied,
                    "destination restored".to_owned(),
                ),
                Err(error) => (
                    OperationState::Unknown,
                    format!("destination restoration failed: {error}"),
                ),
            };
            return Err((
                state,
                format!(
                    "cannot remove move source {} after installing {}: {remove_error}; {restoration_detail}",
                    source.display(),
                    change.path.display()
                ),
            ));
        }
        return Ok(());
    }
    match &change.contents {
        Some(contents) => file_ops
            .write_atomically(&destination, contents.as_bytes())
            .map_err(|error| {
                (
                    OperationState::NotApplied,
                    format!("{}: {error}", change.path.display()),
                )
            }),
        None => file_ops.remove_file(&destination).map_err(|error| {
            (
                OperationState::NotApplied,
                format!("{}: {error}", change.path.display()),
            )
        }),
    }
}

enum DestinationBefore {
    Missing,
    Existing(Vec<u8>),
}

fn destination_before(file_ops: &dyn FileOps, destination: &Path) -> io::Result<DestinationBefore> {
    match file_ops.read(destination) {
        Ok(bytes) => Ok(DestinationBefore::Existing(bytes)),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(DestinationBefore::Missing),
        Err(error) => Err(error),
    }
}

fn restore_destination(
    file_ops: &dyn FileOps,
    destination: &Path,
    before: &DestinationBefore,
) -> io::Result<()> {
    match before {
        DestinationBefore::Existing(bytes) => file_ops.write_atomically(destination, bytes),
        DestinationBefore::Missing => match file_ops.remove_file(destination) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(error),
        },
    }
}

trait FileOps {
    fn read(&self, path: &Path) -> io::Result<Vec<u8>>;
    fn write_atomically(&self, path: &Path, contents: &[u8]) -> io::Result<()>;
    fn remove_file(&self, path: &Path) -> io::Result<()>;
}

struct RealFileOps;

impl FileOps for RealFileOps {
    fn read(&self, path: &Path) -> io::Result<Vec<u8>> {
        fs::read(path)
    }

    fn write_atomically(&self, path: &Path, contents: &[u8]) -> io::Result<()> {
        write_atomically(path, contents)
    }

    fn remove_file(&self, path: &Path) -> io::Result<()> {
        fs::remove_file(path)
    }
}

fn write_atomically(path: &Path, contents: &[u8]) -> io::Result<()> {
    // Match upstream `write_file`: a final symlink is followed. Authority for
    // that target is deliberately left to the caller's filesystem sandbox.
    let resolved = match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() => fs::canonicalize(path)?,
        Ok(_) | Err(_) => path.to_path_buf(),
    };
    write_atomically_at(&resolved, contents)
}

fn write_atomically_at(path: &Path, contents: &[u8]) -> io::Result<()> {
    let parent = path.parent().ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "target has no parent directory",
        )
    })?;
    fs::create_dir_all(parent)?;
    let existing_permissions = match fs::metadata(path) {
        Ok(metadata) => Some(metadata.permissions()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => None,
        Err(error) => return Err(error),
    };
    let name = path
        .file_name()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "target has no file name"))?;
    for attempt in 0..128 {
        let temporary = parent.join(format!(
            ".{}.nautilo-apply-patch-{}-{attempt}.tmp",
            name.to_string_lossy(),
            std::process::id()
        ));
        let file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary);
        let mut file = match file {
            Ok(file) => file,
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error),
        };
        if let Some(permissions) = &existing_permissions
            && let Err(error) = file.set_permissions(permissions.clone())
        {
            drop(file);
            let _ = fs::remove_file(&temporary);
            return Err(error);
        }
        if let Err(error) = file.write_all(contents).and_then(|()| file.sync_all()) {
            drop(file);
            let _ = fs::remove_file(&temporary);
            return Err(error);
        }
        drop(file);
        match fs::rename(&temporary, path) {
            Ok(()) => return Ok(()),
            Err(error) => {
                let _ = fs::remove_file(&temporary);
                return Err(error);
            }
        }
    }
    Err(io::Error::new(
        io::ErrorKind::AlreadyExists,
        "could not reserve apply-patch temporary file",
    ))
}

fn load(
    root: &Path,
    relative: &Path,
    state: &mut BTreeMap<PathBuf, Option<String>>,
) -> Result<Option<String>, String> {
    if let Some(value) = state.get(relative) {
        return Ok(value.clone());
    }
    let absolute = root.join(relative);
    match fs::metadata(&absolute) {
        Ok(_) => {}
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            state.insert(relative.to_path_buf(), None);
            return Ok(None);
        }
        Err(error) => return Err(format!("cannot inspect {}: {error}", relative.display())),
    }
    let content = fs::read_to_string(&absolute).map_err(|error| {
        format!(
            "unsupported_encoding_or_type {}: {error}",
            relative.display()
        )
    })?;
    state.insert(relative.to_path_buf(), Some(content.clone()));
    Ok(Some(content))
}

fn update_contents(path: &Path, old: &str, chunks: &[UpdateChunk]) -> Result<String, String> {
    let mut lines: Vec<String> = old.split('\n').map(str::to_owned).collect();
    if lines.last().is_some_and(String::is_empty) {
        lines.pop();
    }
    let mut replacements = Vec::<(usize, usize, Vec<String>)>::new();
    let mut line_index = 0;
    for chunk in chunks {
        if let Some(context) = &chunk.change_context {
            let Some(found) =
                seek_sequence(&lines, std::slice::from_ref(context), line_index, false)
            else {
                return Err(format!("missing context '{context}' in {}", path.display()));
            };
            line_index = found + 1;
        }
        if chunk.old_lines.is_empty() {
            let insertion_index = if lines.last().is_some_and(String::is_empty) {
                lines.len() - 1
            } else {
                lines.len()
            };
            replacements.push((insertion_index, 0, chunk.new_lines.clone()));
            continue;
        }
        let mut old_lines: &[String] = &chunk.old_lines;
        let mut new_lines: &[String] = &chunk.new_lines;
        let mut found = seek_sequence(&lines, old_lines, line_index, chunk.is_end_of_file);
        if found.is_none() && old_lines.last().is_some_and(String::is_empty) {
            old_lines = &old_lines[..old_lines.len() - 1];
            if new_lines.last().is_some_and(String::is_empty) {
                new_lines = &new_lines[..new_lines.len() - 1];
            }
            found = seek_sequence(&lines, old_lines, line_index, chunk.is_end_of_file);
        }
        let Some(start) = found else {
            return Err(format!("missing expected lines in {}", path.display()));
        };
        replacements.push((start, old_lines.len(), new_lines.to_vec()));
        line_index = start + old_lines.len();
    }
    replacements.sort_by_key(|(start, _, _)| *start);
    for (start, old_len, new_lines) in replacements.into_iter().rev() {
        lines.splice(start..start + old_len, new_lines);
    }
    if !lines.last().is_some_and(String::is_empty) {
        lines.push(String::new());
    }
    Ok(lines.join("\n"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::parser::parse_patch;
    use std::cell::Cell;
    #[cfg(unix)]
    use std::os::unix::fs::PermissionsExt;

    #[test]
    fn move_is_one_planned_operation_and_overwrites_destination() {
        let root = temp_root("move-overwrite");
        fs::write(root.join("from.txt"), "before\n").unwrap();
        fs::write(root.join("to.txt"), "old destination\n").unwrap();
        #[cfg(unix)]
        fs::set_permissions(root.join("to.txt"), fs::Permissions::from_mode(0o751)).unwrap();
        let plan = planned(
            &root,
            "*** Begin Patch\n*** Update File: from.txt\n*** Move to: to.txt\n@@\n-before\n+after\n*** End Patch",
        );
        assert_eq!(plan.changes.len(), 1);
        assert_eq!(plan.changes[0].kind, ChangeKind::Move);
        assert_eq!(plan.changes[0].from_path, Some(PathBuf::from("from.txt")));
        let report = commit(&root, &plan);
        assert!(report.error.is_none());
        assert_eq!(report.operations[0].state, OperationState::Applied);
        assert!(!root.join("from.txt").exists());
        assert_eq!(fs::read_to_string(root.join("to.txt")).unwrap(), "after\n");
        #[cfg(unix)]
        assert_eq!(
            fs::metadata(root.join("to.txt"))
                .unwrap()
                .permissions()
                .mode()
                & 0o7777,
            0o751
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn update_preserves_existing_executable_permissions() {
        let root = temp_root("update-preserves-mode");
        let target = root.join("script.sh");
        fs::write(&target, "before\n").unwrap();
        fs::set_permissions(&target, fs::Permissions::from_mode(0o751)).unwrap();
        let plan = planned(
            &root,
            "*** Begin Patch\n*** Update File: script.sh\n@@\n-before\n+after\n*** End Patch",
        );
        let report = commit(&root, &plan);
        assert!(report.error.is_none());
        assert_eq!(fs::read_to_string(&target).unwrap(), "after\n");
        assert_eq!(
            fs::metadata(&target).unwrap().permissions().mode() & 0o7777,
            0o751
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn destination_write_failure_preserves_move_source_with_zero_prefix() {
        let root = temp_root("move-destination-failure");
        fs::write(root.join("from.txt"), "before\n").unwrap();
        fs::write(root.join("to.txt"), "old destination\n").unwrap();
        let plan = planned(
            &root,
            "*** Begin Patch\n*** Update File: from.txt\n*** Move to: to.txt\n@@\n-before\n+after\n*** End Patch",
        );
        let report = commit_with(&root, &plan, &FailWrites);
        assert!(report.error.is_some());
        assert!(!report.partial);
        assert_eq!(report.operations[0].state, OperationState::NotApplied);
        assert_eq!(
            fs::read_to_string(root.join("from.txt")).unwrap(),
            "before\n"
        );
        assert_eq!(
            fs::read_to_string(root.join("to.txt")).unwrap(),
            "old destination\n"
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn failed_atomic_write_preserves_target_and_reports_zero_prefix() {
        let root = temp_root("atomic-write-failure");
        let target = root.join("target.txt");
        fs::write(&target, "before\n").unwrap();
        let plan = Plan {
            changes: vec![PlannedChange {
                path: PathBuf::from("target.txt"),
                from_path: None,
                kind: ChangeKind::Update,
                contents: Some("after\n".into()),
            }],
        };
        let report = commit_with(&root, &plan, &FailWrites);
        assert!(report.error.is_some());
        assert!(!report.partial);
        assert_eq!(report.operations[0].state, OperationState::NotApplied);
        assert_eq!(fs::read_to_string(target).unwrap(), "before\n");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn failed_move_source_removal_restores_destination() {
        let root = temp_root("move-source-failure");
        fs::write(root.join("from.txt"), "before\n").unwrap();
        fs::write(root.join("to.txt"), "old destination\n").unwrap();
        let plan = planned(
            &root,
            "*** Begin Patch\n*** Update File: from.txt\n*** Move to: to.txt\n@@\n-before\n+after\n*** End Patch",
        );
        let report = commit_with(&root, &plan, &FailRemoves);
        assert!(report.error.is_some());
        assert!(!report.partial);
        assert_eq!(report.operations[0].state, OperationState::NotApplied);
        assert_eq!(
            fs::read_to_string(root.join("from.txt")).unwrap(),
            "before\n"
        );
        assert_eq!(
            fs::read_to_string(root.join("to.txt")).unwrap(),
            "old destination\n"
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn failed_move_restoration_reports_unknown_without_claiming_application() {
        let root = temp_root("move-restoration-failure");
        fs::write(root.join("from.txt"), "before\n").unwrap();
        fs::write(root.join("to.txt"), "old destination\n").unwrap();
        let plan = planned(
            &root,
            "*** Begin Patch\n*** Update File: from.txt\n*** Move to: to.txt\n@@\n-before\n+after\n*** End Patch",
        );
        let report = commit_with(&root, &plan, &FailRemoveAndRestore::default());
        assert!(report.error.is_some());
        assert!(report.partial);
        assert_eq!(report.operations[0].state, OperationState::Unknown);
        assert_eq!(
            fs::read_to_string(root.join("from.txt")).unwrap(),
            "before\n"
        );
        assert_eq!(fs::read_to_string(root.join("to.txt")).unwrap(), "after\n");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn pure_addition_keeps_one_retained_trailing_empty_line_before_inserting() {
        let root = temp_root("pure-add-trailing-newlines");
        fs::write(root.join("target.txt"), "first\n\n").unwrap();
        let plan = planned(
            &root,
            "*** Begin Patch\n*** Update File: target.txt\n@@\n+added\n*** End Patch",
        );
        let report = commit(&root, &plan);
        assert!(report.error.is_none());
        assert_eq!(
            fs::read_to_string(root.join("target.txt")).unwrap(),
            "first\nadded\n"
        );
        fs::remove_dir_all(root).unwrap();
    }

    struct FailWrites;

    impl FileOps for FailWrites {
        fn read(&self, path: &Path) -> io::Result<Vec<u8>> {
            fs::read(path)
        }

        fn write_atomically(&self, _path: &Path, _contents: &[u8]) -> io::Result<()> {
            Err(io::Error::other("forced atomic write failure"))
        }

        fn remove_file(&self, path: &Path) -> io::Result<()> {
            fs::remove_file(path)
        }
    }

    struct FailRemoves;

    impl FileOps for FailRemoves {
        fn read(&self, path: &Path) -> io::Result<Vec<u8>> {
            fs::read(path)
        }

        fn write_atomically(&self, path: &Path, contents: &[u8]) -> io::Result<()> {
            write_atomically(path, contents)
        }

        fn remove_file(&self, _path: &Path) -> io::Result<()> {
            Err(io::Error::other("forced source removal failure"))
        }
    }

    #[derive(Default)]
    struct FailRemoveAndRestore {
        writes: Cell<u8>,
    }

    impl FileOps for FailRemoveAndRestore {
        fn read(&self, path: &Path) -> io::Result<Vec<u8>> {
            fs::read(path)
        }

        fn write_atomically(&self, path: &Path, contents: &[u8]) -> io::Result<()> {
            if self.writes.replace(1) == 0 {
                write_atomically(path, contents)
            } else {
                Err(io::Error::other("forced destination restoration failure"))
            }
        }

        fn remove_file(&self, _path: &Path) -> io::Result<()> {
            Err(io::Error::other("forced source removal failure"))
        }
    }

    fn planned(root: &Path, patch: &str) -> Plan {
        plan(root, &parse_patch(patch).unwrap()).unwrap()
    }

    fn temp_root(label: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "nautilo-apply-patch-engine-{label}-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        root
    }
}
