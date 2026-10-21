#!/usr/bin/env python3
"""
Analyse datasets exported by the QR Multiplex Lab receiver
(https://amro2021.github.io/qr-transfer/multi/ -> Receive -> Download dataset).

Usage
    python analyze_qr_lab.py dataset1.zip [dataset2.zip | folder ...] [-o results]

Several datasets (for example one per receiving phone) can be combined; run ids are
prefixed with the dataset number so they stay unique.

Outputs (in the results folder)
    fig_*.pdf / fig_*.png      figures sized for a single journal column (3.5 in)
    summary_by_scheme.csv/.tex one row per scheme and distance: mean +/- 95 % CI
    summary_by_stream.csv      one row per scheme, distance and stream class
    METHODS.md                 metric definitions and dataset size, for a methods section

Requires: pandas, numpy, scipy, matplotlib
"""
import argparse, io, sys, zipfile
from pathlib import Path

import numpy as np
import pandas as pd
from scipy import stats
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

TABLES = ["runs", "slots", "files", "frames", "qrs"]
CLASS_COLORS = {"Red": "#c62828", "Green": "#2e7d32", "Blue": "#1565c0", "B/W": "#212121",
                "Base layer": "#e07b00", "Enhancement layer": "#6a1b9a"}
MARKERS = ["o", "s", "^", "D", "v", "P", "X", "*"]

plt.rcParams.update({
    "font.family": "serif", "font.size": 8, "axes.titlesize": 8, "axes.labelsize": 8,
    "legend.fontsize": 7, "xtick.labelsize": 7, "ytick.labelsize": 7, "lines.linewidth": 1.1,
    "lines.markersize": 4, "axes.grid": True, "grid.alpha": 0.3, "grid.linewidth": 0.5,
    "savefig.bbox": "tight", "savefig.dpi": 300, "figure.dpi": 150,
})
FIG_W, FIG_H = 3.5, 2.5


# ---------------------------------------------------------------- loading
def read_dataset(path):
    p = Path(path)
    out = {}
    if p.is_dir():
        for t in TABLES:
            f = p / f"{t}.csv"
            out[t] = pd.read_csv(f) if f.exists() else pd.DataFrame()
    else:
        with zipfile.ZipFile(p) as z:
            names = {Path(n).name: n for n in z.namelist()}
            for t in TABLES:
                n = names.get(f"{t}.csv")
                out[t] = pd.read_csv(io.BytesIO(z.read(n))) if n else pd.DataFrame()
    return out


def load(paths):
    merged = {t: [] for t in TABLES}
    for i, path in enumerate(paths, 1):
        d = read_dataset(path)
        for t in TABLES:
            df = d[t].copy()
            if len(df) and "run_id" in df:
                df["run"] = df["run_id"].map(lambda r: f"{i}-{r}")
                df["dataset"] = Path(path).name
            merged[t].append(df)
    data = {t: pd.concat(v, ignore_index=True) if v else pd.DataFrame() for t, v in merged.items()}
    if data["runs"].empty:
        sys.exit("No runs found in the given dataset(s).")
    return data


def stream_class(slot):
    slot = str(slot)
    if slot in ("b", "base"):
        return "Base layer"
    if slot in ("e", "enh"):
        return "Enhancement layer"
    return {"R": "Red", "G": "Green", "B": "Blue", "L": "B/W"}.get(slot[:1], slot)


# ---------------------------------------------------------------- statistics
def mean_ci(x):
    """mean and half-width of a 95 % t confidence interval (nan when n < 2)."""
    x = pd.to_numeric(pd.Series(x), errors="coerce").dropna()
    n = len(x)
    if n == 0:
        return np.nan, np.nan, 0
    m = x.mean()
    if n < 2:
        return m, np.nan, n
    h = stats.t.ppf(0.975, n - 1) * x.std(ddof=1) / np.sqrt(n)
    return m, h, n


def fmt(m, h, digits=3, pct=False):
    if np.isnan(m):
        return "–"
    k = 100 if pct else 1
    s = f"{m * k:.{digits}g}"
    return s + (f" ± {h * k:.{2}g}" if not np.isnan(h) else "")


