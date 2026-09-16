use std::env;
use std::fs;
use std::path::Path;

const REVIEWED_UPSTREAM_REVISION: &str = "3389fa554e953d07a12a34f5681aae46f17958f8";
const REVIEWED_LICENSE_SHA256: &str =
    "d17f227e4df5da1600391338865ce0f3055211760a36688f816941d58232d8dc";
const REVIEWED_NOTICE_SHA256: &str =
    "9d71575ecfd9a843fc1677b0efb08053c6ba9fd686a0de1a6f5382fd3c220915";
const PROVENANCE_FORMAT: &str = "nautilo.apply_patch.provenance/v1";
const EXTRACTION_REVISION_FORMAT: &str = "nautilo.apply_patch.extraction-revision/v1";
const EXTRACTION_ROOT_INPUTS: [&str; 7] = [
    "build.rs",
    "Cargo.toml",
    "Cargo.lock",
    "rust-toolchain.toml",
    "UPSTREAM.toml",
    "LICENSE",
    "NOTICE",
];

fn main() {
    let manifest_dir = env::var("CARGO_MANIFEST_DIR").expect("Cargo manifest directory");
    let manifest_dir = Path::new(&manifest_dir);
    let extraction_inputs =
        extraction_input_paths(manifest_dir).unwrap_or_else(|error| panic!("{error}"));
    for input in &extraction_inputs {
        println!("cargo:rerun-if-changed={input}");
    }
    let values = validate_provenance(manifest_dir).unwrap_or_else(|error| panic!("{error}"));
    let extraction_revision = extraction_revision(manifest_dir, &extraction_inputs)
        .unwrap_or_else(|error| panic!("{error}"));

    emit("NAUTILO_APPLY_PATCH_PROVENANCE_FORMAT", PROVENANCE_FORMAT);
    emit("NAUTILO_APPLY_PATCH_UPSTREAM_REVISION", &values.revision);
    emit("NAUTILO_APPLY_PATCH_LICENSE_SHA256", &values.license_sha256);
    emit("NAUTILO_APPLY_PATCH_NOTICE_SHA256", &values.notice_sha256);
    emit(
        "NAUTILO_APPLY_PATCH_EXTRACTION_REVISION",
        &extraction_revision,
    );
}

fn emit(name: &str, value: &str) {
    println!("cargo:rustc-env={name}={value}");
}

struct ProvenanceValues {
    revision: String,
    license_sha256: String,
    notice_sha256: String,
}

/// The v1 digest is SHA-256 of UTF-8 `format + NUL`, followed by sorted input
/// records: u64-BE(path byte length), path bytes, u64-BE(content byte length),
/// and exact content bytes. This framing is deliberately mirrored by the
/// TypeScript vendoring gate.
fn extraction_revision(manifest_dir: &Path, inputs: &[String]) -> Result<String, String> {
    let mut framed = Vec::from(format!("{EXTRACTION_REVISION_FORMAT}\0").as_bytes());
    for input in inputs {
        let bytes = fs::read(manifest_dir.join(input)).map_err(|error| {
            format!("extraction revision: required input {input} missing or unreadable: {error}")
        })?;
        append_frame(&mut framed, input.as_bytes());
        append_frame(&mut framed, &bytes);
    }
    Ok(sha256_hex(&framed))
}

fn append_frame(output: &mut Vec<u8>, bytes: &[u8]) {
    output.extend_from_slice(&(bytes.len() as u64).to_be_bytes());
    output.extend_from_slice(bytes);
}

fn extraction_input_paths(manifest_dir: &Path) -> Result<Vec<String>, String> {
    let mut inputs = EXTRACTION_ROOT_INPUTS
        .iter()
        .map(|input| (*input).to_owned())
        .collect::<Vec<_>>();
    let source_dir = manifest_dir.join("src");
    let entries = fs::read_dir(&source_dir).map_err(|error| {
        format!("extraction revision: required source directory src missing or unreadable: {error}")
    })?;
    for entry in entries {
        let entry =
            entry.map_err(|error| format!("extraction revision: cannot enumerate src: {error}"))?;
        let file_type = entry
            .file_type()
            .map_err(|error| format!("extraction revision: cannot inspect src entry: {error}"))?;
        let name = entry
            .file_name()
            .into_string()
            .map_err(|_| "extraction revision: src entry name is not UTF-8".to_owned())?;
        if file_type.is_file() && name.ends_with(".rs") {
            inputs.push(format!("src/{name}"));
        }
    }
    inputs.sort_by(|left, right| left.as_bytes().cmp(right.as_bytes()));
    Ok(inputs)
}

