"""Verify-at-write gate: deterministic re-verification of a grounding pack.

Re-runs pack_build.py from the raw CSV + spec into a scratch dir, then:
  1. compares every numeric in the regenerated pack_params.json against the
     stored one (rel tol 1e-6),
  2. byte-compares the regenerated pack_doc.md against the stored one.
A corrupted dataset, params file, or doc all FAIL. Exit 0 iff ALL PASS.

Usage: pack_verify.py --csv data.csv --spec spec.json --doc pack_doc.md --params pack_params.json
"""
import argparse
import json
import subprocess
import sys
import tempfile
from pathlib import Path

TOL_REL = 1e-6


def close(a, b):
    if type(a) is not type(b) and not (isinstance(a, (int, float)) and isinstance(b, (int, float))):
        return False
    if isinstance(a, dict):
        return a.keys() == b.keys() and all(close(a[k], b[k]) for k in a)
    if isinstance(a, list):
        return len(a) == len(b) and all(close(x, y) for x, y in zip(a, b))
    if isinstance(a, bool) or a is None or isinstance(a, str):
        return a == b
    return abs(a - b) <= TOL_REL * max(abs(a), abs(b))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--csv", required=True)
    ap.add_argument("--spec", required=True)
    ap.add_argument("--doc", required=True)
    ap.add_argument("--params", required=True)
    a = ap.parse_args()

    stored_params = json.load(open(a.params))
    stored_doc = Path(a.doc).read_text()

    items = []
    with tempfile.TemporaryDirectory() as tmp:
        build = Path(__file__).parent / "pack_build.py"
        r = subprocess.run(
            [sys.executable, str(build), "--csv", a.csv, "--spec", a.spec, "--out", tmp],
            capture_output=True, text=True,
        )
        if r.returncode != 0:
            print(json.dumps({"all_pass": False, "items": [
                {"key": "rebuild", "pass": False, "detail": (r.stdout + r.stderr)[-1000:]}]}))
            sys.exit(1)
        fresh_params = json.load(open(f"{tmp}/pack_params.json"))
        fresh_doc = Path(f"{tmp}/pack_doc.md").read_text()

    for key in sorted(set(stored_params) | set(fresh_params)):
        items.append({"key": f"params.{key}",
                      "pass": key in stored_params and key in fresh_params
                      and close(stored_params[key], fresh_params[key])})
    items.append({"key": "doc.byte_identical", "pass": fresh_doc == stored_doc})

    all_pass = all(i["pass"] for i in items)
    print(json.dumps({"all_pass": all_pass, "items": items}))
    sys.exit(0 if all_pass else 1)


if __name__ == "__main__":
    main()