# ---------------------------------------------------------------- derived tables
def per_run_stream(data):
    """frame loss, success rate and module error rate per run and stream class."""
    sl = data["slots"].copy()
    if sl.empty:
        return pd.DataFrame()
    sl["cls"] = sl["slot"].map(stream_class)
    g = sl.groupby(["run", "cls"])
    df = pd.DataFrame({
        "frame_loss": g["frame_loss"].mean(),
        "success": g["success_per_processed_frame"].mean(),
        "modules": g["modules_measured"].sum(),
        "module_errors": g["module_errors"].sum(),
        "qr_reads": g["qr_reads"].sum(),
    }).reset_index()
    df["mer"] = np.where(df["modules"] > 0, df["module_errors"] / df["modules"].where(df["modules"] > 0), np.nan)
    return df.merge(data["runs"][["run", "scheme", "distance_m"]], on="run", how="left")


def per_run(data):
    r = data["runs"].copy()
    f = data["files"].copy()
    if not f.empty:
        f["done"] = f["complete_s"].notna()
        agg = f.groupby("run").agg(files=("file_id", "count"), files_done=("done", "sum"),
                                   complete_max=("complete_s", "max"), overhead_mean=("overhead", "mean"))
        r = r.merge(agg, on="run", how="left")
    return r


# ---------------------------------------------------------------- figures
def save(fig, out, name):
    for ext in ("pdf", "png"):
        fig.savefig(out / f"{name}.{ext}")
    plt.close(fig)
    print(f"  wrote {name}.pdf/.png")


def line_by_distance(ax, df, ycol, label, color=None, marker="o", scale=1.0, logy=False):
    rows = []
    for d, g in df.dropna(subset=["distance_m"]).groupby("distance_m"):
        m, h, n = mean_ci(g[ycol])
        if not np.isnan(m):
            rows.append((d, m * scale, (h if not np.isnan(h) else 0) * scale))
    if not rows:
        return False
    rows.sort()
    x, y, e = map(np.array, zip(*rows))
    if logy:
        pos = y > 0
        lo = np.minimum(e, y * 0.9)                      # keep the lower bar above zero on a log axis
        ax.errorbar(x[pos], y[pos], yerr=[lo[pos], e[pos]], label=label, color=color, marker=marker,
                    capsize=2, elinewidth=0.7)
        if (~pos).any():                                 # zero measured errors: open marker on the floor
            ax._zero_pts = getattr(ax, "_zero_pts", []) + [(x[~pos], color, marker)]
    else:
        ax.errorbar(x, y, yerr=e, label=label, color=color, marker=marker, capsize=2, elinewidth=0.7)
    return True


def draw_zero_floor(ax):
    pts = getattr(ax, "_zero_pts", [])
    if not pts:
        return
    lo = ax.get_ylim()[0] if ax.has_data() else 1e-5
    floor = lo * 1.15
    for i, (xs, color, marker) in enumerate(pts):
        ax.scatter(xs, np.full(len(xs), floor), marker=marker, facecolors="none", edgecolors=color, zorder=3,
                   label="no errors measured" if i == 0 else None)
    ax.legend(loc="best", frameon=False)


def fig_stream_metric(prs, out, ycol, ylabel, name, scale=1.0, logy=False):
    schemes = [s for s in prs["scheme"].dropna().unique()]
    if not schemes:
        return
    fig, axes = plt.subplots(len(schemes), 1, figsize=(FIG_W, FIG_H * 0.8 * len(schemes)), sharex=True, squeeze=False)
    for ax, sch in zip(axes[:, 0], schemes):
        sub = prs[prs["scheme"] == sch]
        drew = False
        for i, (cls, g) in enumerate(sub.groupby("cls")):
            drew |= line_by_distance(ax, g, ycol, cls, CLASS_COLORS.get(cls), MARKERS[i % len(MARKERS)], scale, logy)
        ax.set_title(sch)
        ax.set_ylabel(ylabel)
        if logy and drew:
            ax.set_yscale("log")
            if getattr(ax, "_zero_pts", None) and not ax.lines:
                ax.set_ylim(1e-5, 1e-1)
        if drew:
            ax.legend(loc="best", frameon=False)
        if logy:
            draw_zero_floor(ax)
    axes[-1, 0].set_xlabel("Distance to screen (m)")
    save(fig, out, name)