fn validate_provenance(manifest_dir: &Path) -> Result<ProvenanceValues, String> {
    let manifest = fs::read_to_string(manifest_dir.join("UPSTREAM.toml"))
        .map_err(|error| format!("provenance guard: required UPSTREAM.toml missing: {error}"))?;
    let format_version = toml_value(&manifest, "", "format_version")?;
    if format_version != "1" {
        return Err(format!(
            "provenance guard: unsupported UPSTREAM.toml format_version: expected 1, found {format_version}"
        ));
    }
    let revision = toml_value(&manifest, "upstream", "revision")?;
    if revision != REVIEWED_UPSTREAM_REVISION {
        return Err(format!(
            "provenance guard: unreviewed upstream revision: expected {REVIEWED_UPSTREAM_REVISION}, found {revision}"
        ));
    }
    let license_sha256 = toml_value(&manifest, "hashes", "license_sha256")?;
    if license_sha256 != REVIEWED_LICENSE_SHA256 {
        return Err(format!(
            "provenance guard: unreviewed LICENSE hash in UPSTREAM.toml: expected {REVIEWED_LICENSE_SHA256}, found {license_sha256}"
        ));
    }
    let notice_sha256 = toml_value(&manifest, "hashes", "notice_sha256")?;
    if notice_sha256 != REVIEWED_NOTICE_SHA256 {
        return Err(format!(
            "provenance guard: unreviewed NOTICE hash in UPSTREAM.toml: expected {REVIEWED_NOTICE_SHA256}, found {notice_sha256}"
        ));
    }
    let handshake = toml_value(&manifest, "nautilo_extraction", "provenance_handshake")?;
    if handshake != PROVENANCE_FORMAT {
        return Err(format!(
            "provenance guard: unreviewed provenance handshake: expected {PROVENANCE_FORMAT}, found {handshake}"
        ));
    }

    verify_file_hash(manifest_dir, "LICENSE", REVIEWED_LICENSE_SHA256)?;
    verify_file_hash(manifest_dir, "NOTICE", REVIEWED_NOTICE_SHA256)?;

    Ok(ProvenanceValues {
        revision,
        license_sha256,
        notice_sha256,
    })
}

fn toml_value(contents: &str, section: &str, key: &str) -> Result<String, String> {
    let mut current_section = "";
    for line in contents.lines() {
        let line = line.trim();
        if line.starts_with('[') && line.ends_with(']') {
            current_section = &line[1..line.len() - 1];
            continue;
        }
        if current_section != section {
            continue;
        }
        let Some((found_key, value)) = line.split_once('=') else {
            continue;
        };
        if found_key.trim() != key {
            continue;
        }
        let value = value.trim();
        return Ok(value
            .strip_prefix('"')
            .and_then(|value| value.strip_suffix('"'))
            .unwrap_or(value)
            .to_owned());
    }
    let location = if section.is_empty() {
        key.to_owned()
    } else {
        format!("[{section}].{key}")
    };
    Err(format!(
        "provenance guard: UPSTREAM.toml {location} is missing"
    ))
}

fn verify_file_hash(manifest_dir: &Path, name: &str, expected: &str) -> Result<(), String> {
    let bytes = fs::read(manifest_dir.join(name))
        .map_err(|error| format!("provenance guard: required {name} missing: {error}"))?;
    let actual = sha256_hex(&bytes);
    if actual != expected {
        return Err(format!(
            "provenance guard: {name} hash mismatch: expected {expected}, found {actual}"
        ));
    }
    Ok(())
}

fn sha256_hex(input: &[u8]) -> String {
    let mut state = [
        0x6a09e667u32,
        0xbb67ae85,
        0x3c6ef372,
        0xa54ff53a,
        0x510e527f,
        0x9b05688c,
        0x1f83d9ab,
        0x5be0cd19,
    ];
    let bit_len = (input.len() as u64).wrapping_mul(8);
    let mut bytes = input.to_vec();
    bytes.push(0x80);
    while !(bytes.len() + 8).is_multiple_of(64) {
        bytes.push(0);
    }
    bytes.extend_from_slice(&bit_len.to_be_bytes());
    for chunk in bytes.chunks_exact(64) {
        let mut words = [0u32; 64];
        for (index, word) in words[..16].iter_mut().enumerate() {
            *word = u32::from_be_bytes(chunk[index * 4..index * 4 + 4].try_into().unwrap());
        }
        for index in 16..64 {
            let s0 = words[index - 15].rotate_right(7)
                ^ words[index - 15].rotate_right(18)
                ^ (words[index - 15] >> 3);
            let s1 = words[index - 2].rotate_right(17)
                ^ words[index - 2].rotate_right(19)
                ^ (words[index - 2] >> 10);
            words[index] = words[index - 16]
                .wrapping_add(s0)
                .wrapping_add(words[index - 7])
                .wrapping_add(s1);
        }
        let mut work = state;
        for (index, constant) in SHA256_CONSTANTS.iter().enumerate() {
            let s1 = work[4].rotate_right(6) ^ work[4].rotate_right(11) ^ work[4].rotate_right(25);
            let choice = (work[4] & work[5]) ^ ((!work[4]) & work[6]);
            let temp1 = work[7]
                .wrapping_add(s1)
                .wrapping_add(choice)
                .wrapping_add(*constant)
                .wrapping_add(words[index]);
            let s0 = work[0].rotate_right(2) ^ work[0].rotate_right(13) ^ work[0].rotate_right(22);
            let majority = (work[0] & work[1]) ^ (work[0] & work[2]) ^ (work[1] & work[2]);
            let temp2 = s0.wrapping_add(majority);
            work = [
                temp1.wrapping_add(temp2),
                work[0],
                work[1],
                work[2],
                work[3].wrapping_add(temp1),
                work[4],
                work[5],
                work[6],
            ];
        }
        for (slot, value) in state.iter_mut().zip(work) {
            *slot = slot.wrapping_add(value);
        }
    }
    state.iter().map(|word| format!("{word:08x}")).collect()
}

const SHA256_CONSTANTS: [u32; 64] = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];
