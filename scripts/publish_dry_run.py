"""Build all five packages and show exactly what would be published. Uploads nothing, needs no login and reads no registry token.

    python sdks/scripts/publish_dry_run.py              # builds, checks, prints every package's file list
    python sdks/scripts/publish_dry_run.py --out DIR    # keeps the built files in DIR, which PUBLISHING.md then uploads

Needs node and npm, and uv or a Python with the `build` and `twine` modules. Exits non-zero if a check fails.
"""
from __future__ import annotations

import argparse
import json
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import zipfile
from pathlib import Path

SDKS = Path(__file__).resolve().parent.parent
NPM = shutil.which("npm") or "npm"
UV = shutil.which("uv")
EXPECTED = {
    "@steerpane/sdk": ("node", "0.1.0"),
    "@steerpane/cli": ("cli", "0.1.1"),
    "steerpane (npm placeholder)": ("placeholders/npm", "0.0.1"),
    "steerpane-sdk": ("python", "0.1.0"),
    "steerpane (PyPI placeholder)": ("placeholders/pypi", "0.0.1"),
}
# Anything that looks like server code, a secret or local state must not ship.
BAD_PATHS = re.compile(r"(^|/)(backend|frontend|docs|tests?|\.venv|node_modules|\.env[^/]*|.*\.pem|.*\.key|config\.json|__pycache__)(/|$)")
BAD_CONTENT = [
    (re.compile(rb"stp_live_[0-9a-f]{20,}|cdt_[0-9a-f]{20,}|whsec_[0-9a-f]{20,}|sk-ant-[A-Za-z0-9_-]{20,}|npm_[A-Za-z0-9]{30,}|pypi-[A-Za-z0-9_-]{30,}"), "something shaped like a real secret"),
    (re.compile(rb"from app\.|import app\.|backend/app|conduit_dev"), "a reference to server code"),
    (re.compile(rb"BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY"), "a private key"),
]


def run(cmd: list[str], cwd: Path) -> str:
    done = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, encoding="utf-8", errors="replace")
    if done.returncode:
        sys.exit(f"FAILED: {' '.join(cmd)}\n{done.stdout}\n{done.stderr}")
    return done.stdout + done.stderr


def members(artifact: Path) -> list[tuple[str, bytes]]:
    if artifact.suffix == ".whl":
        with zipfile.ZipFile(artifact) as z:
            return [(i.filename, z.read(i)) for i in z.infolist() if not i.is_dir()]
    with tarfile.open(artifact) as t:
        return [(m.name, t.extractfile(m).read()) for m in t.getmembers() if m.isfile()]  # type: ignore[union-attr]


def inspect(artifact: Path, package_root: str) -> list[str]:
    problems = []
    print(f"\n  {artifact.name}  ({artifact.stat().st_size:,} bytes)")
    for name, data in members(artifact):
        relative = name.split("/", 1)[1] if artifact.suffix != ".whl" and "/" in name else name
        print(f"    {len(data):>8,}  {relative}")
        if BAD_PATHS.search(relative):
            problems.append(f"{artifact.name}: should not contain {relative}")
        for pattern, why in BAD_CONTENT:
            if pattern.search(data):
                problems.append(f"{artifact.name}: {relative} contains {why}")
    if not any(n.endswith("LICENSE") or "/licenses/" in n for n, _ in members(artifact)):
        problems.append(f"{artifact.name}: no LICENSE")
    return problems


def build_python(folder: Path, out: Path) -> list[Path]:
    if UV:
        run([UV, "build", "--out-dir", str(out)], folder)
    else:
        run([sys.executable, "-m", "build", "--outdir", str(out)], folder)
    return sorted(p for p in out.iterdir() if p.suffix in (".whl", ".gz") and folder_matches(p, folder))


def folder_matches(artifact: Path, folder: Path) -> bool:
    text = (folder / "pyproject.toml").read_text(encoding="utf-8")
    name = re.search(r'^name = "(.+)"', text, re.M).group(1).replace("-", "_")  # type: ignore[union-attr]
    return artifact.name.startswith(f"{name}-")


def twine_check(files: list[Path]) -> None:
    cmd = [UV, "tool", "run", "twine", "check"] if UV else [sys.executable, "-m", "twine", "check"]
    run(cmd + [str(f) for f in files], SDKS)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--out", help="keep the built packages here")
    args = ap.parse_args()
    temporary = None if args.out else tempfile.TemporaryDirectory(prefix="steerpane-dry-run-")
    out = Path(args.out or temporary.name).resolve()  # type: ignore[union-attr]
    out.mkdir(parents=True, exist_ok=True)
    for stale in out.iterdir():
        if stale.is_file() and stale.suffix in (".tgz", ".whl", ".gz"):
            stale.unlink()

    print("Installing and building the Node packages")
    run([NPM, "ci"], SDKS)
    run([NPM, "run", "build"], SDKS)

    problems: list[str] = []
    for label, (folder, version) in EXPECTED.items():
        path = SDKS / folder
        print(f"\n=== {label}  {version}")
        if (path / "package.json").exists():
            manifest = json.loads((path / "package.json").read_text(encoding="utf-8"))
            if manifest["version"] != version:
                problems.append(f"{label}: version is {manifest['version']}, expected {version}")
            if manifest.get("license") != "Apache-2.0":
                problems.append(f"{label}: licence is {manifest.get('license')}")
            repo = manifest.get("repository")
            if repo and "github.com/Steerpane/sdks" not in str(repo):
                problems.append(f"{label}: repository field points somewhere other than Steerpane/sdks: {repo}")
            before = set(out.iterdir())
            run([NPM, "pack", "--pack-destination", str(out)], path)
            artifacts = sorted(set(out.iterdir()) - before)
        else:
            if f'version = "{version}"' not in (path / "pyproject.toml").read_text(encoding="utf-8"):
                problems.append(f"{label}: version isn't {version}")
            artifacts = build_python(path, out)
            twine_check(artifacts)
        if not artifacts:
            problems.append(f"{label}: nothing was built")
        for artifact in artifacts:
            problems += inspect(artifact, folder)

    print("\nNothing was uploaded.")
    if problems:
        print("\nPROBLEMS:")
        for p in problems:
            print(f"  - {p}")
        return 1
    print("All checks passed: versions, licences, no server code, no secrets, no tests or local files.")
    if args.out:
        print(f"Built packages are in {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