def fig_run_metric(runs, out, ycol, ylabel, name):
    sub = runs.dropna(subset=[ycol, "distance_m"])
    if sub.empty:
        return
    fig, ax = plt.subplots(figsize=(FIG_W, FIG_H))
    for i, (sch, g) in enumerate(sub.groupby("scheme")):
        line_by_distance(ax, g, ycol, sch, None, MARKERS[i % len(MARKERS)])
    ax.set_xlabel("Distance to screen (m)")
    ax.set_ylabel(ylabel)
    ax.legend(frameon=False)
    save(fig, out, name)


def fig_overhead(data, out):
    f = data["files"].dropna(subset=["overhead"]).merge(data["runs"][["run", "scheme"]], on="run")
    if f.empty:
        return
    groups = [(s, g["overhead"].values * 100) for s, g in f.groupby("scheme")]
    fig, ax = plt.subplots(figsize=(FIG_W, FIG_H))
    ax.boxplot([g for _, g in groups], showmeans=True, widths=0.5)
    ax.set_xticks(range(1, len(groups) + 1), [s for s, _ in groups], rotation=20, ha="right")
    ax.set_ylabel("Reception overhead ε (%)")
    save(fig, out, "fig_overhead")


def fig_progress(data, out):
    fr, files, runs = data["frames"], data["files"], data["runs"]
    if fr.empty or files.empty:
        return
    ktot = files.groupby("run")["K"].sum()
    schemes = runs["scheme"].dropna().unique()
    fig, axes = plt.subplots(len(schemes), 1, figsize=(FIG_W, FIG_H * 0.8 * len(schemes)), sharex=True, squeeze=False)
    dists = runs["distance_m"].dropna()
    norm = plt.Normalize(dists.min(), dists.max()) if len(dists) else None
    cmap = plt.get_cmap("viridis")
    for ax, sch in zip(axes[:, 0], schemes):
        for _, r in runs[runs["scheme"] == sch].iterrows():
            g = fr[fr["run"] == r["run"]]
            K = ktot.get(r["run"], np.nan)
            if g.empty or not K:
                continue
            c = cmap(norm(r["distance_m"])) if norm is not None and pd.notna(r["distance_m"]) else "gray"
            ax.plot(g["t_ms"] / 1000, g["blocks_recovered_total"] / K, color=c, lw=0.8, alpha=0.85)
        ax.set_title(sch)
        ax.set_ylabel("Blocks recovered")
        ax.set_ylim(0, 1.05)
    axes[-1, 0].set_xlabel("Time from run start (s)")
    if norm is not None:
        sm = plt.cm.ScalarMappable(norm=norm, cmap=cmap)
        fig.colorbar(sm, ax=axes[:, 0].tolist(), label="Distance (m)", shrink=0.8)
    save(fig, out, "fig_progress")


