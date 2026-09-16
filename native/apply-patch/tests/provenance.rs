//! The negative cases run the actual build guard against disposable crate copies.

use nautilo_apply_patch::protocol::version_json;
use nautilo_apply_patch::{
    NAUTILO_EXTRACTION_REVISION, PROTOCOL_VERSION, PROVENANCE_FORMAT, RUNTIME_VERSION,
    UPSTREAM_LICENSE_SHA256, UPSTREAM_NOTICE_SHA256, UPSTREAM_REVISION,
};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

#[test]
fn version_handshake_reports_the_build_validated_provenance() {
    let version = version_json();

    assert_eq!(version["protocol"], PROTOCOL_VERSION);
    assert_eq!(version["runtime_version"], RUNTIME_VERSION);
    assert_eq!(version["upstream_revision"], UPSTREAM_REVISION);
    assert_eq!(
        version["nautilo_extraction_revision"],
        NAUTILO_EXTRACTION_REVISION
    );
    assert_eq!(NAUTILO_EXTRACTION_REVISION.len(), 64);
    assert!(
        NAUTILO_EXTRACTION_REVISION
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    );
    assert_eq!(version["provenance"]["format"], PROVENANCE_FORMAT);
    assert_eq!(
        version["provenance"]["upstream_revision"],
        UPSTREAM_REVISION
    );
    assert_eq!(
        version["provenance"]["license_sha256"],
        UPSTREAM_LICENSE_SHA256
    );
    assert_eq!(
        version["provenance"]["notice_sha256"],
        UPSTREAM_NOTICE_SHA256
    );
}

#[test]
fn build_guard_rejects_tampered_copies_without_touching_repository_files() {
    let fixture = CrateFixture::new("build-guard");
    fixture.check().expect("reviewed copied crate must build");

    let upstream = fixture.path.join("UPSTREAM.toml");
    let original_upstream = fs::read_to_string(&upstream).unwrap();
    fs::write(
        &upstream,
        original_upstream.replacen(
            UPSTREAM_REVISION,
            "0000000000000000000000000000000000000000",
            1,
        ),
    )
    .unwrap();
    assert_guard_failure(
        fixture.check().unwrap_err(),
        "provenance guard: unreviewed upstream revision: expected 3389fa554e953d07a12a34f5681aae46f17958f8, found 0000000000000000000000000000000000000000",
    );

    fs::write(&upstream, original_upstream).unwrap();
    fs::remove_file(fixture.path.join("NOTICE")).unwrap();
    assert_guard_failure(
        fixture.check().unwrap_err(),
        "provenance guard: required NOTICE missing:",
    );

    fs::write(fixture.path.join("NOTICE"), "tampered attribution\n").unwrap();
    assert_guard_failure(
        fixture.check().unwrap_err(),
        "provenance guard: NOTICE hash mismatch: expected 9d71575ecfd9a843fc1677b0efb08053c6ba9fd686a0de1a6f5382fd3c220915, found ",
    );
}

fn assert_guard_failure(output: String, expected: &str) {
    assert!(
        output.contains(expected),
        "expected build guard output to contain {expected:?}, got:\n{output}"
    );
}

struct CrateFixture {
    path: PathBuf,
}

impl CrateFixture {
    fn new(label: &str) -> Self {
        let source = Path::new(env!("CARGO_MANIFEST_DIR"));
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock after Unix epoch")
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "nautilo-apply-patch-provenance-{label}-{}-{nonce}",
            std::process::id()
        ));
        fs::create_dir_all(path.join("src")).unwrap();
        for name in [
            "Cargo.toml",
            "Cargo.lock",
            "rust-toolchain.toml",
            "build.rs",
            "UPSTREAM.toml",
            "LICENSE",
            "NOTICE",
        ] {
            fs::copy(source.join(name), path.join(name)).unwrap();
        }
        copy_dir(&source.join("src"), &path.join("src"));
        Self { path }
    }

    fn check(&self) -> Result<(), String> {
        let output = Command::new(env!("CARGO"))
            .args(["check", "--locked", "--offline"])
            .current_dir(&self.path)
            .env("CARGO_TARGET_DIR", self.path.join("target"))
            .output()
            .expect("run copied crate cargo check");
        if output.status.success() {
            return Ok(());
        }
        Err(format!(
            "{}{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        ))
    }
}

impl Drop for CrateFixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.path);
    }
}

fn copy_dir(source: &Path, destination: &Path) {
    for entry in fs::read_dir(source).unwrap() {
        let entry = entry.unwrap();
        let destination_path = destination.join(entry.file_name());
        if entry.file_type().unwrap().is_dir() {
            fs::create_dir_all(&destination_path).unwrap();
            copy_dir(&entry.path(), &destination_path);
        } else {
            fs::copy(entry.path(), destination_path).unwrap();
        }
    }
}
