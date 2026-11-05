// Text layout, search, editing existing text, adding text/images, redaction.
#include <algorithm>
#include <cctype>
#include <cmath>
#include <cstring>
#include <map>

#include "impl.hpp"

namespace pdfedit {

namespace {

// Structured text of the page *content only* (annotations and widgets are
// excluded: their text is edited through the annotation/field APIs).
mu::STextPage content_stext(Engine::Impl& E, pdf_page* page) {
    fz_context* ctx = E.ctx;
    fz_rect bounds = mu::call(ctx, pdf_bound_page, page, FZ_CROP_BOX);
    mu::STextPage st(ctx, mu::call(ctx, fz_new_stext_page, bounds));
    fz_stext_options opts;
    std::memset(&opts, 0, sizeof opts);
    opts.flags = FZ_STEXT_CLIP | FZ_STEXT_PRESERVE_WHITESPACE;
    mu::Device dev(ctx, mu::call(ctx, fz_new_stext_device, st.get(), (const fz_stext_options*)&opts));
    mu::call(ctx, pdf_run_page_contents, page, dev.get(), fz_identity, (fz_cookie*)nullptr);
    mu::call(ctx, fz_close_device, dev.get());
    return st;
}

std::string utf8_of(int c) {
    char buf[8];
    int n = fz_runetochar(buf, c);
    return std::string(buf, n);
}

std::string clean_font_name(const char* name) {
    std::string s = name ? name : "";
    // Strip subset tag "ABCDEF+".
    if (s.size() > 7 && s[6] == '+' &&
        std::all_of(s.begin(), s.begin() + 6, [](char ch) { return ch >= 'A' && ch <= 'Z'; }))
        s = s.substr(7);
    return s;
}

std::string lower(std::string s) {
    for (auto& ch : s) ch = (char)std::tolower((unsigned char)ch);
    return s;
}

struct Style {
    bool bold = false, italic = false, serif = false, mono = false;
};

Style font_style(fz_context* ctx, fz_font* font, bool bold_flag) {
    Style st;
    std::string n = lower(clean_font_name(fz_font_name(ctx, font)));
    auto has = [&](const char* k) { return n.find(k) != std::string::npos; };
    st.bold = bold_flag || fz_font_is_bold(ctx, font) || has("bold") || has("black") || has("heavy") || has("semibold") ||
              has("demi");
    st.italic = fz_font_is_italic(ctx, font) || has("italic") || has("oblique");
    st.mono = fz_font_is_monospaced(ctx, font) || has("courier") || has("mono") || has("consol");
    st.serif = !st.mono && (fz_font_is_serif(ctx, font) || has("times") || has("serif") || has("roman") ||
                            has("georgia") || has("garamond") || has("cambria") || has("minion") ||
                            has("cmr") || has("nimbusrom") || has("palatino") || has("book"));
    if (has("sans")) st.serif = false;
    return st;
}

std::string standard_font_for(const Style& st) {
    if (st.mono) {
        if (st.bold && st.italic) return "Courier-BoldOblique";
        if (st.bold) return "Courier-Bold";
        if (st.italic) return "Courier-Oblique";
        return "Courier";
    }
    if (st.serif) {
        if (st.bold && st.italic) return "Times-BoldItalic";
        if (st.bold) return "Times-Bold";
        if (st.italic) return "Times-Italic";
        return "Times-Roman";
    }
    if (st.bold && st.italic) return "Helvetica-BoldOblique";
    if (st.bold) return "Helvetica-Bold";
    if (st.italic) return "Helvetica-Oblique";
    return "Helvetica";
}

json argb_to_json(uint32_t argb) {
    return json::array({((argb >> 16) & 0xff) / 255.0f, ((argb >> 8) & 0xff) / 255.0f, (argb & 0xff) / 255.0f});
}

fz_point quad_center(fz_quad q) {
    return {(q.ul.x + q.ur.x + q.ll.x + q.lr.x) / 4, (q.ul.y + q.ur.y + q.ll.y + q.lr.y) / 4};
}

fz_point lerp(fz_point a, fz_point b, float t) { return {a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t}; }

// A thin band through the middle of a glyph quad: removes exactly this glyph,
// never glyphs on neighbouring lines or adjacent characters.
fz_quad glyph_band(fz_quad q) {
    const float t0 = 0.40f, t1 = 0.60f, s0 = 0.25f, s1 = 0.75f;
    fz_point top_l = lerp(q.ul, q.ll, t0), top_r = lerp(q.ur, q.lr, t0);
    fz_point bot_l = lerp(q.ul, q.ll, t1), bot_r = lerp(q.ur, q.lr, t1);
    fz_quad b;
    b.ul = lerp(top_l, top_r, s0);
    b.ur = lerp(top_l, top_r, s1);
    b.ll = lerp(bot_l, bot_r, s0);
    b.lr = lerp(bot_l, bot_r, s1);
    return b;
}

// Can this (original, embedded) font program be re-embedded as a CID font that
// every reader accepts? TrueType/OpenType and bare CFF: yes. Raw Type 1
// (PFA/PFB) re-embedded under a CID font is rejected by Poppler/pdf.js
// ("Mismatch between font type and embedded font file"), so those edits use
// the closest standard font instead.
bool reusable_font_program(fz_context* ctx, fz_font* font) {
    if (!font || !pdf_font_writing_supported(ctx, font) || !font->buffer) return false;
    const unsigned char* d = font->buffer->data;
    size_t n = font->buffer->len;
    if (n < 4) return false;
    bool truetype = (d[0] == 0 && d[1] == 1 && d[2] == 0 && d[3] == 0) || !std::memcmp(d, "true", 4) ||
                    !std::memcmp(d, "OTTO", 4) || !std::memcmp(d, "ttcf", 4);
    bool cff = d[0] == 1 && d[1] == 0;  // CFF header: major version 1, minor 0
    return truetype || cff;
}

// ---------------------------------------------------------------- visual lines
// MuPDF groups characters into lines in content-stream order, so one visual
// line is often split (text drawn out of order, forms, and the part of a line
// we redraw after an edit). We merge segments that share a baseline and touch
// along it into one visual line, ordered along the baseline. Gaps between
// merged segments get a synthetic space (src == nullptr) so text and chars
// stay 1:1.
struct VChar {
    int c;
    fz_quad quad;
    fz_point origin;
    float size;
    fz_font* font;
    uint32_t argb;
    uint16_t flags;
    fz_stext_char* src;  // nullptr for synthetic spaces
};

struct VLine {
    fz_point dir;
    int wmode;
    int block;
    std::vector<VChar> chars;
    fz_rect bbox() const {
        fz_rect r = fz_empty_rect;
        for (auto& c : chars) r = fz_union_rect(r, fz_rect_from_quad(c.quad));
        return r;
    }
};

float along(const VLine& l, fz_point p) { return p.x * l.dir.x + p.y * l.dir.y; }
float across(const VLine& l, fz_point p) { return -p.x * l.dir.y + p.y * l.dir.x; }
float char_width(const VChar& c) { return std::hypot(c.quad.ur.x - c.quad.ul.x, c.quad.ur.y - c.quad.ul.y); }
float max_size(const VLine& l) {
    float m = 0;
    for (auto& c : l.chars) m = std::max(m, c.size);
    return m > 0 ? m : 1;
}

bool mergeable(const VLine& a, const VLine& b) {
    if (a.wmode != b.wmode || a.chars.empty() || b.chars.empty()) return false;
    if (a.dir.x * b.dir.x + a.dir.y * b.dir.y < 0.999f) return false;
    float size = std::max(max_size(a), max_size(b));
    if (std::fabs(across(a, a.chars.front().origin) - across(a, b.chars.front().origin)) > 0.15f * size) return false;
    float a0 = along(a, a.chars.front().origin), a1 = along(a, a.chars.back().origin) + char_width(a.chars.back());
    float b0 = along(a, b.chars.front().origin), b1 = along(a, b.chars.back().origin) + char_width(b.chars.back());
    float gap = b0 >= a0 ? b0 - a1 : a0 - b1;
    return gap > -0.3f * size && gap < 1.2f * size;
}

std::vector<VLine> visual_lines(fz_stext_page* st) {
    std::vector<VLine> segs;
    int bi = 0;
    for (fz_stext_block* b = st->first_block; b; b = b->next) {
        if (b->type != FZ_STEXT_BLOCK_TEXT) continue;
        for (fz_stext_line* ln = b->u.t.first_line; ln; ln = ln->next) {
            VLine v{ln->dir, ln->wmode, bi, {}};
            for (fz_stext_char* ch = ln->first_char; ch; ch = ch->next)
                v.chars.push_back({ch->c, ch->quad, ch->origin, ch->size, ch->font, ch->argb, ch->flags, ch});
            if (!v.chars.empty()) segs.push_back(std::move(v));
        }
        ++bi;
    }
    std::vector<VLine> out;
    for (auto& seg : segs) {
        VLine* target = nullptr;
        for (auto& l : out)
            if (mergeable(l, seg)) { target = &l; break; }
        if (!target) { out.push_back(std::move(seg)); continue; }
        for (auto& c : seg.chars) target->chars.push_back(c);
        VLine& l = *target;
        std::stable_sort(l.chars.begin(), l.chars.end(),
                         [&](const VChar& x, const VChar& y) { return along(l, x.origin) < along(l, y.origin); });
        // Synthetic spaces where merged pieces leave a word-sized gap.
        std::vector<VChar> spaced;
        for (size_t i = 0; i < l.chars.size(); ++i) {
            if (i > 0) {
                const VChar& p = l.chars[i - 1];
                const VChar& c = l.chars[i];
                float gap = along(l, c.origin) - (along(l, p.origin) + char_width(p));
                if (p.c != ' ' && c.c != ' ' && gap > 0.2f * std::max(p.size, c.size)) {
                    fz_quad q{p.quad.ur, c.quad.ul, p.quad.lr, c.quad.ll};
                    fz_point o = {p.origin.x + l.dir.x * char_width(p), p.origin.y + l.dir.y * char_width(p)};
                    spaced.push_back({' ', q, o, p.size, p.font, p.argb, p.flags, nullptr});
                }
            }
            spaced.push_back(l.chars[i]);
        }
        l.chars = std::move(spaced);
    }
    return out;
}

}  // namespace

// ---------------------------------------------------------------- textLayout
json Engine::Impl::text_layout(const json& a) {
    int pno = arg_int(a, "page");
    auto page = load_page(pno);
    auto st = content_stext(*this, page.get());
    std::vector<VLine> vlines = visual_lines(st.get());
    std::map<int, std::vector<const VLine*>> by_block;
    for (auto& l : vlines) by_block[l.block].push_back(&l);

    json blocks = json::array();
    int bi = 0;
    for (auto& [_, ls] : by_block) {
        json lines = json::array();
        fz_rect bb = fz_empty_rect;
        int li = 0;
        for (const VLine* ln : ls) {
            std::string text;
            json chars = json::array();
            json spans = json::array();
            json cur;
            std::string cur_text;
            fz_font* cur_font = nullptr;
            float cur_size = -1;
            uint32_t cur_argb = 0;
            fz_rect cur_bbox = fz_empty_rect;
            auto flush = [&] {
                if (cur_font) {
                    cur["text"] = cur_text;
                    cur["bbox"] = rect_to_json(cur_bbox);
                    spans.push_back(cur);
                }
                cur = json::object();
                cur_text.clear();
                cur_bbox = fz_empty_rect;
            };
            for (const VChar& ch : ln->chars) {
                bool bold_flag = (ch.flags & FZ_STEXT_BOLD) != 0;
                bool new_span = ch.font != cur_font || std::fabs(ch.size - cur_size) > 0.01f || ch.argb != cur_argb;
                if (new_span && !(ch.src == nullptr && cur_font)) {  // synthetic spaces join the current span
                    flush();
                    cur_font = ch.font;
                    cur_size = ch.size;
                    cur_argb = ch.argb;
                    Style sty = font_style(ctx, ch.font, bold_flag);
                    cur["font"] = clean_font_name(fz_font_name(ctx, ch.font));
                    cur["size"] = ch.size;
                    cur["color"] = argb_to_json(ch.argb);
                    cur["bold"] = sty.bold;
                    cur["italic"] = sty.italic;
                    cur["serif"] = sty.serif;
                    cur["mono"] = sty.mono;
                    cur["origin"] = point_to_json(ch.origin);
                }
                std::string u = utf8_of(ch.c);
                text += u;
                cur_text += u;
                cur_bbox = fz_union_rect(cur_bbox, fz_rect_from_quad(ch.quad));
                chars.push_back(quad_to_json(ch.quad));
            }
            flush();
            fz_rect lb = ln->bbox();
            bb = fz_union_rect(bb, lb);
            lines.push_back({{"id", std::to_string(bi) + "-" + std::to_string(li++)},
                             {"bbox", rect_to_json(lb)},
                             {"dir", point_to_json(ln->dir)},
                             {"wmode", ln->wmode},
                             {"text", text},
                             {"spans", spans},
                             {"chars", chars}});
        }
        blocks.push_back({{"bbox", rect_to_json(bb)}, {"lines", lines}});
        ++bi;
    }
    return {{"blocks", blocks}};
}

// ---------------------------------------------------------------- search
json Engine::Impl::search(const json& a) {
    int pno = arg_int(a, "page");
    std::string needle = arg_str(a, "needle");
    int max = a.value("max", 500);
    if (max < 1 || max > 5000) throw Error("bad_args", "max must be in [1, 5000]");
    json hits = json::array();
    if (needle.empty()) return {{"hits", hits}};
    auto page = load_page(pno);
    // Search everything visible: content, annotations and form-field appearances
    // (fz_search_page skips widgets, so filled form values would be unfindable).
    fz_rect bounds = mu::call(ctx, pdf_bound_page, page.get(), FZ_CROP_BOX);
    mu::STextPage st(ctx, mu::call(ctx, fz_new_stext_page, bounds));
    {
        fz_stext_options opts;
        std::memset(&opts, 0, sizeof opts);
        mu::Device dev(ctx, mu::call(ctx, fz_new_stext_device, st.get(), (const fz_stext_options*)&opts));
        mu::call(ctx, pdf_run_page_contents, page.get(), dev.get(), fz_identity, (fz_cookie*)nullptr);
        mu::call(ctx, pdf_run_page_annots, page.get(), dev.get(), fz_identity, (fz_cookie*)nullptr);
        mu::call(ctx, pdf_run_page_widgets, page.get(), dev.get(), fz_identity, (fz_cookie*)nullptr);
        mu::call(ctx, fz_close_device, dev.get());
    }
    std::vector<fz_quad> quads(max);
    std::vector<int> marks(max);
    int n = mu::call(ctx, fz_search_stext_page, st.get(), needle.c_str(), marks.data(), quads.data(), max);
    json hit = json::array();
    for (int i = 0; i < n; ++i) {
        if (marks[i] && !hit.empty()) {
            hits.push_back(hit);
            hit = json::array();
        }
        hit.push_back(quad_to_json(quads[i]));
    }
    if (!hit.empty()) hits.push_back(hit);
    return {{"hits", hits}};
}

// ---------------------------------------------------------------- replaceText
namespace {

float quad_width(fz_quad q) { return std::hypot(q.ur.x - q.ul.x, q.ur.y - q.ul.y); }

float rgb_of(uint32_t argb, int i) { return ((argb >> (16 - 8 * i)) & 0xff) / 255.0f; }

// Horizontal scale that makes `subst` occupy the same width as `orig` did for
// the given sample characters (keeps line length when a substitute font is used).
float metric_scale(fz_context* ctx, fz_font* orig, fz_font* subst, const std::vector<const VChar*>& sample) {
    if (!orig || orig == subst) return 1;
    float ow = 0, sw = 0;
    for (const VChar* ch : sample) {
        if (ch->font != orig || ch->c == ' ') continue;
        int gid = mu::call(ctx, fz_encode_character, subst, ch->c);
        if (!gid) continue;
        ow += quad_width(ch->quad);
        sw += mu::call(ctx, fz_advance_glyph, subst, gid, 0) * ch->size;
    }
    if (ow <= 0 || sw <= 0) return 1;
    return std::clamp(ow / sw, 0.75f, 1.25f);
}

}  // namespace

json Engine::Impl::replace_text(const json& a) {
    int pno = arg_int(a, "page");
    fz_rect area = rect_from_json(arg(a, "bbox"));
    std::string new_text = arg_str(a, "text");
    std::string font_req = a.value("font", std::string("original"));

    // 1. Collect the characters whose centre lies in the area, per visual line.
    auto page = load_page(pno);
    auto st = content_stext(*this, page.get());
    std::vector<VLine> vlines = visual_lines(st.get());
    fz_rect probe = fz_expand_rect(area, 0.5f);
    std::vector<std::pair<const VLine*, std::vector<const VChar*>>> hits;
    for (auto& ln : vlines) {
        std::vector<const VChar*> in;
        for (auto& ch : ln.chars)
            if (fz_is_point_inside_rect(quad_center(ch.quad), probe)) in.push_back(&ch);
        if (!in.empty()) hits.push_back({&ln, std::move(in)});
    }
    // The line with the most hits is the target. Another line joins the edit
    // only if it is a genuinely separate text line (baseline at least 0.8 em
    // away); superscripts, subscripts and symbols that merely sit inside the
    // box are left untouched.
    std::vector<const VChar*> found;
    std::vector<const VLine*> lines_hit;
    if (!hits.empty()) {
        auto primary = std::max_element(hits.begin(), hits.end(),
                                         [](auto& x, auto& y) { return x.second.size() < y.second.size(); });
        const VLine* pl = primary->first;
        float em = max_size(*pl);
        float base = across(*pl, pl->chars.front().origin);
        std::vector<std::pair<float, size_t>> order;  // (baseline offset, index into hits)
        for (size_t i = 0; i < hits.size(); ++i) {
            const VLine* l = hits[i].first;
            bool same_dir = l->dir.x * pl->dir.x + l->dir.y * pl->dir.y > 0.999f;
            float off = across(*pl, l->chars.front().origin) - base;
            if (l == pl || (same_dir && std::fabs(off) >= 0.8f * em)) order.push_back({off, i});
        }
        std::sort(order.begin(), order.end());
        for (auto& [off, i] : order) {
            lines_hit.push_back(hits[i].first);
            for (auto* c : hits[i].second) found.push_back(c);
        }
    }
    // Trim synthetic spaces at the ends of the selection.
    while (!found.empty() && !found.front()->src) found.erase(found.begin());
    while (!found.empty() && !found.back()->src) found.pop_back();
    if (found.empty() && !a.contains("origin")) throw Error("not_found", "no text found in bbox");

    // Fonts: the original embedded program when it can draw the text, else the
    // closest standard font (cached per name for this call).
    std::map<std::string, mu::Font> std_fonts;
    auto standard = [&](const std::string& name) -> fz_font* {
        auto it = std_fonts.find(name);
        if (it != std_fonts.end()) return it->second.get();
        mu::Font f;
        fz_font* p = resolve_font(name, f);
        if (f) std_fonts[name] = std::move(f);
        return p;
    };
    auto covers = [&](fz_font* f, const std::vector<int>& cps) {
        for (int c : cps)
            if (c != ' ' && c != '\n' && c != '\r' && c != '\t' && mu::call(ctx, fz_encode_character, f, c) == 0) return false;
        return true;
    };
    auto font_for = [&](const VChar* ref, const std::vector<int>& cps) -> fz_font* {
        if (reusable_font_program(ctx, ref->font) && covers(ref->font, cps)) return ref->font;
        return standard(standard_font_for(font_style(ctx, ref->font, (ref->flags & FZ_STEXT_BOLD) != 0)));
    };

    std::vector<int> nw = utf8_codepoints(new_text);
    bool restyle = font_req != "original" || a.contains("size") || a.contains("color") || a.contains("origin") ||
                   a.contains("dir") || a.contains("lineHeight");
    bool single_line = lines_hit.size() == 1 && new_text.find('\n') == std::string::npos;

    TextPainter painter(*this);
    std::vector<const VChar*> remove;
    std::string font_used;
    bool used_original = false;

    if (!found.empty() && single_line && !restyle) {
        // 2a. Minimal edit: keep the unchanged prefix untouched, redraw the
        // changed middle in the style it replaces, and shift the unchanged
        // suffix as a block (each glyph keeps its own font/size/colour and the
        // original spacing between glyphs, so justified text stays justified).
        // Content past a column-sized gap (tab stops, table cells, diagram
        // labels that MuPDF put on one line) never moves: cut the editable run
        // at the first such gap after the last changed character, and leave
        // everything beyond it untouched.
        fz_point u_dir = unit(lines_hit[0]->dir);
        auto start_of = [&](const VChar* c) { return c->origin.x * u_dir.x + c->origin.y * u_dir.y; };
        auto end_of = [&](const VChar* c) { return start_of(c) + quad_width(c->quad); };
        std::vector<int> old;
        for (auto* ch : found) old.push_back(ch->c);
        size_t n = old.size(), m = nw.size(), p = 0, sfx = 0;
        while (p < n && p < m && old[p] == nw[p]) ++p;
        while (sfx < n - p && sfx < m - p && old[n - 1 - sfx] == nw[m - 1 - sfx]) ++sfx;
        if (p == n && n == m) return {{"ok", true}, {"font", clean_font_name(fz_font_name(ctx, found[0]->font))}, {"usedOriginalFont", true}};
        // Find the first column-sized gap between two non-space glyphs at or
        // after the end of the changed range. Everything after it is unchanged
        // (it lies inside the common suffix), so drop it from the edit.
        const size_t mid_end = m - sfx;  // end of the changed part of the new text
        {
            size_t change_end = n - sfx;  // first unchanged suffix char
            long last = -1;               // last non-space glyph seen
            for (size_t i = 0; i < n; ++i) {
                if (found[i]->c == ' ' || !found[i]->src) continue;
                if (last >= 0 && (size_t)last + 1 >= change_end && i >= change_end) {
                    const VChar* a0 = found[last];
                    const VChar* b0 = found[i];
                    if (start_of(b0) - end_of(a0) > 1.5f * std::max(a0->size, b0->size)) {
                        size_t keep_from = (size_t)last + 1;  // spaces + far text stay as they are
                        sfx -= std::min(sfx, n - keep_from);
                        found.resize(keep_from);
                        old.resize(keep_from);
                        n = keep_from;
                        break;
                    }
                }
                last = (long)i;
            }
        }

        fz_point dir = unit(lines_hit[0]->dir);
        fz_point anchor;
        if (p < n) anchor = found[p]->origin;
        else {
            const VChar* last = found[n - 1];
            float w = quad_width(last->quad);
            anchor = {last->origin.x + dir.x * w, last->origin.y + dir.y * w};
        }
        // Style of the middle: the first changed glyph, or its left neighbour
        // when that glyph is a space (or when appending).
        const VChar* ref = p < n ? found[p] : found[n - 1];
        if (ref->c == ' ' && p > 0) ref = found[p - 1];
        std::vector<int> middle(nw.begin() + p, nw.begin() + mid_end);
        fz_font* mfont = font_for(ref, middle);
        float mscale = metric_scale(ctx, ref->font, mfont, found);
        float mcolor[3] = {rgb_of(ref->argb, 0), rgb_of(ref->argb, 1), rgb_of(ref->argb, 2)};
        float adv = middle.empty() ? 0 : painter.line(mfont, middle, anchor, dir, ref->size, mscale, mcolor);
        font_used = fz_font_name(ctx, mfont);
        used_original = mfont == ref->font;

        if (sfx > 0) {
            const VChar* first = found[n - sfx];
            fz_point pen = {anchor.x + dir.x * adv, anchor.y + dir.y * adv};
            fz_point shift = {pen.x - first->origin.x, pen.y - first->origin.y};
            for (size_t i = n - sfx; i < n; ++i) {
                const VChar* ch = found[i];
                if (!ch->src) continue;  // synthetic gap: positions already carry the spacing
                fz_font* f = font_for(ch, {ch->c});
                float col[3] = {rgb_of(ch->argb, 0), rgb_of(ch->argb, 1), rgb_of(ch->argb, 2)};
                painter.glyph(f, ch->c, {ch->origin.x + shift.x, ch->origin.y + shift.y}, unit(lines_hit[0]->dir), ch->size,
                              metric_scale(ctx, ch->font, f, found), col);
                if (f != ch->font) used_original = false;
            }
        }
        remove.assign(found.begin() + p, found.end());
    } else {
        // 2b. Full replacement (multi-line, explicit restyle, or new text).
        const VChar* ref = nullptr;
        if (!found.empty()) {
            std::map<fz_font*, int> votes;
            for (auto* ch : found)
                if (ch->c != ' ' && ch->src) votes[ch->font]++;
            fz_font* dominant = found[0]->font;
            int best = -1;
            for (auto& [f, k] : votes)
                if (k > best) best = k, dominant = f;
            for (auto* ch : found)
                if (ch->font == dominant) { ref = ch; break; }
        }
        float size = ref ? ref->size : 12.0f;
        if (a.contains("size")) size = arg_float(a, "size");
        float color[3] = {0, 0, 0};
        if (ref) for (int i = 0; i < 3; ++i) color[i] = rgb_of(ref->argb, i);
        if (a.contains("color")) color_from_json(a["color"], color);
        fz_point origin = found.empty() ? fz_point{area.x0, area.y1} : found.front()->origin;
        if (a.contains("origin")) origin = point_from_json(a["origin"]);
        fz_point dir = lines_hit.empty() ? fz_point{1, 0} : lines_hit[0]->dir;
        if (a.contains("dir")) dir = point_from_json(a["dir"]);
        float line_height = 1.2f;
        if (lines_hit.size() >= 2 && size > 0) {
            // Keep the original leading when replacing a multi-line selection.
            fz_point o0 = lines_hit[0]->chars.front().origin, o1 = lines_hit[1]->chars.front().origin;
            fz_point u = unit(dir);
            float d = std::fabs((o1.x - o0.x) * -u.y + (o1.y - o0.y) * u.x);
            if (d > 0.5f * size && d < 4 * size) line_height = d / size;
        }
        if (a.contains("lineHeight")) line_height = arg_float(a, "lineHeight");

        fz_font* font;
        float hscale = 1;
        if (font_req != "original") {
            font = standard(font_req);
        } else if (ref) {
            font = font_for(ref, nw);
            hscale = metric_scale(ctx, ref->font, font, found);
        } else {
            font = standard("Helvetica");
        }
        used_original = ref && font == ref->font;
        font_used = fz_font_name(ctx, font);
        if (!new_text.empty()) painter.text(font, new_text, origin, dir, size, hscale, color, line_height);
        remove = found;
    }

    journaled("Edit text", [&] {
        // 3. Remove exactly the replaced glyphs: text-only redaction of thin
        // per-glyph bands (never touches neighbouring lines or images).
        if (std::any_of(remove.begin(), remove.end(), [](const VChar* c) { return c->src != nullptr; })) {
            std::vector<fz_quad> bands;
            bands.reserve(remove.size());
            for (auto* ch : remove)
                if (ch->src) bands.push_back(glyph_band(ch->quad));
            mu::Annot annot(ctx, mu::call(ctx, pdf_create_annot, page.get(), PDF_ANNOT_REDACT));
            mu::call(ctx, pdf_set_annot_quad_points, annot.get(), (int)bands.size(), (const fz_quad*)bands.data());
            pdf_redact_options ro{0, PDF_REDACT_IMAGE_NONE, PDF_REDACT_LINE_ART_NONE, PDF_REDACT_TEXT_REMOVE};
            mu::call(ctx, pdf_apply_redaction, annot.get(), &ro);
        }
        // 4. Draw the replacement.
        if (!painter.empty()) append_page_content(pno, [&](fz_device* dev) { painter.fill(dev); });
    });
    return {{"ok", true}, {"font", clean_font_name(font_used.c_str())}, {"usedOriginalFont", used_original}};
}

// ---------------------------------------------------------------- addText
json Engine::Impl::add_text(const json& a) {
    int pno = arg_int(a, "page");
    fz_point origin = {arg_float(a, "x"), arg_float(a, "y")};
    std::string text = arg_str(a, "text");
    float size = a.contains("size") ? arg_float(a, "size") : 12.0f;
    float color[3] = {0, 0, 0};
    if (a.contains("color")) color_from_json(a["color"], color);
    float lh = a.contains("lineHeight") ? arg_float(a, "lineHeight") : 1.2f;
    mu::Font holder;
    fz_font* font = resolve_font(a.value("font", std::string("Helvetica")), holder);
    load_page(pno);  // validate before opening an operation
    TextPainter painter(*this);
    painter.text(font, text, origin, {1, 0}, size, 1, color, lh);
    journaled("Add text", [&] { append_page_content(pno, [&](fz_device* dev) { painter.fill(dev); }); });
    return json::object();
}

// ---------------------------------------------------------------- addImage
json Engine::Impl::add_image(const json& a, const Bytes* in) {
    int pno = arg_int(a, "page");
    fz_rect r = rect_from_json(arg(a, "rect"));
    if (!in || in->empty()) throw Error("bad_args", "addImage requires image bytes");
    if (fz_is_empty_rect(r)) throw Error("bad_args", "rect is empty");
    auto buf = mu::buffer_from(ctx, reinterpret_cast<const unsigned char*>(in->data()), in->size());
    mu::Image img(ctx, mu::call(ctx, fz_new_image_from_buffer, buf.get()));
    load_page(pno);
    journaled("Add image", [&] {
        append_page_content(pno, [&](fz_device* dev) {
            fz_matrix m = {r.x1 - r.x0, 0, 0, r.y1 - r.y0, r.x0, r.y0};
            mu::call(ctx, fz_fill_image, dev, img.get(), m, 1.0f, fz_default_color_params);
        });
    });
    return json::object();
}

// ---------------------------------------------------------------- redact
json Engine::Impl::redact(const json& a) {
    int pno = arg_int(a, "page");
    const json& rj = arg(a, "rects");
    if (!rj.is_array() || rj.empty()) throw Error("bad_args", "rects must be a non-empty array");
    std::vector<fz_rect> rects;
    for (auto& r : rj) rects.push_back(rect_from_json(r));
    float fill[3] = {0, 0, 0};
    int nfill = 3;
    if (a.contains("fill")) nfill = color_from_json(a["fill"], fill);
    bool images = a.value("images", true), graphics = a.value("graphics", true);
    auto page = load_page(pno);
    journaled("Redact", [&] {
        pdf_redact_options ro{0, images ? PDF_REDACT_IMAGE_PIXELS : PDF_REDACT_IMAGE_NONE,
                              graphics ? PDF_REDACT_LINE_ART_REMOVE_IF_COVERED : PDF_REDACT_LINE_ART_NONE,
                              PDF_REDACT_TEXT_REMOVE};
        for (const fz_rect& r : rects) {
            mu::Annot annot(ctx, mu::call(ctx, pdf_create_annot, page.get(), PDF_ANNOT_REDACT));
            mu::call(ctx, pdf_set_annot_rect, annot.get(), r);
            fz_quad q = fz_quad_from_rect(r);
            mu::call(ctx, pdf_set_annot_quad_points, annot.get(), 1, (const fz_quad*)&q);
            mu::call(ctx, pdf_apply_redaction, annot.get(), &ro);
        }
        if (nfill) {
            append_page_content(pno, [&](fz_device* dev) {
                mu::Path path(ctx, mu::call(ctx, fz_new_path));
                for (const fz_rect& r : rects) mu::call(ctx, fz_rectto, path.get(), r.x0, r.y0, r.x1, r.y1);
                mu::call(ctx, fz_fill_path, dev, (const fz_path*)path.get(), 0, fz_identity, fz_device_rgb(ctx),
                         (const float*)fill, 1.0f, fz_default_color_params);
            });
        }
    });
    return json::object();
}

}  // namespace pdfedit