# ---------------------------------------------------------------- tables
def tables(runs, prs, out):
    rows = []
    for (sch, d), g in runs.groupby(["scheme", "distance_m"], dropna=False):
        fl = mean_ci(g["mean_frame_loss"])
        mer = mean_ci(g["mer_pooled"])
        ct = mean_ci(g["max_complete_s"])
        gp = mean_ci(g["total_goodput_Bps"])
        ov = mean_ci(g.get("overhead_mean", pd.Series(dtype=float)))
        rows.append({"scheme": sch, "distance_m": d, "runs": len(g),
                     "frame_loss_mean": fl[0], "frame_loss_ci95": fl[1],
                     "mer_mean": mer[0], "mer_ci95": mer[1],
                     "completion_s_mean": ct[0], "completion_s_ci95": ct[1],
                     "goodput_Bps_mean": gp[0], "goodput_Bps_ci95": gp[1],
                     "overhead_mean": ov[0],
                     "files_done": int(g["files_done"].sum()) if "files_done" in g else np.nan,
                     "files_seen": int(g["files_seen"].sum())})
    summ = pd.DataFrame(rows).sort_values(["scheme", "distance_m"])
    summ.to_csv(out / "summary_by_scheme.csv", index=False)

    tex = ["\\begin{tabular}{llrlllll}", "\\hline",
           "Scheme & $d$ (m) & $n$ & Frame loss (\\%) & MER & $T_c$ (s) & Goodput (B/s) & $\\varepsilon$ (\\%) \\\\", "\\hline"]
    for _, r in summ.iterrows():
        d = "–" if pd.isna(r.distance_m) else f"{r.distance_m:g}"
        mer = "–" if np.isnan(r.mer_mean) else f"{r.mer_mean:.2e}"
        tex.append(f"{r.scheme} & {d} & {r.runs} & {fmt(r.frame_loss_mean, r.frame_loss_ci95, 3, True)} & {mer} & "
                   f"{fmt(r.completion_s_mean, r.completion_s_ci95)} & {fmt(r.goodput_Bps_mean, r.goodput_Bps_ci95)} & "
                   f"{fmt(r.overhead_mean, np.nan, 3, True)} \\\\")
    tex += ["\\hline", "\\end{tabular}"]
    (out / "summary_by_scheme.tex").write_text("\n".join(tex).replace("±", "$\\pm$").replace("–", "--") + "\n")

    if not prs.empty:
        srows = []
        for (sch, d, cls), g in prs.groupby(["scheme", "distance_m", "cls"], dropna=False):
            fl, sc, mer = mean_ci(g["frame_loss"]), mean_ci(g["success"]), mean_ci(g["mer"])
            pooled = g["module_errors"].sum() / g["modules"].sum() if g["modules"].sum() else np.nan
            srows.append({"scheme": sch, "distance_m": d, "stream": cls, "runs": len(g),
                          "frame_loss_mean": fl[0], "frame_loss_ci95": fl[1],
                          "success_per_frame_mean": sc[0], "success_per_frame_ci95": sc[1],
                          "mer_mean": mer[0], "mer_ci95": mer[1], "mer_pooled": pooled,
                          "modules_measured": int(g["modules"].sum()), "qr_reads": int(g["qr_reads"].sum())})
        pd.DataFrame(srows).sort_values(["scheme", "distance_m", "stream"]).to_csv(out / "summary_by_stream.csv", index=False)
    print("  wrote summary_by_scheme.csv/.tex, summary_by_stream.csv")
    return summ


def methods(data, runs, out):
    q, fr = data["qrs"], data["frames"]
    devices = runs["device"].fillna("").str.slice(0, 60).nunique() if "device" in runs else 0
    txt = f"""# Measurement summary

Dataset: {len(runs)} runs, {len(fr)} processed camera frames, {len(q)} QR codes read,
{int(q['modules'].notna().sum()) if 'modules' in q else 0} codes with raw module-error measurements,
{devices} receiving device(s). Schemes: {', '.join(sorted(runs['scheme'].dropna().unique()))}.

## Metric definitions

* **Frame loss** (per stream): every QR code carries the sender frame counter k. For a stream,
  frame loss = 1 − (distinct k read) / (k_max − k_min + 1), averaged over the streams of a run.
  It includes sender frames the camera never sampled; compare the receiver processing rate
  (runs.proc_fps) with the sender frame rate (runs.sender_fps).
* **Success per processed frame**: fraction of processed camera frames in which the stream was read.
* **Module error rate (MER)**: the decoded text is re-encoded with the same QR library and
  error-correction level as the sender, which reproduces the transmitted module matrix exactly; each
  module centre of the binary image given to the decoder is compared with it. This is a raw,
  pre-Reed–Solomon symbol error rate, conditional on the code having been located and decoded.
* **Completion time T_c**: time from the first QR code of a file to its SHA-256-verified reconstruction
  (maximum over the files of a run).
* **Goodput**: delivered file bytes / T_c.
* **Reception overhead ε**: (unique packets needed) / K − 1 for the LT fountain code (Robust Soliton,
  c = 0.1, δ = 0.5, systematic first K packets).
* Confidence intervals: 95 % Student-t intervals over repeated runs at the same scheme and distance.
"""
    (out / "METHODS.md").write_text(txt)
    print("  wrote METHODS.md")


