"""Generic grounding-pack builder.

Per-column known-form trend fits (fit on first 80% of the index window, validate
on the last 20%),
optional normalized shape table for long-format (group/x/y) data, optional
per-group summary trend fits when value columns are constant within each group,
envelope statement, honesty notes.

Deterministic: pack_doc.md and pack_params.json are pure functions of
(csv bytes, spec json). pack_verify.py re-runs this from the raw CSV and
byte-compares the regenerated doc — the verify-at-write gate.

Usage: pack_build.py --csv data.csv --spec spec.json --out outdir
"""
import argparse
import csv as csvmod
import hashlib
import io
import json
import sys

import numpy as np
from scipy.optimize import curve_fit

MIN_ROWS = 12
MIN_GROUPS = 8
MAX_INLINE_ROWS = 400
HOLDOUT_FRAC = 0.2
GRID = np.round(np.arange(0.0, 1.0001, 0.025), 4)


def fail(msg):
    print(json.dumps({"error": msg}))
    sys.exit(1)


def fmt(v):
    return f"{v:.6g}"


def load_table(csv_text):
    reader = csvmod.reader(io.StringIO(csv_text))
    rows = [r for r in reader if r and any(c.strip() for c in r)]
    if len(rows) < 2:
        fail("CSV has no data rows")
    header = [h.strip() for h in rows[0]]
    if len(set(header)) != len(header):
        fail("Duplicate column names in CSV header")
    width = len(header)
    cols = {h: [] for h in header}
    for i, r in enumerate(rows[1:], start=2):
        if len(r) != width:
            fail(f"Row {i} has {len(r)} cells, expected {width}")
        for h, cell in zip(header, r):
            try:
                cols[h].append(float(cell))
            except ValueError:
                fail(f"Non-numeric value '{cell.strip()}' in column '{h}' row {i}")
    return header, {h: np.array(v) for h, v in cols.items()}


def lin(x, a, b):
    return a - b * x


def sqrt_lin(x, a, b, c):
    return a - b * x - c * np.sqrt(np.abs(x))


def expo(x, a, b, c):
    return a - b * (np.exp(c * x) - 1.0)


FORMS = [
    ("linear", lin, lambda y: [float(y[0]), 0.0], "y = a − b·k"),
    ("sqrt_linear", sqrt_lin, lambda y: [float(y[0]), 0.0, 0.0], "y = a − b·k − c·√k"),
    ("exponential", expo, lambda y: [float(y[0]), 0.01, 0.001], "y = a − b·(e^(c·k) − 1)"),
]


def fit_trends(k, y):
    n = len(k)
    fit_n = max(int(np.floor(n * (1 - HOLDOUT_FRAC))), MIN_ROWS - 2)
    fit_m = np.zeros(n, dtype=bool)
    fit_m[:fit_n] = True
    val_m = ~fit_m
    out = {}
    for name, fn, p0fn, _ in FORMS:
        try:
            with np.errstate(all="ignore"):
                p, _ = curve_fit(fn, k[fit_m], y[fit_m], p0=p0fn(y), maxfev=50000)
                pred_fit = fn(k[fit_m], *p)
                pred_val = fn(k[val_m], *p)
            if not (np.all(np.isfinite(pred_fit)) and np.all(np.isfinite(pred_val))):
                raise FloatingPointError("non-finite prediction")
            out[name] = {
                "params": [float(x) for x in p],
                "fit_mae": float(np.mean(np.abs(pred_fit - y[fit_m]))),
                "val_mae": float(np.mean(np.abs(pred_val - y[val_m]))),
            }
        except Exception:
            out[name] = {"failed": True}
    ok = {n_: m for n_, m in out.items() if "failed" not in m}
    best = min(ok, key=lambda n_: ok[n_]["val_mae"]) if ok else None
    return out, best, fit_n, n - fit_n


def build_shape(groups):
    keys = sorted(groups.keys())
    usable = [g for g in keys if len(groups[g][0]) >= 4]
    skipped = len(keys) - len(usable)
    if len(usable) < MIN_GROUPS:
        fail(f"Shape table needs >= {MIN_GROUPS} groups with >= 4 points; got {len(usable)}")
    val_n = max(int(np.floor(len(usable) * HOLDOUT_FRAC)), 1)
    pack_groups, val_groups = usable[:-val_n], usable[-val_n:]

    def group_curve(g):
        x, y = groups[g]
        order = np.argsort(x)
        x, y = x[order], y[order]
        span = x[-1] - x[0]
        if span <= 0:
            return None
        xf = (x - x[0]) / span
        return np.interp(GRID, xf, y)

    curves = [c for c in (group_curve(g) for g in pack_groups) if c is not None]
    stack = np.vstack(curves)
    ref = np.median(stack, axis=0)
    std = np.std(stack, axis=0)
    val_curves = [c for c in (group_curve(g) for g in val_groups) if c is not None]
    val_mae = float(np.mean([np.mean(np.abs(c - ref)) for c in val_curves]))
    return {
        "grid": [float(g) for g in GRID],
        "ref": [float(v) for v in ref],
        "std": [float(v) for v in std],
        "val_mae": val_mae,
        "n_groups": len(pack_groups),
        "n_val_groups": len(val_groups),
        "n_skipped_groups": skipped,
    }


