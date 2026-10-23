#!/usr/bin/env python3
"""Block credential files and hardcoded secrets without printing their values.

Default: check tracked and untracked, nonignored working files. --staged checks
the complete Git index (use it immediately before a commit/push). --history
also checks all reachable historical blobs. --history-ref COMMIT limits that
history check to one verified commit's ancestry, for a reviewed release candidate.
No network, dependencies, or keys are required. This is defense in depth, not
proof that no secret exists.
"""
from __future__ import annotations

import argparse
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
import re
import subprocess
import sys


PROVIDER_PATTERNS = (
    ("Google API key", re.compile(r"\bAIza[0-9A-Za-z_-]{35}\b")),
    ("GitHub token", re.compile(r"\bgh[pousr]_[0-9A-Za-z]{30,}\b")),
    ("GitHub fine-grained token", re.compile(r"\bgithub_pat_[0-9A-Za-z_]{40,}\b")),
    ("AWS access key", re.compile(r"\b(?:AKIA|ASIA)[0-9A-Z]{16}\b")),
    ("private key", re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY-----")),
)
SENSITIVE_NAME = (
    r"(?:[A-Za-z_][A-Za-z0-9_]*(?:api_?key|client_?secret|secret_?key|"
    r"access_?token|refresh_?token|private_?key|password|passwd)|"
    r"api_?key|client_?secret|secret_?key|access_?token|refresh_?token|"
    r"private_?key|password|passwd|secret|token)"
)
ASSIGNMENT = re.compile(
    r"(?i)(?<![\w])(?:[\"']?(?P<name>" + SENSITIVE_NAME + r")[\"']?)"
    r"\s*(?::\s*(?:str|Optional\[str\])\s*)?[=:]\s*"
    r"(?P<quote>[\"'])(?P<value>[^\r\n\"']*)(?P=quote)"
)
PLACEHOLDER = re.compile(
    r"(?ix)^(?:"
    r"(?:your|test|mock|fake|dummy|example|synthetic|placeholder|private-test)(?:[-_ :].*)?"
    r"|changeme|change-me|replace[-_ ].*|insert[-_ ].*|<[^>]+>|\$\{[^}]+\}"
    r"|provider-token-never-exposed|private-provider-token"
    r")$"
)
FORBIDDEN_SUFFIXES = {".pem", ".key", ".p12", ".pfx", ".p8", ".jks", ".keystore", ".sqlite", ".sqlite3", ".db", ".pyc", ".pyo"}
FORBIDDEN_PARTS = {".aws", ".ssh", ".gcloud", ".wrangler", ".venv", "venv", "node_modules", "__pycache__", ".pytest_cache", ".mypy_cache", ".ruff_cache", ".cache", "build", "dist"}

# Preserve the original contributor's exact commit hashes. This one bytecode
# blob was committed in silvermete0r's 2025-01-27 history, then removed there.
# Its 83 string constants were inspected without execution and returned no
# supported credential findings. This reviewed artifact exception is HISTORY
# ONLY and requires both its exact path and full blob ID. It never allows a
# bytecode file into today's working tree/index, another path, or another blob.
REVIEWED_HISTORICAL_ARTIFACTS = frozenset({
    ("__pycache__/app.cpython-311.pyc", "37cf846793198392f3840e31c8848d02e9d9c7f5"),
})


@dataclass(frozen=True, order=True)
class Finding:
    path: str
    line: int
    kind: str
    revision: str = ""


def forbidden_path(path: str) -> bool:
    p = PurePosixPath(path.replace("\\", "/"))
    name = p.name.lower()
    parts = {part.lower() for part in p.parts}
    return (
        (name == ".env" or name.startswith(".env.")) and name != ".env.example"
        or name == ".dev.vars" or name.startswith(".dev.vars.")
        or p.suffix.lower() in FORBIDDEN_SUFFIXES
        or bool(parts & FORBIDDEN_PARTS)
        or name.endswith((".sqlite-wal", ".sqlite-shm", ".sqlite3-wal", ".sqlite3-shm", ".db-wal", ".db-shm"))
        or name.endswith(".json") and any(marker in name for marker in ("credentials", "service-account", "service_account", "client_secret", "google-cloud-key"))
    )


def scan_text(path: str, content: str, revision: str = "") -> list[Finding]:
    findings = []
    for number, line in enumerate(content.splitlines(), 1):
        for kind, pattern in PROVIDER_PATTERNS:
            if pattern.search(line):
                findings.append(Finding(path, number, kind, revision))
        for match in ASSIGNMENT.finditer(line):
            value = match.group("value").strip()
            if value and not PLACEHOLDER.fullmatch(value):
                findings.append(Finding(path, number, "hardcoded credential", revision))
        if PurePosixPath(path).name == ".env.example":
            # Environment templates may contain public settings, never secrets.
            env = re.match(r"\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$", line)
            if env and re.fullmatch(SENSITIVE_NAME, env.group(1), re.I):
                if env.group(2).strip("\"'"):
                    findings.append(Finding(path, number, "nonempty secret in environment template", revision))
    return findings


def git(root: Path, *args: str) -> bytes:
    result = subprocess.run(["git", "-C", str(root), *args], capture_output=True, check=False)
    if result.returncode:
        # Git stderr can contain an authenticated remote URL. Never echo it.
        raise RuntimeError("Git inspection failed; release check is incomplete.")
    return result.stdout


def scan_blob(root: Path, path: str, oid: str, revision: str = "", *, historical: bool = False) -> list[Finding]:
    if forbidden_path(path):
        if historical and (path, oid) in REVIEWED_HISTORICAL_ARTIFACTS:
            return []
        # Do not open credential files, including any .env file.
        return [Finding(path, 0, "private or generated file must not be tracked", revision)]
    data = git(root, "cat-file", "blob", oid)
    if b"\0" in data:
        return []
    return scan_text(path, data.decode("utf-8", errors="replace"), revision)


def scan_staged(root: Path) -> list[Finding]:
    findings = []
    for entry in git(root, "ls-files", "--stage", "-z").split(b"\0"):
        if not entry:
            continue
        metadata, filename = entry.split(b"\t", 1)
        _mode, oid, stage = metadata.decode("ascii").split()
        path = filename.decode("utf-8", errors="replace")
        if stage != "0":
            findings.append(Finding(path, 0, "unresolved merge; release check is incomplete"))
            continue
        findings.extend(scan_blob(root, path, oid))
    return findings


def scan_worktree(root: Path) -> list[Finding]:
    findings = []
    paths = git(root, "ls-files", "--cached", "--others", "--exclude-standard", "-z").split(b"\0")
    for filename in sorted(set(paths)):
        if not filename:
            continue
        path = filename.decode("utf-8", errors="replace")
        target = root / path
        if not target.exists():
            continue
        if forbidden_path(path):
            findings.append(Finding(path, 0, "private or generated file must not be tracked"))
            continue
        if target.is_symlink():
            findings.append(Finding(path, 0, "symlink needs manual review"))
            continue
        data = target.read_bytes()
        if b"\0" not in data:
            findings.extend(scan_text(path, data.decode("utf-8", errors="replace")))
    return findings


def scan_history(root: Path, ref: str | None = None) -> list[Finding]:
    findings = []
    if ref is not None:
        # Resolve exactly one commit. Never pass a user-supplied argument to
        # rev-list, where revision syntax/options could broaden or omit history.
        resolved = git(root, "rev-parse", "--verify", "--end-of-options", f"{ref}^{{commit}}").decode("ascii").strip()
        if not re.fullmatch(r"[0-9a-fA-F]{40,64}", resolved):
            raise RuntimeError("History target did not resolve to one commit.")
        target = resolved
    else:
        target = "--all"
    # rev-list returns each reachable blob once, including blobs from old commits.
    for entry in git(root, "rev-list", "--objects", target).splitlines():
        oid, separator, filename = entry.partition(b" ")
        if not separator:
            continue
        if git(root, "cat-file", "-t", oid.decode("ascii")).strip() != b"blob":
            continue
        path = filename.decode("utf-8", errors="replace")
        findings.extend(scan_blob(root, path, oid.decode("ascii"), oid[:12].decode("ascii"), historical=True))
    return findings


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--staged", action="store_true", help="scan every file in the Git index")
    parser.add_argument("--history", action="store_true", help="also scan all reachable historical blobs")
    parser.add_argument("--history-ref", metavar="COMMIT", help="scan the ancestry of exactly one verified release commit instead of all refs")
    args = parser.parse_args(argv)
    try:
        root = Path(git(Path.cwd(), "rev-parse", "--show-toplevel").decode().strip())
        findings = scan_staged(root) if args.staged else scan_worktree(root)
        if args.history or args.history_ref is not None:
            findings.extend(scan_history(root, args.history_ref))
    except (OSError, RuntimeError, ValueError):
        print("ERROR: secret inspection could not complete. Do not publish.", file=sys.stderr)
        return 2
    for finding in sorted(set(findings)):
        location = f"{finding.path}:{finding.line}" if finding.line else finding.path
        revision = f" [historical blob {finding.revision}]" if finding.revision else ""
        print(f"BLOCKED: {location}{revision}: {finding.kind}")
    if findings:
        print("Secret check failed. Values are deliberately redacted; do not publish these files/history.")
        return 1
    print("Secret check passed; no supported credential patterns or forbidden tracked files found.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
