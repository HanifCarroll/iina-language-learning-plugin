#!/bin/sh
set -eu
cd "$(dirname "$0")/.."

bun run lint
bun run format:check
bun test
bun run package

python3 - <<'PY'
import json
import subprocess
import zipfile
from pathlib import Path

info = json.loads(Path("Info.json").read_text())
name = f"{info['identifier']}.iinaplugin"
folder = Path("dist") / name
archive = Path("dist") / f"{name}-{info['version']}.iinaplgz"

assert info.get("ghRepo"), "ghRepo must identify the GitHub repository"
assert isinstance(info.get("ghVersion"), int), "ghVersion must be an integer"
assert archive.is_file(), f"Missing archive: {archive}"

with zipfile.ZipFile(archive) as package:
    assert package.testzip() is None, "Archive integrity check failed"
    entries = set(package.namelist())
    required = {
        "Info.json", "main.js", "LICENSE", "native/stream-helper",
        "ui/overlay.html", "ui/overlay.css", "ui/overlay.js",
        "ui/sidebar.html", "ui/sidebar.css", "ui/sidebar.js",
        "licenses/markdown-it.LICENSE",
    }
    assert required <= entries, f"Missing package members: {required - entries}"
    assert json.loads(package.read("Info.json")) == info, "Archive metadata differs from source"

subprocess.run(
    ["python3", "tests/test_stream_helper.py", str(folder / "native/stream-helper")],
    check=True,
)
print(f"Release checks passed: {archive}")
PY