def render_doc(title, sha, n_rows, header, spec, trends, shape, index_col, value_cols, csv_text):
    cols = spec["columns"]
    notes = spec.get("notes", "").strip()
    unit = lambda c: cols[c].get("unit", "")
    uphr = lambda c: f" [{unit(c)}]" if unit(c) else ""

    L = []
    L.append(f"# Grounding pack — {title}\n")
    L.append("## 1. Provenance and valid envelope\n")
    role_desc = ", ".join(f"`{c}` = {cols[c]['role']}{uphr(c)}" for c in header if cols[c]["role"] != "ignore")
    L.append(f"Process dataset: uploaded CSV, {n_rows} data rows (sha256 `{sha}`). Column roles: {role_desc}.")
    if notes:
        L.append(f"\nOperator notes: {notes}")
    L.append("\nEvery number below is recomputable from the raw records by a deterministic script; none are estimated from literature.\n")

    if index_col is not None:
        k = trends["_index"]
        L.append(f"**Valid envelope: observations cover `{index_col}` from {fmt(k['min'])} to {fmt(k['max'])}{uphr(index_col)}. "
                 "Estimates that interpolate within this range inherit the held-out validation errors stated in §3. "
                 f"Trend extrapolation beyond {fmt(k['max'])} carries the validation error as a *lower bound* plus growing "
                 "structural uncertainty from regime changes the fitted forms do not model.**\n")
    else:
        L.append("**Valid envelope: the shape table in §4 describes the observed runs only; it embeds their operating "
                 "conditions and does not transfer to other conditions.**\n")

    L.append("## 2. Measured records\n")
    lines = csv_text.strip().splitlines()
    if n_rows <= MAX_INLINE_ROWS:
        L.append("```csv\n" + "\n".join(lines) + "\n```\n")
    else:
        L.append(f"First and last 30 of {n_rows} rows (full dataset is held with the pack and used for verification):\n")
        L.append("```csv\n" + "\n".join(lines[:31] + ["..."] + lines[-30:]) + "\n```\n")

    if value_cols:
        fit_n, val_n = trends["_split"]
        L.append(f"## 3. Fitted trend models (fit window: first {fit_n} index points; held-out validation: last {val_n})\n")
        for i, c in enumerate(value_cols):
            m = trends[c]
            L.append(f"### 3{chr(97 + i)}. {c}(k){uphr(c)}")
            L.append("| model | formula | parameters | fit MAE | validation MAE |")
            L.append("|---|---|---|---|---|")
            for name, _, _, formula in FORMS:
                r = m["forms"][name]
                if "failed" in r:
                    L.append(f"| {name} | {formula} | — | fit failed | fit failed |")
                else:
                    ps = ", ".join(fmt(p) for p in r["params"])
                    L.append(f"| {name} | {formula} | {ps} | {fmt(r['fit_mae'])} | {fmt(r['val_mae'])} |")
            if m["best"]:
                L.append(f"\nBest on held-out validation: **{m['best']}**. Use it for in-envelope estimates, "
                         "with the validation MAE as the noise floor.\n")
            else:
                L.append("\n**No form fit this column** — no trend model is offered for it.\n")

    if shape:
        gcol, xcol, ycol = trends["_shape_cols"]
        L.append(f"## 4. Normalized shape table — {ycol}(x) across `{gcol}` groups\n")
        L.append(f"Within each group, `{xcol}` is normalized to its observed span (x = fraction of span). "
                 f"Reference curve: median over {shape['n_groups']} groups; held-out validation on the last "
                 f"{shape['n_val_groups']} groups, MAE **{fmt(shape['val_mae'])}**"
                 + (f" (skipped {shape['n_skipped_groups']} groups with <4 points)" if shape["n_skipped_groups"] else "")
                 + ".\n")
        L.append(f"| x (span fraction) | {ycol}_ref | std |")
        L.append("|---|---|---|")
        for g, r, s in zip(shape["grid"], shape["ref"], shape["std"]):
            L.append(f"| {g:.3f} | {fmt(r)} | {fmt(s)} |")
        L.append("")

    L.append("## 5. Identifiability and honesty notes\n")
    L.append("- These are *predictive* fits, not mechanistic parameters: fitted constants have no certified physical "
             "meaning, and near-equal-quality fits with different forms exist — choose by held-out error, never by story quality.")
    L.append("- Point-exact predictions near a threshold can be off even when the trend is right: local non-monotonic "
             "events are not modeled.")
    if shape:
        L.append("- The shape table embeds the operating conditions of the observed runs; it does NOT transfer to other "
                 "conditions.")
    L.append("\n## 6. Re-verification\n")
    L.append("Every value above is recomputed from the raw CSV by a deterministic verify script at write time; "
             "per-item PASS/FAIL is shown on the pack page. Any quantitative claim derived from this pack can be "
             "checked by re-running it.\n")
    return "\n".join(L)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--csv", required=True)
    ap.add_argument("--spec", required=True)
    ap.add_argument("--out", required=True)
    a = ap.parse_args()

    with open(a.csv, "rb") as f:
        raw = f.read()
    csv_text = raw.decode("utf-8", errors="strict")
    sha = hashlib.sha256(raw).hexdigest()
    with open(a.spec) as f:
        spec = json.load(f)

    title = spec.get("title", "").strip()
    if not title:
        fail("spec.title required")
    cols = spec.get("columns", {})
    header, table = load_table(csv_text)
    for c in header:
        if c not in cols or cols[c].get("role") not in ("index", "value", "group", "x", "y", "ignore"):
            fail(f"Column '{c}' missing a valid role in spec")

    index_cols = [c for c in header if cols[c]["role"] == "index"]
    value_cols = [c for c in header if cols[c]["role"] == "value"]
    group_cols = [c for c in header if cols[c]["role"] == "group"]
    x_cols = [c for c in header if cols[c]["role"] == "x"]
    y_cols = [c for c in header if cols[c]["role"] == "y"]

    has_trend = len(index_cols) == 1 and len(value_cols) >= 1
    has_shape = len(group_cols) == 1 and len(x_cols) == 1 and len(y_cols) == 1
    has_group_trend = len(index_cols) == 0 and len(value_cols) >= 1 and has_shape
    if not has_trend and not has_shape:
        fail("Spec must define either (one index + >=1 value) columns or (one group + one x + one y) columns")

    n_rows = len(table[header[0]])
    if n_rows < MIN_ROWS:
        fail(f"Need >= {MIN_ROWS} data rows; got {n_rows}")

    trends = {}
    shape = None

    if has_trend:
        index_col = index_cols[0]
        k = table[index_col]
        order = np.argsort(k, kind="stable")
        k = k[order]
        if len(np.unique(k)) != len(k):
            fail(f"Index column '{index_col}' has duplicate values; trend fits need one row per index point")
        trends["_index"] = {"min": float(k[0]), "max": float(k[-1])}
        for c in value_cols:
            forms, best, fit_n, val_n = fit_trends(k, table[c][order])
            trends[c] = {"forms": forms, "best": best}
            trends["_split"] = [fit_n, val_n]
    elif has_group_trend:
        index_col = group_cols[0]
        gk = table[index_col]
        keys = np.unique(gk)
        if len(keys) < MIN_ROWS:
            fail(f"Need >= {MIN_ROWS} groups; got {len(keys)}")
        k = np.array([float(g) for g in keys])
        summ = {}
        for c in value_cols:
            vals = []
            for g in keys:
                v = table[c][gk == g]
                if not np.all(v == v[0]):
                    fail(f"Column '{c}' must be constant within each '{index_col}' group to use it as a per-group summary")
                vals.append(float(v[0]))
            summ[c] = np.array(vals)
        trends["_index"] = {"min": float(k[0]), "max": float(k[-1])}
        for c in value_cols:
            forms, best, fit_n, val_n = fit_trends(k, summ[c])
            trends[c] = {"forms": forms, "best": best}
            trends["_split"] = [fit_n, val_n]
    else:
        index_col = None

    if has_shape:
        gcol, xcol, ycol = group_cols[0], x_cols[0], y_cols[0]
        groups = {}
        for g in np.unique(table[gcol]):
            m = table[gcol] == g
            groups[float(g)] = (table[xcol][m], table[ycol][m])
        shape = build_shape(groups)
        trends["_shape_cols"] = [gcol, xcol, ycol]

    params = {
        "sha256": sha,
        "n_rows": n_rows,
        "spec": spec,
        "trends": {c: trends[c] for c in value_cols} if has_trend or has_group_trend else {},
        "index": trends.get("_index"),
        "split": trends.get("_split"),
        "shape": shape,
        "shape_cols": trends.get("_shape_cols"),
    }
    doc = render_doc(title, sha, n_rows, header, spec, trends, shape, index_col, value_cols, csv_text)

    with open(f"{a.out}/pack_params.json", "w") as f:
        json.dump(params, f, sort_keys=True, indent=1)
    with open(f"{a.out}/pack_doc.md", "w") as f:
        f.write(doc)
    print(json.dumps({"ok": True, "sha256": sha}))


if __name__ == "__main__":
    main()
