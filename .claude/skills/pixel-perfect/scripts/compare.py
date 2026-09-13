#!/usr/bin/env python3
"""
Pixel-level visual diff for pixel-perfect skill.

Compares reference.png vs actual.png:
  - Resizes both to the same size
  - Computes per-pixel match score
  - Produces a diff image (red = different pixels)
  - Finds the top divergence regions (for Claude to focus on)
  - Writes a markdown report

Usage:
  compare.py --reference REF --actual ACT --diff-out DIFF --report REPORT [--threshold 95] [--viewport 1440x900]
"""
import argparse
import json
import sys
from pathlib import Path


def ensure_deps():
    try:
        from PIL import Image, ImageChops, ImageFilter
        import numpy as np
        return Image, ImageChops, ImageFilter, np
    except ImportError:
        import subprocess
        subprocess.check_call([sys.executable, "-m", "pip", "install", "Pillow", "numpy", "--quiet"])
        from PIL import Image, ImageChops, ImageFilter
        import numpy as np
        return Image, ImageChops, ImageFilter, np


def parse_viewport(s):
    w, h = s.lower().split("x")
    return int(w), int(h)


def find_divergence_regions(diff_array, n=5, block=64):
    """Return top-N 64px grid blocks with highest diff density."""
    h, w = diff_array.shape[:2]
    regions = []
    for y in range(0, h, block):
        for x in range(0, w, block):
            patch = diff_array[y:y+block, x:x+block]
            score = float(patch.sum()) / patch.size
            regions.append((score, x, y, min(x+block, w), min(y+block, h)))
    regions.sort(reverse=True)
    top = []
    for score, x1, y1, x2, y2 in regions[:n]:
        if score > 0:
            top.append({"x1": x1, "y1": y1, "x2": x2, "y2": y2, "diff_density": round(score * 100, 1)})
    return top


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--reference", required=True)
    ap.add_argument("--actual", required=True)
    ap.add_argument("--diff-out", required=True)
    ap.add_argument("--report", required=True)
    ap.add_argument("--threshold", type=float, default=95.0)
    ap.add_argument("--viewport", default=None)
    args = ap.parse_args()

    Image, ImageChops, ImageFilter, np = ensure_deps()

    ref = Image.open(args.reference).convert("RGB")
    act = Image.open(args.actual).convert("RGB")

    # Normalise size — use reference size as canonical
    if args.viewport:
        w, h = parse_viewport(args.viewport)
        target = (w * 2, h * 2)   # 2x for retina screenshots from capture.py
    else:
        target = ref.size

    if ref.size != target:
        ref = ref.resize(target, Image.LANCZOS)
    if act.size != target:
        act = act.resize(target, Image.LANCZOS)

    # Pixel diff
    ref_arr = np.array(ref, dtype=np.int16)
    act_arr = np.array(act, dtype=np.int16)
    delta = np.abs(ref_arr - act_arr)             # per-channel absolute diff
    diff_mask = delta.max(axis=2) > 10            # tolerance: ignore ≤10 per channel

    total_pixels = diff_mask.size
    diff_pixels = int(diff_mask.sum())
    match_pct = round((1 - diff_pixels / total_pixels) * 100, 2)

    # Diff image — white base, red where different
    diff_img = Image.new("RGB", target, (255, 255, 255))
    diff_arr = np.zeros((*target[::-1], 3), dtype=np.uint8)
    diff_arr[diff_mask] = [255, 0, 0]
    diff_overlay = Image.fromarray(diff_arr, "RGB")

    # Blend: original image dimmed + red highlight
    faded_act = act.point(lambda p: int(p * 0.35))
    diff_img = Image.blend(faded_act, diff_overlay, alpha=0.65)
    diff_img.save(args.diff_out)
    print(f"Diff image saved → {args.diff_out}")

    # Find hot regions
    regions = find_divergence_regions(diff_mask.astype(np.uint8))

    # Verdict
    if match_pct >= args.threshold:
        verdict = "pass"
    elif match_pct >= 85:
        verdict = "warning"
    else:
        verdict = "fail"

    # Report
    report_lines = [
        f"# Visual Diff Report",
        f"",
        f"## Score",
        f"- **Pixel match:** {match_pct}%",
        f"- **Differing pixels:** {diff_pixels:,} / {total_pixels:,}",
        f"- **Verdict:** {verdict}",
        f"- **Threshold:** {args.threshold}%",
        f"",
        f"## Inputs",
        f"- Reference: `{args.reference}`",
        f"- Actual:    `{args.actual}`",
        f"- Diff:      `{args.diff_out}`",
        f"",
    ]

    if regions:
        report_lines += [
            f"## Top Divergence Regions",
            f"",
            f"Claude: focus your semantic review on these areas first.",
            f"",
        ]
        for i, r in enumerate(regions, 1):
            report_lines.append(
                f"- Region {i}: ({r['x1']}, {r['y1']}) → ({r['x2']}, {r['y2']})  diff_density={r['diff_density']}%"
            )
    else:
        report_lines.append("## Top Divergence Regions\n\nNone — images are visually identical.")

    report_lines += [
        f"",
        f"---",
        f"",
        f"## Instructions for Claude",
        f"",
        f"Read `{args.reference}` and `{args.actual}` with the Read tool.",
        f"Examine the regions above and describe concretely what differs.",
        f"Then produce a Fix List (see compare.md format).",
    ]

    Path(args.report).write_text("\n".join(report_lines))
    print(f"Report saved → {args.report}")

    # Machine-readable summary on stdout for easy parsing
    summary = {
        "match_pct": match_pct,
        "verdict": verdict,
        "diff_pixels": diff_pixels,
        "total_pixels": total_pixels,
        "regions": regions,
    }
    print(json.dumps(summary))


if __name__ == "__main__":
    main()
