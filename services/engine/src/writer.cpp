// Appending new content (text, images, shapes) to existing pages.
//
// New content is drawn with MuPDF's PDF output device into a fresh resource
// dictionary, wrapped in a Form XObject, and invoked from the page with
// "q /PExN Do Q". Isolating it in an XObject means our font/image resource
// names can never collide with names already used by the page, and the
// original content is balanced/wrapped in q/Q (as much as pdf_count_q_balance
// says is needed) so graphics state it leaves behind cannot leak into ours.
#include <cmath>
#include <cstring>

#include "impl.hpp"

namespace pdfedit {

static pdf_obj* add_content_stream(fz_context* ctx, pdf_document* doc, const char* text, bool /*unused*/) {
    mu::Buffer buf(ctx, mu::call(ctx, fz_new_buffer_from_copied_data, (const unsigned char*)text, std::strlen(text)));
    mu::Obj dict(ctx, mu::call(ctx, pdf_new_dict, doc, 1));
    return mu::call(ctx, pdf_add_stream, doc, buf.get(), dict.get(), 0);
}

static std::string repeat(const char* s, int n) {
    std::string out;
    for (int i = 0; i < n; ++i) out += s;
    return out;
}

void Engine::Impl::append_page_content(int pno, const std::function<void(fz_device*)>& draw) {
    auto page = load_page(pno);
    pdf_obj* pobj = page->obj;
    fz_matrix ctm = page_ctm(page.get());
    fz_matrix inv = fz_invert_matrix(ctm);

    // 1. Draw into an isolated resource dictionary + content buffer.
    mu::Obj res(ctx, mu::call(ctx, pdf_new_dict, doc, 4));
    mu::Buffer buf(ctx, mu::call(ctx, fz_new_buffer, (size_t)1024));
    {
        mu::Device dev(ctx, mu::call(ctx, pdf_new_pdf_device, doc, inv, res.get(), buf.get()));
        draw(dev.get());
        mu::call(ctx, fz_close_device, dev.get());
    }

    // 2. Wrap it in a Form XObject covering the page (in PDF user space).
    fz_rect mediabox = pdf_to_rect(ctx, pdf_dict_get_inheritable(ctx, pobj, PDF_NAME(MediaBox)));
    if (fz_is_empty_rect(mediabox)) mediabox = fz_make_rect(0, 0, 612, 792);
    fz_rect page_bounds = mu::call(ctx, pdf_bound_page, page.get(), FZ_MEDIA_BOX);
    fz_rect bbox = fz_union_rect(mediabox, fz_transform_rect(page_bounds, inv));
    mu::Obj xobj(ctx, mu::call(ctx, pdf_new_xobject, doc, bbox, fz_identity, res.get(), buf.get()));

    // 3. Register it in the page's own resource dictionary.
    pdf_obj* resources = pdf_dict_get(ctx, pobj, PDF_NAME(Resources));
    if (!resources) {
        pdf_obj* inherited = pdf_dict_get_inheritable(ctx, pobj, PDF_NAME(Resources));
        if (inherited)
            mu::call(ctx, pdf_dict_put_drop, pobj, PDF_NAME(Resources), mu::call(ctx, pdf_copy_dict, inherited));
        else
            mu::call(ctx, pdf_dict_put_dict, pobj, PDF_NAME(Resources), 2);
        resources = pdf_dict_get(ctx, pobj, PDF_NAME(Resources));
    }
    pdf_obj* xobjects = pdf_dict_get(ctx, resources, PDF_NAME(XObject));
    if (!xobjects) xobjects = mu::call(ctx, pdf_dict_put_dict, resources, PDF_NAME(XObject), 2);
    char name[32];
    for (int k = 0;; ++k) {
        std::snprintf(name, sizeof name, "PEx%d", k);
        if (!pdf_dict_gets(ctx, xobjects, name)) break;
    }
    mu::call(ctx, pdf_dict_puts, xobjects, (const char*)name, xobj.get());

    // 4. Rebuild /Contents so the original content cannot leak graphics state
    // (an active cm, colour, clip, unbalanced q/Q) into what we draw:
    //   [q x prepend] original... [Q x append] [q /PExN Do Q]
    // pdf_count_q_balance accounts for missing Q's, extra Q's and operators
    // outside any q/Q. Once wrapped the page is fully guarded, so later edits
    // add no further nesting.
    pdf_obj* contents = pdf_dict_get(ctx, pobj, PDF_NAME(Contents));
    mu::Obj arr(ctx, mu::call(ctx, pdf_new_array, doc, 4));
    std::vector<pdf_obj*> orig;
    if (pdf_is_array(ctx, contents)) {
        for (int i = 0, n = pdf_array_len(ctx, contents); i < n; ++i) orig.push_back(pdf_array_get(ctx, contents, i));
    } else if (contents) {
        orig.push_back(contents);
    }
    int prepend = 0, append = 0;
    if (!orig.empty()) {
        pdf_obj* page_res = pdf_dict_get_inheritable(ctx, pobj, PDF_NAME(Resources));
        mu::call(ctx, pdf_count_q_balance, doc, page_res, contents, &prepend, &append);
    }
    if (prepend > 0) mu::call(ctx, pdf_array_push_drop, arr.get(), add_content_stream(ctx, doc, repeat("q\n", prepend).c_str(), false));
    for (pdf_obj* o : orig) mu::call(ctx, pdf_array_push, arr.get(), o);
    if (append > 0) mu::call(ctx, pdf_array_push_drop, arr.get(), add_content_stream(ctx, doc, repeat("Q\n", append).c_str(), false));
    std::string invoke = std::string("q /") + name + " Do Q\n";
    mu::call(ctx, pdf_array_push_drop, arr.get(), add_content_stream(ctx, doc, invoke.c_str(), false));
    mu::call(ctx, pdf_dict_put, pobj, PDF_NAME(Contents), arr.get());
}

// ---------------------------------------------------------------- fonts
static const char* const kBase14[] = {
    "Helvetica", "Helvetica-Bold", "Helvetica-Oblique", "Helvetica-BoldOblique",
    "Times-Roman", "Times-Bold", "Times-Italic", "Times-BoldItalic",
    "Courier", "Courier-Bold", "Courier-Oblique", "Courier-BoldOblique",
    "Symbol", "ZapfDingbats",
};

fz_font* Engine::Impl::resolve_font(const std::string& name, mu::Font& holder) {
    auto it = user_fonts.find(name);
    if (it != user_fonts.end()) return it->second.get();
    const char* base = "Helvetica";
    for (const char* b : kBase14)
        if (name == b) base = b;
    if (!name.empty() && std::strcmp(base, name.c_str()) != 0)
        throw Error("bad_args", "unknown font '" + name + "' (use a standard 14 name or registerFont)");
    holder = mu::Font(ctx, mu::call(ctx, fz_new_base14_font, base));
    return holder.get();
}

std::vector<int> utf8_codepoints(const std::string& s) {
    std::vector<int> out;
    const char* p = s.c_str();
    while (*p) {
        int c;
        p += fz_chartorune(&c, p);
        out.push_back(c);
    }
    return out;
}

fz_point unit(fz_point dir) {
    float len = std::sqrt(dir.x * dir.x + dir.y * dir.y);
    if (len < 1e-6f) return {1, 0};
    return {dir.x / len, dir.y / len};
}

fz_text* TextPainter::run_for(const float color[3]) {
    for (auto& r : runs_)
        if (r.color[0] == color[0] && r.color[1] == color[1] && r.color[2] == color[2]) return r.text.get();
    Run r{{color[0], color[1], color[2]}, mu::Text(E_.ctx, mu::call(E_.ctx, fz_new_text))};
    runs_.push_back(std::move(r));
    return runs_.back().text.get();
}

fz_font* TextPainter::helvetica() {
    if (!helv_) helv_ = mu::Font(E_.ctx, mu::call(E_.ctx, fz_new_base14_font, "Helvetica"));
    return helv_.get();
}

float TextPainter::glyph(fz_font* font, int c, fz_point origin, fz_point dir, float size, float hscale,
                         const float color[3]) {
    fz_context* ctx = E_.ctx;
    if (size <= 0 || size > 2000) throw Error("bad_args", "font size must be in (0, 2000]");
    if (c == '\t') c = ' ';
    dir = unit(dir);
    fz_font* use = font;
    int gid = mu::call(ctx, fz_encode_character, font, c);
    if (gid == 0 && c != ' ') {
        fz_font* fb = nullptr;
        fz_try(ctx) { gid = fz_encode_character_with_fallback(ctx, font, c, 0, FZ_LANG_UNSET, &fb); }
        fz_catch(ctx) { fz_ignore_error(ctx); gid = 0; fb = nullptr; }
        if (fb && gid) use = fb;
        else { use = font; gid = 0; }
    }
    if (!pdf_font_writing_supported(ctx, use)) {
        use = helvetica();
        gid = mu::call(ctx, fz_encode_character, use, c);
    }
    if (gid == 0 && c == ' ') return 0.25f * size * hscale;  // no space glyph: advance only
    fz_matrix trm = {size * hscale * dir.x, size * hscale * dir.y, size * dir.y, -size * dir.x, origin.x, origin.y};
    mu::call(ctx, fz_show_glyph, run_for(color), use, trm, gid, c, 0, 0, FZ_BIDI_LTR, FZ_LANG_UNSET);
    return mu::call(ctx, fz_advance_glyph, use, gid, 0) * size * hscale;
}

float TextPainter::line(fz_font* font, const std::vector<int>& cps, fz_point origin, fz_point dir, float size,
                        float hscale, const float color[3]) {
    dir = unit(dir);
    float pen = 0;
    for (int c : cps) {
        if (c == '\r' || c == '\n') continue;
        pen += glyph(font, c, {origin.x + dir.x * pen, origin.y + dir.y * pen}, dir, size, hscale, color);
    }
    return pen;
}

void TextPainter::text(fz_font* font, const std::string& utf8, fz_point origin, fz_point dir, float size,
                       float hscale, const float color[3], float line_height) {
    dir = unit(dir);
    fz_point down = {-dir.y, dir.x};  // page space is y-down
    std::vector<int> cur;
    int ln = 0;
    auto flush = [&] {
        float off = ln * line_height * size;
        line(font, cur, {origin.x + down.x * off, origin.y + down.y * off}, dir, size, hscale, color);
        cur.clear();
        ++ln;
    };
    for (int c : utf8_codepoints(utf8)) {
        if (c == '\n') flush();
        else cur.push_back(c);
    }
    flush();
}

void TextPainter::fill(fz_device* dev) {
    fz_context* ctx = E_.ctx;
    for (auto& r : runs_)
        mu::call(ctx, fz_fill_text, dev, (const fz_text*)r.text.get(), fz_identity, fz_device_rgb(ctx), (const float*)r.color,
                 1.0f, fz_default_color_params);
}

}  // namespace pdfedit
