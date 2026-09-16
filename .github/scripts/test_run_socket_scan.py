from __future__ import annotations

import contextlib
import io
import os
import stat
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import run_socket_scan


class SocketTestCase(unittest.TestCase):
    def setUp(self) -> None:
        # Synthetic outcomes must never become the real CI job's scan summary.
        environment = mock.patch.dict(os.environ, {
            "GITHUB_STEP_SUMMARY": "", "GITHUB_OUTPUT": "",
        })
        environment.start()
        self.addCleanup(environment.stop)


class ClassifyResultTests(SocketTestCase):
    def test_clean_scan_passes(self) -> None:
        self.assertEqual(run_socket_scan.classify_result(0, "No issues found"), 0)

    def test_blocking_finding_fails(self) -> None:
        output = "\n".join(
            [
                "Security issues detected by Socket Security:",
                "  - NEW blocking issues: 2",
            ]
        )
        with contextlib.redirect_stdout(io.StringIO()):
            result = run_socket_scan.classify_result(1, output)

        self.assertEqual(result, 1)

    def test_blocking_finding_still_fails_if_process_then_times_out(self) -> None:
        output = "\n".join(
            [
                "Security issues detected by Socket Security:",
                "  - NEW blocking issues: 1",
            ]
        )
        with contextlib.redirect_stdout(io.StringIO()):
            result = run_socket_scan.classify_result(1, output, timed_out=True)

        self.assertEqual(result, 1)

    def test_exit_one_api_failure_is_advisory(self) -> None:
        output = "API Error: upstream request timed out"
        stdout = io.StringIO()

        with contextlib.redirect_stdout(stdout):
            result = run_socket_scan.classify_result(1, output)

        self.assertEqual(result, 0)
        self.assertIn("::warning", stdout.getvalue())

    def test_documented_api_failure_exit_is_advisory(self) -> None:
        stdout = io.StringIO()

        with contextlib.redirect_stdout(stdout):
            result = run_socket_scan.classify_result(
                run_socket_scan.SOCKET_API_ERROR_EXIT,
                "Socket infrastructure error",
            )

        self.assertEqual(result, 0)
        self.assertIn("::warning", stdout.getvalue())

    def test_ambiguous_exit_one_fails_closed(self) -> None:
        stdout = io.StringIO()

        with contextlib.redirect_stdout(stdout):
            result = run_socket_scan.classify_result(1, "unexpected output")

        self.assertEqual(result, 1)
        self.assertIn("::error", stdout.getvalue())

    def test_configuration_error_remains_blocking(self) -> None:
        with contextlib.redirect_stdout(io.StringIO()):
            result = run_socket_scan.classify_result(2, "bad configuration")

        self.assertEqual(result, 2)


class RunScanTests(SocketTestCase):
    def test_missing_credential_never_launches_cli_and_reports_unavailable(self) -> None:
        for credential in ("", "   "):
            with self.subTest(credential=credential), tempfile.TemporaryDirectory() as temp_dir:
                root = Path(temp_dir)
                log_file = root / "socket.log"
                summary = root / "summary.md"
                outputs = root / "outputs"
                stdout = io.StringIO()
                with (
                    mock.patch.dict(os.environ, {
                        "SOCKET_SECURITY_API_KEY": credential,
                        "GITHUB_STEP_SUMMARY": str(summary),
                        "GITHUB_OUTPUT": str(outputs),
                    }, clear=True),
                    mock.patch("run_socket_scan.subprocess.Popen") as process,
                    contextlib.redirect_stdout(stdout),
                ):
                    result = run_socket_scan.run_scan(
                        target_path=root, pr_number=1, scan_timeout_seconds=1,
                        api_timeout_seconds=1, log_file=log_file,
                    )
                self.assertEqual(result, 0)
                process.assert_not_called()
                self.assertIn("coverage=unavailable", log_file.read_text())
                self.assertIn("coverage=unavailable", outputs.read_text())
                self.assertIn("No clean scan is claimed", summary.read_text())
                self.assertIn("::warning", stdout.getvalue())

    def test_timeout_is_advisory_and_writes_log(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            fake_cli = root / "fake-socketcli"
            fake_cli.write_text("#!/usr/bin/env sh\nsleep 10\n", encoding="utf-8")
            fake_cli.chmod(fake_cli.stat().st_mode | stat.S_IXUSR)
            log_file = root / "socket.log"
            stdout = io.StringIO()

            with (
                mock.patch.dict(
                    os.environ,
                    {"SOCKETCLI_BIN": str(fake_cli), "SOCKET_SECURITY_API_KEY": "synthetic"},
                    clear=False,
                ),
                contextlib.redirect_stdout(stdout),
            ):
                result = run_socket_scan.run_scan(
                    target_path=root,
                    pr_number=1,
                    scan_timeout_seconds=0.05,
                    api_timeout_seconds=1,
                    log_file=log_file,
                )

            self.assertEqual(result, 0)
            self.assertTrue(log_file.exists())
            self.assertIn("::warning", stdout.getvalue())


if __name__ == "__main__":
    unittest.main()