# ---------------------------------------------------------------- results page
FIG_CAPTIONS = [
    ("fig_frame_loss_by_stream", "Frame loss per stream vs distance (mean ± 95 % CI over runs)."),
    ("fig_module_error_rate", "Raw module error rate before QR error correction. Open markers: no errors measured."),
    ("fig_success_per_frame", "Share of processed camera frames in which each stream was read."),
    ("fig_completion_time", "Time from the first QR code to a verified file."),
    ("fig_goodput", "Delivered bytes per second."),
    ("fig_overhead", "LT fountain reception overhead ε per completed file."),
    ("fig_progress", "Fraction of blocks recovered over time, one line per run."),
]


def write_index(out, runs, data, sources):
    import html, datetime
    figs = "".join(
        f'<figure><a href="{n}.pdf"><img src="{n}.png" alt="{html.escape(c)}" loading="lazy"></a><figcaption>{html.escape(c)}</figcaption></figure>'
        for n, c in FIG_CAPTIONS if (out / f"{n}.png").exists())
    summ = pd.read_csv(out / "summary_by_scheme.csv")
    cols = ["scheme", "distance_m", "runs", "frame_loss_mean", "mer_mean", "completion_s_mean", "goodput_Bps_mean"]
    head = "".join(f"<th>{c}</th>" for c in ["Scheme", "Distance (m)", "Runs", "Frame loss", "Module errors", "Completion (s)", "Goodput (B/s)"])
    def cell(c, v):
        if pd.isna(v):
            return "<td>–</td>"
        if c == "frame_loss_mean":
            return f'<td class="n">{v * 100:.1f} %</td>'
        if c == "mer_mean":
            return f'<td class="n">{v:.1e}</td>'
        return f'<td class="n">{v:.4g}</td>' if isinstance(v, (int, float, np.number)) else f"<td>{html.escape(str(v))}</td>"
    body = "".join("<tr>" + "".join(cell(c, r[c]) for c in cols) + "</tr>" for _, r in summ.iterrows())
    page = f"""<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>QR Lab Results</title><style>
:root{{--bg:#f3f5f7;--fg:#14181d;--muted:#5d6874;--line:#d9dee4;--card:#fff;--acc:#0a62b8}}
@media (prefers-color-scheme:dark){{:root{{--bg:#0f1317;--fg:#e6eaee;--muted:#95a0ab;--line:#2a323b;--card:#171c22;--acc:#4f9cf0;color-scheme:dark}}}}
body{{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 Georgia,"Times New Roman",serif}}
main{{max-width:1100px;margin:0 auto;padding:20px max(16px,env(safe-area-inset-right)) 48px max(16px,env(safe-area-inset-left))}}
h1{{font-size:24px;margin:0 0 4px}} p{{color:var(--muted);margin:0 0 16px}} a{{color:var(--acc)}}
.grid{{display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:14px}}
figure{{margin:0;background:#fff;border:1px solid var(--line);border-radius:10px;padding:8px}}
figure img{{width:100%;height:auto;display:block}} figcaption{{color:#444;font-size:13px;padding:6px 4px 0}}
.wrap{{overflow-x:auto;border:1px solid var(--line);border-radius:10px;margin:16px 0;background:var(--card)}}
table{{border-collapse:collapse;width:100%;font-size:13px}} th,td{{padding:6px 9px;border-bottom:1px solid var(--line);text-align:left;white-space:nowrap}}
td.n{{text-align:right;font-variant-numeric:tabular-nums}} ul{{padding-left:20px}}
</style></head><body><main>
<h1>QR Lab Results</h1>
<p>{len(runs)} runs, {len(data['frames'])} processed frames and {len(data['qrs'])} QR reads from {len(sources)} dataset file(s).
Updated {datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%d %H:%M UTC')}.</p>
<div class="wrap"><table><thead><tr>{head}</tr></thead><tbody>{body}</tbody></table></div>
<div class="grid">{figs}</div>
<h2 style="font-size:18px;margin-top:24px">Files</h2>
<ul><li><a href="summary_by_scheme.csv">summary_by_scheme.csv</a> · <a href="summary_by_scheme.tex">summary_by_scheme.tex</a></li>
<li><a href="summary_by_stream.csv">summary_by_stream.csv</a></li><li><a href="METHODS.md">METHODS.md</a> (metric definitions)</li>
<li>Figures as PDF: tap any figure.</li></ul>
</main></body></html>"""
    (out / "index.html").write_text(page)
    print("  wrote index.html")


