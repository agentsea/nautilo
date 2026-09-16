#!/usr/bin/env python3
"""Run Socket CI without conflating findings with provider outages."""

from __future__ import annotations

import argparse
import os
import re
import signal
import subprocess
import threading
from pathlib import Path

SOCKET_API_ERROR_EXIT = 3
BLOCKING_FINDING = re.compile(
    r"(?:NEW|EXISTING) blocking issues:\s*[1-9][0-9]*",
)
API_FAILURE_MARKERS = (
    "API Error:",
    "Socket infrastructure error",
    "Error getting diff report:",
)


def record_coverage(status: str, message: str) -> None:
    """Keep an advisory CI exit distinct from completed security coverage."""
    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary:
        with Path(summary).open("a", encoding="utf-8") as output:
            output.write(f"### Socket dependency coverage: {status}\n\n{message}\n\n")
    outputs = os.environ.get("GITHUB_OUTPUT")
    if outputs:
        with Path(outputs).open("a", encoding="utf-8") as output:
            output.write(f"coverage={status}\n")


def annotation(level: str, title: str, message: str) -> None:
    print(f"::{level} title={title}::{message}", flush=True)
    if title == "Socket dependency scan unavailable":
        record_coverage("unavailable", message + " No clean scan is claimed.")
    elif level == "error":
        record_coverage("failed", message)


def classify_result(exit_code: int, output: str, *, timed_out: bool = False) -> int:
    """Map Socket's result to a trustworthy CI outcome."""
    has_security_report = "Security issues detected by Socket Security:" in output
    if has_security_report and BLOCKING_FINDING.search(output):
        annotation(
            "error",
            "Socket blocking dependency finding",
            "Socket reported one or more blocking dependency issues.",
        )
        return 1

    if timed_out:
        annotation(
            "warning",
            "Socket dependency scan unavailable",
            "Socket did not complete before the availability timeout. "
            "This is not a dependency finding; consult the retained scan log.",
        )
        return 0

    if exit_code == 0:
        record_coverage("completed", "Socket completed without blocking findings.")
        return 0

    if exit_code == 1:
        # socketsecurity 2.5.6 incorrectly exits 1 for APIFailure in its
        # streaming diff path, despite documenting exit 3 for API failures.
        if any(marker in output for marker in API_FAILURE_MARKERS):
            annotation(
                "warning",
                "Socket dependency scan unavailable",
                "Socket reported an API/infrastructure failure, not a dependency finding. "
                "Consult the retained scan log.",
            )
            return 0

        annotation(
            "error",
            "Ambiguous Socket dependency scan failure",
            "Socket exited 1 without a recognizable blocking report or API error; "
            "failing closed. Consult the retained scan log.",
        )
        return 1

    if exit_code == SOCKET_API_ERROR_EXIT:
        annotation(
            "warning",
            "Socket dependency scan unavailable",
            "Socket returned its documented API/infrastructure error exit code. "
            "This is not a dependency finding; consult the retained scan log.",
        )
        return 0

    annotation(
        "error",
        "Socket dependency scan execution failure",
        f"Socket exited with code {exit_code}; failing closed. "
        "Consult the retained scan log.",
    )
    return exit_code


def _terminate_process_group(process: subprocess.Popen[str]) -> None:
    try:
        os.killpg(process.pid, signal.SIGTERM)
        process.wait(timeout=10)
    except (ProcessLookupError, subprocess.TimeoutExpired):
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        process.wait()


def run_scan(
    *,
    target_path: Path,
    pr_number: int,
    scan_timeout_seconds: float,
    api_timeout_seconds: int,
    log_file: Path,
) -> int:
    if not os.environ.get("SOCKET_SECURITY_API_KEY", "").strip():
        message = (
            "No Socket API credential is available for this run (including fork PRs). "
            "Authenticated dependency scanning did not run. "
            "The separate Socket Firewall frozen-install check still applies."
        )
        log_file.parent.mkdir(parents=True, exist_ok=True)
        log_file.write_text("coverage=unavailable\n" + message + "\n", encoding="utf-8")
        annotation("warning", "Socket dependency scan unavailable", message)
        return 0

    socketcli = os.environ.get("SOCKETCLI_BIN", "socketcli")
    command = [
        socketcli,
        "--target-path",
        str(target_path),
        "--scm",
        "github",
        "--pr-number",
        str(pr_number),
        "--timeout",
        str(api_timeout_seconds),
        "--exit-code-on-api-error",
        str(SOCKET_API_ERROR_EXIT),
    ]
    log_file.parent.mkdir(parents=True, exist_ok=True)
    output_parts: list[str] = []

    with log_file.open("w", encoding="utf-8") as log:
        process = subprocess.Popen(
            command,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1,
            start_new_session=True,
        )
        assert process.stdout is not None

        def copy_output() -> None:
            for line in process.stdout:
                output_parts.append(line)
                log.write(line)
                log.flush()
                print(line, end="", flush=True)

        output_thread = threading.Thread(target=copy_output, daemon=True)
        output_thread.start()
        timed_out = False
        try:
            exit_code = process.wait(timeout=scan_timeout_seconds)
        except subprocess.TimeoutExpired:
            timed_out = True
            _terminate_process_group(process)
            exit_code = process.returncode
        output_thread.join(timeout=10)
        process.stdout.close()

    return classify_result(exit_code, "".join(output_parts), timed_out=timed_out)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--target-path", type=Path, required=True)
    parser.add_argument("--pr-number", type=int, required=True)
    parser.add_argument("--scan-timeout-seconds", type=float, default=480)
    parser.add_argument("--api-timeout-seconds", type=int, default=420)
    parser.add_argument("--log-file", type=Path, required=True)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    return run_scan(
        target_path=args.target_path,
        pr_number=args.pr_number,
        scan_timeout_seconds=args.scan_timeout_seconds,
        api_timeout_seconds=args.api_timeout_seconds,
        log_file=args.log_file,
    )


if __name__ == "__main__":
    raise SystemExit(main())
