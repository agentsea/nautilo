//! Modified extraction of Codex `parser.rs` (Apache-2.0).
//!
//! Nautilo keeps Codex's line-oriented patch grammar while replacing Codex
//! absolute-path and executor argument types with relative protocol paths.

use std::path::PathBuf;

const BEGIN: &str = "*** Begin Patch";
const END: &str = "*** End Patch";
const ADD: &str = "*** Add File: ";
const DELETE: &str = "*** Delete File: ";
const UPDATE: &str = "*** Update File: ";
const MOVE: &str = "*** Move to: ";
const EOF: &str = "*** End of File";

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Hunk {
    Add {
        path: PathBuf,
        contents: String,
    },
    Delete {
        path: PathBuf,
    },
    Update {
        path: PathBuf,
        move_path: Option<PathBuf>,
        chunks: Vec<UpdateChunk>,
    },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct UpdateChunk {
    pub change_context: Option<String>,
    pub old_lines: Vec<String>,
    pub new_lines: Vec<String>,
    pub is_end_of_file: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ParsedPatch {
    pub hunks: Vec<Hunk>,
}

pub fn parse_patch(patch: &str) -> Result<ParsedPatch, String> {
    let lines: Vec<&str> = patch.trim().lines().collect();
    if lines.len() < 2 || lines.first().is_none_or(|line| line.trim() != BEGIN) {
        return Err("The first line of the patch must be '*** Begin Patch'".into());
    }
    if lines.last().is_none_or(|line| line.trim() != END) {
        return Err("The last line of the patch must be '*** End Patch'".into());
    }
    let mut index = 1;
    if lines
        .get(index)
        .is_some_and(|line| line.trim_start().starts_with("*** Environment ID: "))
    {
        let value = lines[index].trim_start()["*** Environment ID: ".len()..].trim();
        if value.is_empty() {
            return Err("apply_patch environment_id cannot be empty".into());
        }
        index += 1;
    }
    let mut hunks = Vec::new();
    while index < lines.len() - 1 {
        let header = lines[index].trim();
        if let Some(path) = header.strip_prefix(ADD) {
            index += 1;
            let mut contents = String::new();
            while index < lines.len() - 1 {
                let line = lines[index];
                let Some(content) = line.strip_prefix('+') else {
                    break;
                };
                contents.push_str(content);
                contents.push('\n');
                index += 1;
            }
            hunks.push(Hunk::Add {
                path: PathBuf::from(path),
                contents,
            });
        } else if let Some(path) = header.strip_prefix(DELETE) {
            hunks.push(Hunk::Delete {
                path: PathBuf::from(path),
            });
            index += 1;
        } else if let Some(path) = header.strip_prefix(UPDATE) {
            index += 1;
            let move_path = lines.get(index).and_then(|line| line.strip_prefix(MOVE));
            if move_path.is_some() {
                index += 1;
            }
            let mut chunks = Vec::new();
            while index < lines.len() - 1 && !lines[index].trim_start().starts_with("*** ") {
                if lines[index].trim().is_empty() {
                    index += 1;
                    continue;
                }
                let (chunk, consumed) =
                    parse_chunk(&lines[index..lines.len() - 1], chunks.is_empty())?;
                chunks.push(chunk);
                index += consumed;
            }
            if chunks.is_empty() {
                return Err(format!("Update file hunk for path '{path}' is empty"));
            }
            hunks.push(Hunk::Update {
                path: PathBuf::from(path),
                move_path: move_path.map(PathBuf::from),
                chunks,
            });
        } else {
            return Err(format!("'{header}' is not a valid hunk header"));
        }
    }
    if hunks.is_empty() {
        return Err("patch contains no hunks".into());
    }
    Ok(ParsedPatch { hunks })
}

fn parse_chunk(
    lines: &[&str],
    allow_missing_context: bool,
) -> Result<(UpdateChunk, usize), String> {
    let mut index = 0;
    let change_context = if lines.first() == Some(&"@@") {
        index = 1;
        None
    } else if let Some(value) = lines.first().and_then(|line| line.strip_prefix("@@ ")) {
        index = 1;
        Some(value.to_owned())
    } else if allow_missing_context {
        None
    } else {
        return Err(format!(
            "Expected update hunk to start with a @@ context marker, got: '{}'",
            lines.first().unwrap_or(&"")
        ));
    };
    let mut old_lines = Vec::new();
    let mut new_lines = Vec::new();
    let mut eof = false;
    let mut changes = 0;
    while index < lines.len() {
        let line = lines[index];
        if line == EOF {
            eof = true;
            index += 1;
            break;
        }
        match line.chars().next() {
            Some(' ') => {
                old_lines.push(line[1..].into());
                new_lines.push(line[1..].into());
            }
            Some('+') => new_lines.push(line[1..].into()),
            Some('-') => old_lines.push(line[1..].into()),
            None => {
                old_lines.push(String::new());
                new_lines.push(String::new());
            }
            _ if changes > 0 => break,
            _ => return Err(format!("Unexpected line found in update hunk: '{line}'")),
        }
        changes += 1;
        index += 1;
    }
    if changes == 0 {
        return Err("Update hunk does not contain any lines".into());
    }
    Ok((
        UpdateChunk {
            change_context,
            old_lines,
            new_lines,
            is_end_of_file: eof,
        },
        index,
    ))
}
