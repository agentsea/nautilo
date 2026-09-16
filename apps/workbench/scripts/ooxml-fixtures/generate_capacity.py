#!/usr/bin/env python3
"""Generate bounded, local-only OOXML transport qualification packages.

The generator starts with a tracked small fixture and adds unreferenced,
OPC-valid stored payload parts, each within the reader's per-entry budget. It is
deliberately a capacity/transport tool: creating a 300 MiB source does not mean
that a reader is expected to accept it.
"""

from __future__ import annotations

import argparse
import hashlib
import os
import shutil
import sys
import tempfile
import zipfile
from pathlib import Path
from xml.etree import ElementTree


MIB = 1024 * 1024
MIN_TARGET_BYTES = MIB
MAX_TARGET_BYTES = 512 * MIB
CHUNK_BYTES = MIB
FIXTURE_ROOT = Path(__file__).resolve().parents[2] / "tests" / "fixtures" / "ooxml"
DEFAULT_OUTPUT_DIR = FIXTURE_ROOT / "capacity"
TEMPLATES = {
    "docx": (FIXTURE_ROOT / "docx" / "simple.docx", "word/document.xml"),
    "xlsx": (FIXTURE_ROOT / "xlsx" / "simple.xlsx", "xl/workbook.xml"),
    "pptx": (FIXTURE_ROOT / "pptx" / "simple.pptx", "ppt/presentation.xml"),
}
CONTENT_TYPES_NS = "http://schemas.openxmlformats.org/package/2006/content-types"
PAYLOAD_PREFIX = "capacity/payload-"
PAYLOAD_TYPE = "application/octet-stream"
MAX_PAYLOAD_PART_BYTES = 64 * MIB
FIXED_TIMESTAMP = (2026, 7, 27, 0, 0, 0)


def within(path: Path, root: Path) -> bool:
    try:
        path.relative_to(root)
        return True
    except ValueError:
        return False


def safe_output_dir(value: str) -> Path:
    output = Path(value).expanduser().resolve()
    temporary_roots = {Path(tempfile.gettempdir()).resolve(), Path("/tmp").resolve()}
    if not (within(output, DEFAULT_OUTPUT_DIR.resolve()) or any(within(output, root) for root in temporary_roots)):
        raise ValueError("output directory must be under the local capacity directory or the system temporary directory")
    if output == DEFAULT_OUTPUT_DIR.resolve() or within(output, DEFAULT_OUTPUT_DIR.resolve()):
        return output
    # A temporary output must not be the temporary root itself, which prevents
    # broad writes such as /tmp/capacity-docx-100mib.docx.
    if output in temporary_roots:
        raise ValueError("temporary output directory must be a dedicated child directory")
    return output


def payload_names(count: int) -> list[str]:
    return [f"{PAYLOAD_PREFIX}{index:03d}.bin" for index in range(count)]


def content_types(source: zipfile.ZipFile, names: list[str]) -> bytes:
    root = ElementTree.fromstring(source.read("[Content_Types].xml"))
    overrides = {
        override.get("PartName"): override
        for override in root.findall(f"{{{CONTENT_TYPES_NS}}}Override")
    }
    for name in names:
        part_name = f"/{name}"
        if part_name in overrides:
            overrides[part_name].set("ContentType", PAYLOAD_TYPE)
        else:
            ElementTree.SubElement(
                root,
                f"{{{CONTENT_TYPES_NS}}}Override",
                {"PartName": part_name, "ContentType": PAYLOAD_TYPE},
            )
    return ElementTree.tostring(root, encoding="utf-8", xml_declaration=True)


def copied_info(source: zipfile.ZipInfo) -> zipfile.ZipInfo:
    info = zipfile.ZipInfo(source.filename, date_time=FIXED_TIMESTAMP)
    info.compress_type = source.compress_type
    info.external_attr = source.external_attr
    info.internal_attr = source.internal_attr
    info.create_system = source.create_system
    info.flag_bits = 0
    return info


def copy_member(source: zipfile.ZipFile, destination: zipfile.ZipFile, info: zipfile.ZipInfo, replacement: bytes | None = None) -> None:
    target = copied_info(info)
    with destination.open(target, "w") as sink:
        if replacement is not None:
            sink.write(replacement)
            return
        with source.open(info, "r") as reader:
            shutil.copyfileobj(reader, sink, CHUNK_BYTES)


