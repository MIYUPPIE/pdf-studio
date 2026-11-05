#!/usr/bin/env python3
"""Periodic quality eval: in-place text editing on real-world PDFs.

Outcome measured: "a user edits a line of existing text and gets exactly that
change, nothing else". For every sampled line we run the real engine (via
pdfedit-cli) to replace one word, then verify with an INDEPENDENT PDF
implementation (Poppler's pdftotext / pdftoppm), not our own engine:

  text_ok     new line text is extracted from the saved file
  old_gone    the replaced word no longer appears where it was (line text gone)
  others_ok   every other sampled line on the page is still extractable
  pixels_ok   rendering outside the edited line's area is unchanged
  valid       Poppler opens and renders the saved file without errors

An edit PASSES when all five hold. Also reported: how often the original
embedded font could be reused (visual fidelity), and time per edit.

Exit status 1 if the pass rate is below --threshold.
Usage: python3 evals/run_eval.py --cli build/native/pdfedit-cli [--threshold 0.95]
"""
import argparse
import json
import os
import re
import subprocess
import sys
import tempfile
import time
import unicodedata

import numpy as np
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
CORPUS = os.path.join(HERE, "corpus")
OUTDIR = os.path.join(HERE, "out")

MAX_PAGES = 2
DPI = 100
SCALE = DPI / 72.0
MAX_LINES_PER_PAGE = 6
WORD = re.compile(r"[A-Za-z]{4,}")


def norm(s):
    s = unicodedata.normalize("NFKC", s)
    return re.sub(r"\s+", " ", s).strip()


def squash(s):
    # Control characters count as whitespace: some PDFs' ToUnicode maps spaces
    # to e.g. U+0002, which Poppler then emits verbatim.
    return re.sub(r"[\s\x00-\x1f]+", "", unicodedata.normalize("NFKC", s))


def run_cli(cli, steps, tmp):
    script = os.path.join(tmp, "script.json")
    with open(script, "w") as f:
        json.dump({"steps": steps}, f)
    p = subprocess.run([cli, script], capture_output=True, text=True, timeout=120)
    return [json.loads(l) for l in p.stdout.splitlines() if l.strip()]


def pdftotext(path, page):
    p = subprocess.run(["pdftotext", "-f", str(page + 1), "-l", str(page + 1), "-layout", path, "-"],
                       capture_output=True, text=True, timeout=60)
    return p.returncode, p.stdout, p.stderr


def render(path, page, tmp, tag):
    base = os.path.join(tmp, tag)
    p = subprocess.run(["pdftoppm", "-f", str(page + 1), "-l", str(page + 1), "-r", str(DPI), "-png", "-singlefile", path, base],
                       capture_output=True, text=True, timeout=60)
    if p.returncode != 0:
        return None
    return np.asarray(Image.open(base + ".png").convert("L"), dtype=np.int16)


def neighbourhood(img, op):
    """3x3 min or max filter (numpy only)."""
    p = np.pad(img, 1, mode="edge")
    h, w = img.shape
    stack = [p[dy:dy + h, dx:dx + w] for dy in range(3) for dx in range(3)]
    return op(np.stack(stack), axis=0)


def changed_pixels(a, b, tol=40):
    """Pixels of b that differ from a by more than tol even allowing a 1px shift.
    Tolerates anti-aliasing/hinting differences from re-encoded but equivalent
    content; still catches missing, moved (>1px) or recoloured content."""
    lo, hi = neighbourhood(a, np.min), neighbourhood(a, np.max)
    out_b = (b < lo - tol) | (b > hi + tol)
    lo2, hi2 = neighbourhood(b, np.min), neighbourhood(b, np.max)
    out_a = (a < lo2 - tol) | (a > hi2 + tol)
    return out_a | out_b


def mutate(text):
    """Replace the longest word with a same-length-ish different word. Returns (new_text, old_word, new_word)."""
    words = WORD.findall(text)
    if not words:
        return None
    old = max(words, key=len)
    new = "Edited" if old.lower() != "edited" else "Changed"
    return text.replace(old, new, 1), old, new


def sample_lines(layout):
    lines = []
    for b in layout["blocks"]:
        for l in b["lines"]:
            t = l["text"].strip()
            if len(t) < 8 or not WORD.search(t) or l["wmode"] != 0:
                continue
            if abs(l["dir"][1]) > 0.01 and abs(l["dir"][0]) > 0.01:
                continue  # skip skewed text
            lines.append(l)
    # Deterministic spread over the page.
    if len(lines) > MAX_LINES_PER_PAGE:
        step = len(lines) / MAX_LINES_PER_PAGE
        lines = [lines[int(i * step)] for i in range(MAX_LINES_PER_PAGE)]
    return lines