def write_readme(out, runs, data, sources):
    import datetime
    summ = pd.read_csv(out / "summary_by_scheme.csv")
    lines = ["# QR Lab Results", "",
             f"{len(runs)} runs, {len(data['frames'])} processed frames and {len(data['qrs'])} QR reads from "
             f"{len(sources)} dataset file(s). Updated {datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%d %H:%M UTC')}.", "",
             "| Scheme | Distance (m) | Runs | Frame loss | Module errors | Completion (s) | Goodput (B/s) |",
             "|---|---:|---:|---:|---:|---:|---:|"]
    f = lambda v, k: "–" if pd.isna(v) else (f"{v * 100:.1f} %" if k == "fl" else f"{v:.1e}" if k == "mer" else f"{v:.4g}")
    for _, r in summ.iterrows():
        lines.append(f"| {r.scheme} | {f(r.distance_m, '')} | {r.runs} | {f(r.frame_loss_mean, 'fl')} | {f(r.mer_mean, 'mer')} | "
                     f"{f(r.completion_s_mean, '')} | {f(r.goodput_Bps_mean, '')} |")
    lines.append("")
    for n, c in FIG_CAPTIONS:
        if (out / f"{n}.png").exists():
            lines += [f"### {c}", "", f"![{c}]({n}.png)", "", f"[PDF]({n}.pdf)", ""]
    lines += ["Tables: [summary_by_scheme.csv](summary_by_scheme.csv) · [summary_by_scheme.tex](summary_by_scheme.tex) · "
              "[summary_by_stream.csv](summary_by_stream.csv) · [METHODS.md](METHODS.md)", ""]
    (out / "README.md").write_text("\n".join(lines))
    print("  wrote README.md")


# ---------------------------------------------------------------- main
def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("datasets", nargs="+", help="dataset .zip files or extracted folders")
    ap.add_argument("-o", "--out", default="results", help="output folder (default: results)")
    a = ap.parse_args()
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)

    data = load(a.datasets)
    runs = per_run(data)
    runs["distance_m"] = pd.to_numeric(runs["distance_m"], errors="coerce")
    prs = per_run_stream(data)
    if not prs.empty:
        prs["distance_m"] = pd.to_numeric(prs["distance_m"], errors="coerce")

    print(f"Loaded {len(runs)} runs from {len(a.datasets)} dataset(s). Writing to {out}/")
    if not prs.empty:
        fig_stream_metric(prs, out, "frame_loss", "Frame loss (%)", "fig_frame_loss_by_stream", scale=100)
        fig_stream_metric(prs, out, "mer", "Raw module error rate", "fig_module_error_rate", logy=True)
        fig_stream_metric(prs, out, "success", "Read per processed frame (%)", "fig_success_per_frame", scale=100)
    fig_run_metric(runs, out, "max_complete_s", "Completion time (s)", "fig_completion_time")
    fig_run_metric(runs, out, "total_goodput_Bps", "Goodput (B/s)", "fig_goodput")
    fig_overhead(data, out)
    fig_progress(data, out)
    summ = tables(runs, prs, out)
    methods(data, runs, out)
    write_index(out, runs, data, a.datasets)
    write_readme(out, runs, data, a.datasets)

    print("\nSummary by scheme and distance")
    view = summ[["scheme", "distance_m", "runs", "frame_loss_mean", "mer_mean", "completion_s_mean", "goodput_Bps_mean"]]
    print(view.to_string(index=False, float_format=lambda v: f"{v:.4g}"))


if __name__ == "__main__":
    main()