def deterministic_payload(sink, size: int) -> None:
    # A fixed non-sensitive byte pattern makes the generated package repeatable
    # without retaining a large payload in memory.  ZIP_STORED keeps the source
    # size meaningful instead of relying on a compression ratio.
    block = bytes(range(256)) * (CHUNK_BYTES // 256)
    remaining = size
    while remaining:
        amount = min(remaining, len(block))
        sink.write(block[:amount])
        remaining -= amount


def write_package(template: Path, destination: Path, payload_sizes: list[int]) -> int:
    names = payload_names(len(payload_sizes))
    with zipfile.ZipFile(template, "r") as source, zipfile.ZipFile(destination, "w", allowZip64=False) as output:
        source_names = set(source.namelist())
        if "[Content_Types].xml" not in source_names:
            raise ValueError("template is not an OPC package")
        if any(name in source_names for name in names):
            raise ValueError("template already contains the reserved capacity part")
        updated_types = content_types(source, names)
        for info in source.infolist():
            copy_member(source, output, info, updated_types if info.filename == "[Content_Types].xml" else None)
        for name, payload_size in zip(names, payload_sizes, strict=True):
            if not 0 <= payload_size <= MAX_PAYLOAD_PART_BYTES:
                raise ValueError("capacity payload part exceeds the per-entry budget")
            payload = zipfile.ZipInfo(name, date_time=FIXED_TIMESTAMP)
            payload.compress_type = zipfile.ZIP_STORED
            payload.external_attr = 0o600 << 16
            with output.open(payload, "w", force_zip64=False) as sink:
                deterministic_payload(sink, payload_size)
    return destination.stat().st_size


def split_payload(total_bytes: int, part_count: int) -> list[int]:
    if total_bytes < 0:
        raise ValueError("target is smaller than the package metadata")
    sizes: list[int] = []
    remaining = total_bytes
    for _ in range(part_count):
        size = min(remaining, MAX_PAYLOAD_PART_BYTES)
        sizes.append(size)
        remaining -= size
    if remaining:
        raise ValueError("target requires an entry larger than the per-entry budget")
    return sizes


def generate(kind: str, target_bytes: int, output_dir: Path) -> Path:
    if kind not in TEMPLATES:
        raise ValueError("unsupported OOXML extension")
    if not MIN_TARGET_BYTES <= target_bytes <= MAX_TARGET_BYTES:
        raise ValueError(f"target must be between {MIN_TARGET_BYTES // MIB} and {MAX_TARGET_BYTES // MIB} MiB")
    template, required_part = TEMPLATES[kind]
    if not template.is_file():
        raise ValueError("tracked template is unavailable")
    output_dir.mkdir(parents=True, exist_ok=True)
    output = output_dir / f"capacity-{kind}-{target_bytes // MIB}mib.{kind}"
    if output.exists():
        raise ValueError("refusing to overwrite an existing capacity package")

    # Choose enough entries for the requested source size before measuring ZIP
    # metadata. Each stored payload part remains within the same 64 MiB
    # per-entry policy enforced by Nautilo and Silurus.
    part_count = max(1, (target_bytes + MAX_PAYLOAD_PART_BYTES - 1) // MAX_PAYLOAD_PART_BYTES)

    # The first pass measures ZIP metadata. Stored payload changes output size
    # one-for-one, so at most two streamed candidate passes reach the exact target.
    work = output.with_suffix(output.suffix + ".partial")
    candidate = output.with_suffix(output.suffix + ".candidate")
    if work.exists() or candidate.exists():
        raise ValueError("refusing to replace an existing capacity temporary package")
    published = False
    succeeded = False
    try:
        first_size = write_package(template, work, [0] * part_count)
        payload_sizes = split_payload(target_bytes - first_size, part_count)
        actual = write_package(template, candidate, payload_sizes)
        if actual != target_bytes:
            candidate.unlink()
            payload_sizes = split_payload(
                sum(payload_sizes) + target_bytes - actual,
                part_count,
            )
            actual = write_package(template, candidate, payload_sizes)
        if actual != target_bytes:
            raise RuntimeError("unable to reach the requested package size")
        with zipfile.ZipFile(candidate, "r") as package:
            package_names = set(package.namelist())
            if (
                package.testzip() is not None
                or required_part not in package_names
                or not set(payload_names(part_count)).issubset(package_names)
                or any(
                    package.getinfo(name).file_size > MAX_PAYLOAD_PART_BYTES
                    for name in payload_names(part_count)
                )
            ):
                raise RuntimeError("generated package did not pass integrity validation")
        # link() is atomic and fails if another process created the final path
        # after our initial check.  Unlike replace(), it never overwrites that
        # concurrent file. Both names are siblings on the same filesystem.
        os.link(candidate, output)
        published = True
        candidate.unlink()
        succeeded = True
        return output
    finally:
        work.unlink(missing_ok=True)
        candidate.unlink(missing_ok=True)
        if published and not succeeded:
            output.unlink(missing_ok=True)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Generate a local OOXML capacity package from a tracked small fixture.")
    parser.add_argument("--format", choices=sorted(TEMPLATES), required=True, dest="kind")
    parser.add_argument("--target-mib", type=int, required=True, help="Final compressed-source size in binary MiB (1-512).")
    parser.add_argument("--output-dir", default=str(DEFAULT_OUTPUT_DIR), help="Dedicated local capacity directory or a dedicated system-temp child directory.")
    return parser.parse_args()


def main() -> int:
    try:
        args = parse_args()
        output = generate(args.kind, args.target_mib * MIB, safe_output_dir(args.output_dir))
        with output.open("rb") as handle:
            digest = hashlib.file_digest(handle, "sha256").hexdigest()
        print(f"generated {args.kind} capacity package: {output.stat().st_size} bytes; sha256={digest}")
        return 0
    except (OSError, RuntimeError, ValueError, zipfile.BadZipFile) as error:
        print(f"capacity generator refused: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
