import contextlib
import importlib.util
import io
import pathlib
import subprocess
import sys
import tempfile


HERE = pathlib.Path(__file__).resolve().parent
KEY = "hack_0123456789abcdef0123456789abcdef"
# Made up, and joined at run time so this file does not trip the check it tests once it is committed.
QLOO_ID = "-".join(("ABCDEF12", "3456", "4789", "8ABC", "DEF012345678"))


def load(root):
    spec = importlib.util.spec_from_file_location("public_check", HERE / "public_check.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    module.ROOT = root
    return module


def repo(parent, name, files):
    root = parent / name
    root.mkdir()
    git = lambda *args: subprocess.run(["git", *args], cwd=root, capture_output=True, check=True)
    git("init", "-q")
    git("config", "user.email", "test@example.com")
    git("config", "user.name", "test")
    (root / "LICENSE").write_text("MIT License\n", encoding="utf-8")
    for filename, content in files.items():
        path = root / filename
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")
    git("add", "-A")
    git("commit", "-q", "-m", "fixture")
    return root


def run(root, secrets):
    module = load(root)
    sys.argv = ["public_check.py", "--secrets-dir", str(secrets)]
    with contextlib.redirect_stdout(io.StringIO()):
        return module.main()


def main():
    failed = 0
    with tempfile.TemporaryDirectory() as temporary:
        parent = pathlib.Path(temporary)
        empty = parent / "empty-secrets"
        empty.mkdir()
        bare_secrets = parent / "bare-secrets"
        bare_secrets.mkdir()
        (bare_secrets / "qloo-test-key.txt").write_text(KEY + "\n", encoding="utf-8")
        labelled_secrets = parent / "labelled-secrets"
        labelled_secrets.mkdir()
        (labelled_secrets / "qloo-test-key.txt").write_text(
            "QLOO_API_KEY=" + KEY + "\n", encoding="utf-8"
        )
        cases = (
            ("clean repo", {"README.md": "Plain words.\n"}, empty, 0),
            ("Qloo id in tracked file", {"data.json": '{"id": "' + QLOO_ID + '"}\n'}, empty, 1),
            ("samples folder", {"samples/runs.json": "{}\n"}, empty, 1),
            ("bare key in history", {"notes.txt": KEY + "\n"}, bare_secrets, 1),
            ("labelled key in history", {"notes.txt": "QLOO_API_KEY=" + KEY + "\n"}, labelled_secrets, 1),
        )
        for index, (name, files, secrets, want) in enumerate(cases):
            got = run(repo(parent, "case-" + str(index), files), secrets)
            ok = got == want
            failed += not ok
            print(f"{'ok  ' if ok else 'BAD '} {name}: exit {got}, want {want}")
    print("ALL CASES OK" if not failed else f"{failed} CASES WRONG")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