def eval_file(cli, path, tmp):
    results = []
    name = os.path.basename(path)
    info = run_cli(cli, [{"method": "open", "args": {"name": name}, "in": path}], tmp)
    if not info or not info[0].get("ok"):
        return [{"file": name, "page": -1, "pass": False, "reason": "open failed: %s" % (info[0] if info else "")}]
    if info[0]["result"]["needsPassword"]:
        return []
    npages = min(MAX_PAGES, info[0]["result"]["pageCount"])
    for page in range(npages):
        lay = run_cli(cli, [{"method": "open", "args": {"name": name}, "in": path},
                            {"method": "textLayout", "args": {"page": page}}], tmp)
        if len(lay) < 2 or not lay[1]["ok"]:
            continue
        lines = sample_lines(lay[1]["result"])
        before_png = render(path, page, tmp, "before")
        _, base_txt, _ = pdftotext(path, page)
        base_flat = squash(base_txt)
        for line in lines:
            m = mutate(line["text"])
            if not m:
                continue
            new_text, old_word, new_word = m
            out = os.path.join(tmp, "edited.pdf")
            if os.path.exists(out):
                os.remove(out)
            t0 = time.time()
            res = run_cli(cli, [
                {"method": "open", "args": {"name": name}, "in": path},
                {"method": "replaceText", "args": {"page": page, "bbox": line["bbox"], "text": new_text}},
                {"method": "save", "args": {}, "out": out},
            ], tmp)
            dt = time.time() - t0
            r = {"file": name, "page": page, "line": line["text"], "new": new_text, "seconds": round(dt, 3)}
            if len(res) < 3 or not all(x["ok"] for x in res):
                err = next((x["error"] for x in res if not x["ok"]), "missing output")
                r.update({"pass": False, "reason": "engine error: %s" % err})
                results.append(r)
                continue
            r["usedOriginalFont"] = res[1]["result"]["usedOriginalFont"]
            r["font"] = res[1]["result"]["font"]

            code, txt, err = pdftotext(out, page)
            r["valid"] = code == 0 and "Syntax Error" not in err
            flat = squash(txt)
            # Word-level, relative to the unedited page: robust to readers that
            # split mixed-size text across output lines.
            nw_sq, ow_sq = squash(new_word), squash(old_word)
            r["text_ok"] = squash(new_text) in flat or flat.count(nw_sq) == base_flat.count(nw_sq) + 1
            # Compared against Poppler's extraction of the unedited page, so text
            # that repeats on the page or that Poppler never extracts is handled.
            old_sq = squash(line["text"])
            r["old_gone"] = flat.count(ow_sq) == base_flat.count(ow_sq) - 1 if ow_sq in base_flat else True
            others = [squash(l["text"]) for l in lines if l is not line]
            r["others_ok"] = all(o in flat for o in others if o != old_sq and o in base_flat and o not in old_sq)

            after_png = render(out, page, tmp, "after")
            if before_png is None or after_png is None or before_png.shape != after_png.shape:
                r["pixels_ok"] = False
                r["changed_outside"] = None
            else:
                x0, y0, x1, y1 = [v * SCALE for v in line["bbox"]]
                grow = (x1 - x0) * max(0.0, len(new_text) / max(1, len(line["text"])) - 1) * 1.5
                h, w = before_png.shape
                mask = np.ones_like(before_png, dtype=bool)
                pad = 3 * SCALE
                ya, yb = max(0, int(y0 - pad)), min(h, int(y1 + pad + 1))
                xa, xb = max(0, int(x0 - pad)), min(w, int(x1 + grow + pad + 1))
                mask[ya:yb, xa:xb] = False
                diff = changed_pixels(before_png, after_png)
                changed = int((diff & mask).sum())
                r["changed_outside"] = changed
                r["pixels_ok"] = changed <= max(20, int(0.0002 * mask.sum()))
            r["pass"] = all(r[k] for k in ("valid", "text_ok", "old_gone", "others_ok", "pixels_ok"))
            if not r["pass"]:
                r["reason"] = ",".join(k for k in ("valid", "text_ok", "old_gone", "others_ok", "pixels_ok") if not r[k])
            results.append(r)
    return results


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--cli", required=True)
    ap.add_argument("--threshold", type=float, default=0.95)
    args = ap.parse_args()
    if not os.path.isdir(CORPUS) or not os.listdir(CORPUS):
        sys.exit("empty corpus: run evals/fetch_corpus.sh")
    os.makedirs(OUTDIR, exist_ok=True)
    all_results = []
    with tempfile.TemporaryDirectory() as tmp:
        for f in sorted(os.listdir(CORPUS)):
            if f.lower().endswith(".pdf"):
                rs = eval_file(os.path.abspath(args.cli), os.path.join(CORPUS, f), tmp)
                p = sum(r["pass"] for r in rs)
                print(f"{f:28s} {p:3d}/{len(rs):<3d} edits pass")
                all_results.extend(rs)
    n = len(all_results)
    passed = sum(r["pass"] for r in all_results)
    orig = [r for r in all_results if "usedOriginalFont" in r]
    summary = {
        "edits": n,
        "passed": passed,
        "pass_rate": round(passed / n, 4) if n else 0,
        "original_font_reuse_rate": round(sum(r["usedOriginalFont"] for r in orig) / len(orig), 4) if orig else 0,
        "median_seconds_per_edit": float(np.median([r["seconds"] for r in all_results if "seconds" in r])) if n else 0,
        "threshold": args.threshold,
        "failures_by_reason": {},
    }
    for r in all_results:
        if not r["pass"]:
            for k in r.get("reason", "unknown").split(","):
                summary["failures_by_reason"][k] = summary["failures_by_reason"].get(k, 0) + 1
    with open(os.path.join(OUTDIR, "report.json"), "w") as f:
        json.dump({"summary": summary, "results": all_results}, f, indent=1, ensure_ascii=False)
    print(json.dumps(summary, indent=1))
    if summary["pass_rate"] < args.threshold:
        print(f"FAIL: pass rate {summary['pass_rate']} < threshold {args.threshold}")
        sys.exit(1)
    print("PASS")


if __name__ == "__main__":
    main()
