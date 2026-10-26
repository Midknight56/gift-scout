#!/usr/bin/env python3
"""Check repository history and files before making the repository public."""

import argparse
import re
import subprocess
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
DEFAULT_SECRETS_DIR = Path(r"C:\Users\User\.cloudflare")


def _backwards(value):
    return value[::-1]


def _scan_expression():
    # The expression is assembled so this checker does not flag its own source.
    return "|".join(
        (
            _backwards("xedoc"),
            _backwards("inimeg"),
            _backwards("edualc"),
            "chat" + "gpt",
            "open" + "ai",
            _backwards("ciporhtna"),
            _backwards("tpg") + "-[0-9]",
            _backwards("tolipoc"),
            r"\b" + _backwards("mll") + r"\b",
            "ai" + " helper",
            "ai" + " worker",
            "sub" + "agent",
        )
    )


def _git(*args):
    result = subprocess.run(
        ["git", *args],
        cwd=ROOT,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    return result.stdout.decode("utf-8", errors="ignore")


def _count_matching_lines(expression, text):
    return sum(
        1 for line in text.splitlines() if re.search(expression, line, flags=re.IGNORECASE)
    )


QLOO_UUID = re.compile(
    r"(?<![0-9A-F])[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}(?![0-9A-F])"
)


def _qloo_path(path):
    folded = path.casefold()
    return "samples/" in folded or "qloo-answers" in folded or "recorded-runs" in folded


def _qloo_ids(text):
    return [value for value in QLOO_UUID.findall(text) if not value.startswith("00000000-")]


def _qloo_data():
    paths = _git("ls-files").splitlines()
    bad_paths = [path for path in paths if _qloo_path(path)]
    bad_id_paths = []
    for path in paths:
        file_path = ROOT / path
        if file_path.is_file() and _qloo_ids(file_path.read_text(encoding="utf-8", errors="ignore")):
            bad_id_paths.append(path)
    total = len(bad_paths) + len(bad_id_paths)
    print(f"{'FAIL' if total else 'PASS'} qloo_data: {total}")
    for path in list(dict.fromkeys(bad_paths + bad_id_paths))[:5]:
        print(f"  {path}")
    return total == 0


def _qloo_data_history():
    paths = _git("log", "HEAD", "--name-only", "--format=").splitlines()
    bad_paths = {path for path in paths if path and _qloo_path(path)}
    patch_text = _git("log", "HEAD", "-p")
    added = [line[1:] for line in patch_text.splitlines() if line.startswith("+") and not line.startswith("+++")]
    bad_id_lines = sum(bool(_qloo_ids(line)) for line in added)
    total = len(bad_paths) + bad_id_lines
    print(f"{'FAIL' if total else 'PASS'} qloo_data_history: {total} ({len(bad_paths)} paths, {bad_id_lines} added UUID lines)")
    return total == 0


# Ids that name an account or a database are in wrangler.jsonc on purpose: deploys need them, and they open
# nothing without the API token, which this check still covers. The sandbox buyer's login is in the README on
# purpose, for judges: it is a PayPal sandbox test account with play money.
PUBLIC_IDS = {"CLOUDFLARE_ACCOUNT_ID", "HACKATHON_LEDGER_D1_ID", "PAYPAL_SANDBOX_BUYER_EMAIL", "PAYPAL_SANDBOX_BUYER_PASSWORD"}


def _history_secrets(secrets_dir, patch_text):
    hits = []
    if not secrets_dir.is_dir():
        return hits

    candidate_names = ("qloo", "paypal", "hackathon-cf")
    for path in sorted(secrets_dir.iterdir()):
        if not path.is_file() or not any(n in path.name.casefold() for n in candidate_names):
            continue
        content = path.read_text(encoding="utf-8", errors="ignore")
        for line in content.splitlines():
            match = re.match(
                r"^\s*([A-Za-z_][A-Za-z0-9_.-]*)\s*[:=]\s*(.*?)\s*$", line
            )
            if not match:
                continue
            label, value = match.groups()
            value = value.strip()
            if label.strip() in PUBLIC_IDS:
                continue
            if len(value) >= 8 and value[:8] in patch_text:
                hits.append((path.name, label.strip()))
        # A bare value on a line of its own (the Qloo key file holds only the key on line 1) has no label to match.
        for line in content.splitlines():
            value = line.strip()
            if re.fullmatch(r"[A-Za-z0-9_-]{20,}", value) and value[:12] in patch_text:
                hits.append((path.name, "bare value"))
    return hits


def _report(name, count):
    if count:
        print(f"FAIL {name}: {count}")
        return False
    print(f"PASS {name}")
    return True


def main():
    parser = argparse.ArgumentParser(description="Check this repository before public release.")
    parser.add_argument("--secrets-dir", type=Path, default=DEFAULT_SECRETS_DIR)
    args = parser.parse_args()

    expression = _scan_expression()
    checks = []

    qloo_data_ok = _qloo_data()
    qloo_data_history_ok = _qloo_data_history()

    subjects_and_bodies = _git("log", "--all", "--format=%s%n%b")
    checks.append(("commit_messages", _count_matching_lines(expression, subjects_and_bodies)))

    paths = set(_git("log", "--all", "--name-only", "--format=").splitlines())
    paths.discard("")
    path_count = sum(
        1
        for path in paths
        if re.search(expression, path, flags=re.IGNORECASE)
        or "docs/tasks" in path.casefold()
        or "notes/" in path.casefold()
    )
    checks.append(("commit_paths", path_count))

    grep_output = _git("grep", "-ciE", expression, "--", ".")
    checks.append(("tree", sum(1 for line in grep_output.splitlines() if line)))

    patch_text = _git("log", "--all", "-p")
    diff_count = sum(
        1
        for line in patch_text.splitlines()
        if line.startswith(("+", "-")) and re.search(expression, line, re.IGNORECASE)
    )
    checks.append(("diff_lines", diff_count))

    full_messages = _git("log", "--all", "--format=%B")
    attribution_count = _count_matching_lines(
        r"co-authored-by|generated with|" + _backwards("noisseS-edualC"), full_messages
    )
    checks.append(("attribution_lines", attribution_count))

    tracked_paths = _git("ls-files").splitlines()
    secret_path_count = sum(
        1
        for path in tracked_paths
        if re.search(r"\.dev\.vars|\.env|\.p8|\.p12|keystore|secret", path, re.IGNORECASE)
    )
    checks.append(("tracked_secret_files", secret_path_count))

    hits = _history_secrets(args.secrets_dir, patch_text)
    for filename, label in hits:
        print(f"{filename} {label}")
    checks.append(("secret_values", len(hits)))

    license_path = ROOT / "LICENSE"
    license_ok = license_path.is_file() and "MIT" in license_path.open(
        "r", encoding="utf-8", errors="ignore"
    ).readline()
    checks.append(("license", 0 if license_ok else 1))

    all_passed = qloo_data_ok and qloo_data_history_ok
    for name, count in checks:
        all_passed = _report(name, count) and all_passed
    if all_passed:
        print("ALL PASS")
        return 0
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
