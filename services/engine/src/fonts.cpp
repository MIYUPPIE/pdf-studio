// Lazy fallback fonts.
//
// The browser build compiles MuPDF without its Noto/SIL/CJK fonts (-DTOFU
// -DTOFU_CJK) to keep the wasm small. When text needs a script the built-in
// base-14 fonts cannot draw (Yoruba/Vietnamese Latin, Arabic, Devanagari, CJK,
// ...), MuPDF calls our "system fallback font" hook; we pick the same font file
// MuPDF would have used (table generated from its font-table.h) and ask the host
// for its bytes. The host (web worker / node / native test) implements
// FontProvider.
#include <map>
#include <mutex>

#include "impl.hpp"

extern "C" {
#include "mupdf/ucdn.h"
}

namespace pdfedit {

namespace {

// Same private script codes as MuPDF's noto.c.
enum {
    MUPDF_SCRIPT_MUSIC = UCDN_LAST_SCRIPT + 1,
    MUPDF_SCRIPT_MATH,
    MUPDF_SCRIPT_SYMBOLS,
    MUPDF_SCRIPT_SYMBOLS2,
    MUPDF_SCRIPT_EMOJI,
    MUPDF_SCRIPT_CJKV
};

#define ANY_SCRIPT -1
#define REGULAR 0
#define BOLD 1
#define ITALIC 2

struct FontRow {
    const char* file;
    const char* family;
    int script;
    int lang;
    int subfont;
    int attr;
};

const FontRow kRows[] = {
#include "font_map.inc"
};

FontProvider& provider() {
    static FontProvider p;
    return p;
}

// Bytes are shared across documents (each Engine has its own fz_context).
std::map<std::string, std::shared_ptr<Bytes>>& cache() {
    static std::map<std::string, std::shared_ptr<Bytes>> c;
    return c;
}

std::shared_ptr<Bytes> fetch(const std::string& file) {
    auto& c = cache();
    auto it = c.find(file);
    if (it != c.end()) return it->second;
    std::shared_ptr<Bytes> b;
    if (provider()) {
        try {
            auto got = provider()(file);
            if (got && !got->empty()) b = std::make_shared<Bytes>(std::move(*got));
        } catch (...) {
            b.reset();
        }
    }
    c[file] = b;  // remember misses too: never re-request a missing font
    return b;
}

// Called by MuPDF inside its own fz_try: may fz_throw, must not throw C++.
fz_font* load_from_row(fz_context* ctx, const FontRow& row) {
    std::shared_ptr<Bytes> bytes = fetch(row.file);
    if (!bytes) return nullptr;
    fz_buffer* buf = fz_new_buffer_from_shared_data(ctx, (const unsigned char*)bytes->data(), bytes->size());
    fz_font* font = nullptr;
    fz_try(ctx) { font = fz_new_font_from_buffer(ctx, row.family, buf, row.subfont, 0); }
    fz_always(ctx) { fz_drop_buffer(ctx, buf); }
    fz_catch(ctx) {
        fz_ignore_error(ctx);
        font = nullptr;
    }
    return font;
}

fz_font* fallback_hook(fz_context* ctx, int script, int language, int serif, int bold, int italic) {
    int want = (bold ? BOLD : 0) | (italic ? ITALIC : 0);
    const FontRow* best = nullptr;
    int best_score = -1;
    for (const FontRow& r : kRows) {
        if (r.script != script) continue;
        int score = 0;
        if (r.lang == language) score += 4;
        else if (r.lang != FZ_LANG_UNSET) continue;
        if (r.attr == want) score += 2;
        else if (r.attr == REGULAR) score += 1;
        else continue;
        if (score > best_score) best = &r, best_score = score;
    }
    return best ? load_from_row(ctx, *best) : nullptr;
}

fz_font* cjk_hook(fz_context* ctx, const char* name, int ordering, int serif) {
    for (const FontRow& r : kRows)
        if (r.script == UCDN_SCRIPT_HAN) return load_from_row(ctx, r);
    return nullptr;
}

}  // namespace

void set_font_provider(FontProvider p) {
    provider() = std::move(p);
    cache().clear();
}

void install_font_hooks(fz_context* ctx) {
    if (provider()) fz_install_load_system_font_funcs(ctx, nullptr, cjk_hook, fallback_hook);
}

}  // namespace pdfedit
