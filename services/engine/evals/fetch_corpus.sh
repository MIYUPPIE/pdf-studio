#!/usr/bin/env bash
# Build the eval corpus in evals/corpus/ (gitignored). Idempotent.
#  1. Real-world PDFs from public sources (LaTeX papers, government forms, tables, rotated pages).
#  2. Office-style PDFs generated locally with LibreOffice (embedded subset TrueType fonts,
#     which is what Word / Google Docs exports look like).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="$HERE/corpus"
mkdir -p "$OUT"

URLS=(
  https://raw.githubusercontent.com/mozilla/pdf.js/master/test/pdfs/tracemonkey.pdf
  https://raw.githubusercontent.com/mozilla/pdf.js/master/test/pdfs/TAMReview.pdf
  https://raw.githubusercontent.com/mozilla/pdf.js/master/test/pdfs/alphatrans.pdf
  https://raw.githubusercontent.com/mozilla/pdf.js/master/test/pdfs/asciihexdecode.pdf
  https://raw.githubusercontent.com/mozilla/pdf.js/master/test/pdfs/rotation.pdf
  https://raw.githubusercontent.com/mozilla/pdf.js/master/test/pdfs/issue1655r.pdf
  https://www.irs.gov/pub/irs-pdf/f1040.pdf
  https://www.irs.gov/pub/irs-pdf/fw9.pdf
  https://www.w3.org/WAI/WCAG21/working-examples/pdf-table/table.pdf
)
for u in "${URLS[@]}"; do
  f="$OUT/$(basename "$u")"
  [ -s "$f" ] && continue
  if curl -sfL -m 60 -o "$f" "$u" && head -c 5 "$f" | grep -q '%PDF'; then echo "fetched $(basename "$f")"; else echo "skip $(basename "$f")"; rm -f "$f"; fi
done

if command -v soffice >/dev/null; then
  GEN="$(mktemp -d)"
  cat > "$GEN/office-letter.html" <<'EOF'
<html><body style="font-family:'Liberation Serif'">
<h1 style="font-family:'Liberation Sans'">Quarterly Business Review</h1>
<p>Dear Partners, revenue for the third quarter increased to 4.2 million naira, driven by strong demand in Lagos and Abuja.</p>
<p><b>Highlights:</b> new customers grew by 18 percent, churn fell to 2.1 percent, and the support backlog was cleared.</p>
<p><i>Outlook:</i> we expect steady growth next quarter as the Ibadan branch opens in November.</p>
<p style="font-family:'Liberation Mono'">Reference: QBR-2026-Q3-0042</p>
<p>Sincerely,<br>Olayemi Ajiboye<br>Managing Director</p>
</body></html>
EOF
  cat > "$GEN/office-table.html" <<'EOF'
<html><body style="font-family:'Liberation Sans'">
<h2>Invoice 1042</h2>
<table border="1" cellpadding="4">
<tr><th>Item</th><th>Qty</th><th>Price</th></tr>
<tr><td>Website design</td><td>1</td><td>350,000</td></tr>
<tr><td>Hosting (12 months)</td><td>1</td><td>120,000</td></tr>
<tr><td>Training session</td><td>2</td><td>80,000</td></tr>
</table>
<p>Payment due within fourteen days of receipt.</p>
</body></html>
EOF
  for f in office-letter office-table; do
    [ -s "$OUT/$f.pdf" ] && continue
    (cd "$GEN" && soffice --headless --convert-to pdf:writer_pdf_Export "$f.html" --outdir "$OUT" >/dev/null 2>&1) && echo "generated $f.pdf" || echo "skip $f (soffice failed)"
  done
  rm -rf "$GEN"
fi
ls "$OUT" | wc -l | xargs echo "corpus files:"
