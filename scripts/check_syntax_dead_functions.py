#!/usr/bin/env python3
"""Run basic syntax and dead-function checks for JS files in repo root."""

from __future__ import annotations

import re
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def run_syntax_check(js_files: list[Path]) -> list[tuple[str, bool, str]]:
    results = []
    for path in js_files:
        proc = subprocess.run(
            ["node", "--check", str(path)],
            cwd=ROOT,
            capture_output=True,
            text=True,
        )
        out = (proc.stdout + proc.stderr).strip()
        results.append((path.name, proc.returncode == 0, out))
    return results


def find_possible_dead_functions(path: Path) -> list[str]:
    text = path.read_text(encoding="utf-8", errors="ignore")

    names = []
    names.extend(re.findall(r"function\s+([A-Za-z_$][\w$]*)\s*\(", text))
    names.extend(
        re.findall(
            r"\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\([^\)]*\)\s*=>",
            text,
        )
    )

    uniq = []
    seen = set()
    for name in names:
        if name not in seen:
            uniq.append(name)
            seen.add(name)

    possible = []
    for name in uniq:
        refs = len(re.findall(rf"\b{re.escape(name)}\b", text))
        if refs <= 1:
            possible.append(name)
    return possible


def main() -> int:
    js_files = sorted(ROOT.glob("*.js"))
    syntax = run_syntax_check(js_files)

    readable = [p for p in js_files if "chunk" not in p.name and not p.name.startswith("main.")]
    dead = {p.name: find_possible_dead_functions(p) for p in readable}

    print("# Syntax check")
    for name, ok, out in syntax:
        status = "PASS" if ok else "FAIL"
        print(f"- {name}: {status}")
        if out and not ok:
            print(out)

    print("\n# Possible dead functions (heuristic)")
    for name in sorted(dead):
        vals = dead[name]
        print(f"- {name}: {len(vals)}")
        if vals:
            print("  " + ", ".join(vals))

    return 0 if all(ok for _, ok, _ in syntax) else 1


if __name__ == "__main__":
    raise SystemExit(main())
