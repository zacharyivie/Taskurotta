"""Audit the complete lockfiles, including Electron and every Python platform branch."""

from __future__ import annotations

import json
import subprocess
import sys
import tomllib
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def main() -> int:
    evidence = ROOT / "audit-evidence"
    evidence.mkdir(exist_ok=True)
    lock = tomllib.loads((ROOT / "uv.lock").read_text(encoding="utf8"))
    packages = sorted(
        {
            f"{package['name']}=={package['version']}"
            for package in lock["package"]
            if "registry" in package.get("source", {})
        }
    )
    # Keep all platform branches. Resolving this file would drop packages shipped
    # on a different OS, so pip-audit must inspect the exact inventory instead.
    inventory = evidence / "python-lock-inventory.txt"
    inventory.write_text("\n".join(packages) + "\n", encoding="utf8")
    result = subprocess.run(
        [
            sys.executable,
            "-m",
            "pip_audit",
            "--disable-pip",
            "--no-deps",
            "--progress-spinner",
            "off",
            "--format",
            "json",
            "--output",
            str(evidence / "python-audit.json"),
            "--requirement",
            str(inventory),
        ],
        cwd=ROOT,
        check=False,
    )
    npm_lock = json.loads((ROOT / "frontend/package-lock.json").read_text(encoding="utf8"))
    (evidence / "npm-lock-inventory.json").write_text(
        json.dumps(
            {
                "lockfileVersion": npm_lock["lockfileVersion"],
                "packages": {
                    path: {
                        key: package[key]
                        for key in ("version", "integrity", "dev")
                        if key in package
                    }
                    for path, package in npm_lock["packages"].items()
                },
            },
            indent=2,
        )
        + "\n",
        encoding="utf8",
    )
    return result.returncode


if __name__ == "__main__":
    raise SystemExit(main())
