# MuPDF patches

Applied by `scripts/fetch_deps.sh` to the pinned MuPDF source (idempotent).

| Patch | Problem | Found by |
|---|---|---|
| `mupdf-1.28.6-inline-indexed-colorspace.patch` | Rewriting a content stream (redaction, text editing) serialised an inline image with an unnamed Indexed colour space (`BI /CS [/I /RGB 3 <...>]`) as `/CS/` (empty name), corrupting the page for other readers. The patch writes the colour space array inline, and raises an error instead of corrupting output for any other unnamed inline colour space. | Text-edit eval on `TAMReview.pdf` (Poppler: "Bad color space ''") |

When upgrading MuPDF, check whether upstream fixed each issue, then drop or rebase the patch.
