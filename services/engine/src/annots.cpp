// Annotations: list, add, update (move/resize/restyle), delete.
#include <cmath>
#include <cstring>

#include "impl.hpp"

namespace pdfedit {

namespace {

struct LineEndingName {
    const char* name;
    enum pdf_line_ending le;
};
const LineEndingName kEndings[] = {
    {"None", PDF_ANNOT_LE_NONE},           {"Square", PDF_ANNOT_LE_SQUARE},
    {"Circle", PDF_ANNOT_LE_CIRCLE},       {"Diamond", PDF_ANNOT_LE_DIAMOND},
    {"OpenArrow", PDF_ANNOT_LE_OPEN_ARROW}, {"ClosedArrow", PDF_ANNOT_LE_CLOSED_ARROW},
    {"Butt", PDF_ANNOT_LE_BUTT},           {"ROpenArrow", PDF_ANNOT_LE_R_OPEN_ARROW},
    {"RClosedArrow", PDF_ANNOT_LE_R_CLOSED_ARROW}, {"Slash", PDF_ANNOT_LE_SLASH},
};

enum pdf_line_ending ending_from(const json& j) {
    if (!j.is_string()) throw Error("bad_args", "lineEnding entries must be strings");
    std::string s = j.get<std::string>();
    for (auto& e : kEndings)
        if (s == e.name) return e.le;
    throw Error("bad_args", "unknown line ending '" + s + "'");
}
const char* ending_name(enum pdf_line_ending le) {
    for (auto& e : kEndings)
        if (e.le == le) return e.name;
    return "None";
}

bool creatable(enum pdf_annot_type t) {
    switch (t) {
        case PDF_ANNOT_TEXT: case PDF_ANNOT_FREE_TEXT: case PDF_ANNOT_SQUARE: case PDF_ANNOT_CIRCLE:
        case PDF_ANNOT_LINE: case PDF_ANNOT_INK: case PDF_ANNOT_POLYGON: case PDF_ANNOT_POLY_LINE:
        case PDF_ANNOT_HIGHLIGHT: case PDF_ANNOT_UNDERLINE: case PDF_ANNOT_STRIKE_OUT: case PDF_ANNOT_SQUIGGLY:
        case PDF_ANNOT_STAMP: case PDF_ANNOT_REDACT:
            return true;
        default:
            return false;
    }
}

}  // namespace

static pdf_annot* find_annot(fz_context* ctx, pdf_page* page, int id) {
    for (pdf_annot* a = mu::call(ctx, pdf_first_annot, page); a; a = mu::call(ctx, pdf_next_annot, a))
        if (mu::call(ctx, pdf_to_num, mu::call(ctx, pdf_annot_obj, a)) == id) return a;
    throw Error("not_found", "annotation " + std::to_string(id) + " not found on page");
}

static json describe(fz_context* ctx, pdf_annot* a) {
    json j;
    enum pdf_annot_type t = mu::call(ctx, pdf_annot_type, a);
    j["id"] = mu::call(ctx, pdf_to_num, mu::call(ctx, pdf_annot_obj, a));
    j["type"] = mu::call(ctx, pdf_string_from_annot_type, t);
    j["rect"] = rect_to_json(mu::call(ctx, pdf_bound_annot, a));
    int n = 0;
    float c[4];
    mu::call(ctx, pdf_annot_color, a, &n, c);
    j["color"] = color_to_json(n, c);
    if (mu::call(ctx, pdf_annot_has_interior_color, a)) {
        mu::call(ctx, pdf_annot_interior_color, a, &n, c);
        j["fill"] = color_to_json(n, c);
    }
    j["opacity"] = mu::call(ctx, pdf_annot_opacity, a);
    if (mu::call(ctx, pdf_annot_has_border, a)) j["borderWidth"] = mu::call(ctx, pdf_annot_border_width, a);
    const char* contents = mu::call(ctx, pdf_annot_contents, a);
    j["contents"] = contents ? contents : "";
    if (mu::call(ctx, pdf_annot_has_author, a)) {
        const char* au = mu::call(ctx, pdf_annot_author, a);
        j["author"] = au ? au : "";
    }
    if (mu::call(ctx, pdf_annot_has_quad_points, a)) {
        json q = json::array();
        for (int i = 0, k = mu::call(ctx, pdf_annot_quad_point_count, a); i < k; ++i) q.push_back(quad_to_json(mu::call(ctx, pdf_annot_quad_point, a, i)));
        j["quads"] = q;
    }
    if (mu::call(ctx, pdf_annot_has_ink_list, a)) {
        json ink = json::array();
        for (int i = 0, k = mu::call(ctx, pdf_annot_ink_list_count, a); i < k; ++i) {
            json stroke = json::array();
            for (int v = 0, m = mu::call(ctx, pdf_annot_ink_list_stroke_count, a, i); v < m; ++v)
                stroke.push_back(point_to_json(mu::call(ctx, pdf_annot_ink_list_stroke_vertex, a, i, v)));
            ink.push_back(stroke);
        }
        j["ink"] = ink;
    }
    if (mu::call(ctx, pdf_annot_has_line, a)) {
        fz_point p0, p1;
        mu::call(ctx, pdf_annot_line, a, &p0, &p1);
        j["points"] = json::array({point_to_json(p0), point_to_json(p1)});
    }
    if (mu::call(ctx, pdf_annot_has_vertices, a)) {
        json pts = json::array();
        for (int i = 0, k = mu::call(ctx, pdf_annot_vertex_count, a); i < k; ++i) pts.push_back(point_to_json(mu::call(ctx, pdf_annot_vertex, a, i)));
        j["points"] = pts;
    }
    if (mu::call(ctx, pdf_annot_has_line_ending_styles, a)) {
        enum pdf_line_ending s, e;
        mu::call(ctx, pdf_annot_line_ending_styles, a, &s, &e);
        j["lineEnding"] = json::array({ending_name(s), ending_name(e)});
    }
    if (t == PDF_ANNOT_FREE_TEXT && mu::call(ctx, pdf_annot_has_default_appearance, a)) {
        const char* font = nullptr;
        float size = 12;
        mu::call(ctx, pdf_annot_default_appearance, a, &font, &size, &n, c);
        j["font"] = font ? font : "Helv";
        j["fontSize"] = size;
        j["color"] = color_to_json(n, c);
        j["align"] = mu::call(ctx, pdf_annot_quadding, a);
    }
    if (t == PDF_ANNOT_STAMP) j["image"] = mu::call(ctx, pdf_dict_get, mu::call(ctx, pdf_annot_obj, a), PDF_NAME(AP)) != nullptr;
    return j;
}

json Engine::Impl::list_annotations(const json& a) {
    auto page = load_page(arg_int(a, "page"));
    json list = json::array();
    for (pdf_annot* an = mu::call(ctx, pdf_first_annot, page.get()); an; an = mu::call(ctx, pdf_next_annot, an)) {
        list.push_back(describe(ctx, an));
    }
    return {{"annots", list}};
}

// Map a point from rect `from` onto rect `to`.
static fz_point remap(fz_point p, fz_rect from, fz_rect to) {
    float fw = from.x1 - from.x0, fh = from.y1 - from.y0;
    float sx = fw > 1e-3f ? (to.x1 - to.x0) / fw : 1, sy = fh > 1e-3f ? (to.y1 - to.y0) / fh : 1;
    return {to.x0 + (p.x - from.x0) * sx, to.y0 + (p.y - from.y0) * sy};
}

static void apply_spec(Engine::Impl& E, pdf_annot* an, const json& s, const Bytes* in, bool is_new) {
    fz_context* ctx = E.ctx;
    enum pdf_annot_type t = mu::call(ctx, pdf_annot_type, an);
    float c[3];

    // --- geometry
    bool has_geometry = mu::call(ctx, pdf_annot_has_ink_list, an) || mu::call(ctx, pdf_annot_has_vertices, an) ||
                        mu::call(ctx, pdf_annot_has_line, an) || mu::call(ctx, pdf_annot_has_quad_points, an);
    if (s.contains("rect") && !s["rect"].is_null()) {
        fz_rect to = rect_from_json(s["rect"]);
        if (!is_new && has_geometry && !s.contains("ink") && !s.contains("points") && !s.contains("quads")) {
            // Move/resize: carry the geometry along with the bounding box.
            fz_rect from = mu::call(ctx, pdf_bound_annot, an);
            if (mu::call(ctx, pdf_annot_has_ink_list, an)) {
                int k = mu::call(ctx, pdf_annot_ink_list_count, an);
                std::vector<int> counts;
                std::vector<fz_point> pts;
                for (int i = 0; i < k; ++i) {
                    int m = mu::call(ctx, pdf_annot_ink_list_stroke_count, an, i);
                    counts.push_back(m);
                    for (int v = 0; v < m; ++v) pts.push_back(remap(mu::call(ctx, pdf_annot_ink_list_stroke_vertex, an, i, v), from, to));
                }
                mu::call(ctx, pdf_set_annot_ink_list, an, k, (const int*)counts.data(), (const fz_point*)pts.data());
            }
            if (mu::call(ctx, pdf_annot_has_vertices, an)) {
                std::vector<fz_point> pts;
                for (int i = 0, k = mu::call(ctx, pdf_annot_vertex_count, an); i < k; ++i) pts.push_back(remap(mu::call(ctx, pdf_annot_vertex, an, i), from, to));
                mu::call(ctx, pdf_set_annot_vertices, an, (int)pts.size(), (const fz_point*)pts.data());
            }
            if (mu::call(ctx, pdf_annot_has_line, an)) {
                fz_point p0, p1;
                mu::call(ctx, pdf_annot_line, an, &p0, &p1);
                mu::call(ctx, pdf_set_annot_line, an, remap(p0, from, to), remap(p1, from, to));
            }
            if (mu::call(ctx, pdf_annot_has_quad_points, an)) {
                std::vector<fz_quad> qs;
                for (int i = 0, k = mu::call(ctx, pdf_annot_quad_point_count, an); i < k; ++i) {
                    fz_quad q = mu::call(ctx, pdf_annot_quad_point, an, i);
                    qs.push_back({remap(q.ul, from, to), remap(q.ur, from, to), remap(q.ll, from, to), remap(q.lr, from, to)});
                }
                mu::call(ctx, pdf_set_annot_quad_points, an, (int)qs.size(), (const fz_quad*)qs.data());
            }
        } else if (mu::call(ctx, pdf_annot_has_rect, an)) {
            mu::call(ctx, pdf_set_annot_rect, an, to);
        }
    }
    if (s.contains("quads")) {
        std::vector<fz_quad> qs;
        for (auto& q : s["quads"]) qs.push_back(quad_from_json(q));
        if (qs.empty()) throw Error("bad_args", "quads must not be empty");
        mu::call(ctx, pdf_set_annot_quad_points, an, (int)qs.size(), (const fz_quad*)qs.data());
    }
    if (s.contains("ink")) {
        if (!s["ink"].is_array()) throw Error("bad_args", "ink must be an array of strokes");
        std::vector<int> counts;
        std::vector<fz_point> pts;
        for (auto& stroke : s["ink"]) {
            if (!stroke.is_array() || stroke.empty()) throw Error("bad_args", "each ink stroke needs points");
            counts.push_back((int)stroke.size());
            for (auto& p : stroke) pts.push_back(point_from_json(p));
        }
        if (counts.empty()) throw Error("bad_args", "ink must not be empty");
        mu::call(ctx, pdf_set_annot_ink_list, an, (int)counts.size(), (const int*)counts.data(), (const fz_point*)pts.data());
    }
    if (s.contains("points")) {
        std::vector<fz_point> pts;
        for (auto& p : s["points"]) pts.push_back(point_from_json(p));
        if (t == PDF_ANNOT_LINE) {
            if (pts.size() < 2) throw Error("bad_args", "Line needs 2 points");
            mu::call(ctx, pdf_set_annot_line, an, pts[0], pts[1]);
        } else if (mu::call(ctx, pdf_annot_has_vertices, an)) {
            if (pts.size() < 2) throw Error("bad_args", "needs at least 2 points");
            mu::call(ctx, pdf_set_annot_vertices, an, (int)pts.size(), (const fz_point*)pts.data());
        }
    }

    // --- style
    if (t == PDF_ANNOT_FREE_TEXT) {
        const char* font = "Helv";
        float size = 12;
        int n = 3;
        float col[4] = {0, 0, 0, 0};
        if (mu::call(ctx, pdf_annot_has_default_appearance, an)) mu::call(ctx, pdf_annot_default_appearance, an, &font, &size, &n, col);
        std::string f = s.value("font", std::string(font ? font : "Helv"));
        if (f != "Helv" && f != "TiRo" && f != "Cour") throw Error("bad_args", "FreeText font must be Helv, TiRo or Cour");
        if (s.contains("fontSize")) size = arg_float(s, "fontSize");
        if (s.contains("color") && color_from_json(s["color"], c)) {
            n = 3;
            std::memcpy(col, c, sizeof c);
        }
        if (n != 1 && n != 3 && n != 4) { n = 3; col[0] = col[1] = col[2] = 0; }
        mu::call(ctx, pdf_set_annot_default_appearance, an, f.c_str(), size, n, (const float*)col);
        if (s.contains("align")) mu::call(ctx, pdf_set_annot_quadding, an, std::clamp(arg_int(s, "align"), 0, 2));
    } else if (s.contains("color")) {
        int n = color_from_json(s["color"], c);
        mu::call(ctx, pdf_set_annot_color, an, n, (const float*)c);
    }
    if (s.contains("fill") && mu::call(ctx, pdf_annot_has_interior_color, an)) {
        int n = color_from_json(s["fill"], c);
        mu::call(ctx, pdf_set_annot_interior_color, an, n, (const float*)c);
    }
    if (s.contains("opacity")) mu::call(ctx, pdf_set_annot_opacity, an, std::clamp(arg_float(s, "opacity"), 0.0f, 1.0f));
    if (s.contains("borderWidth") && mu::call(ctx, pdf_annot_has_border, an))
        mu::call(ctx, pdf_set_annot_border_width, an, std::max(0.0f, arg_float(s, "borderWidth")));
    if (s.contains("contents")) {
        std::string txt = arg_str(s, "contents");
        mu::call(ctx, pdf_set_annot_contents, an, txt.c_str());
    }
    if (s.contains("author") && mu::call(ctx, pdf_annot_has_author, an)) {
        std::string au = arg_str(s, "author");
        mu::call(ctx, pdf_set_annot_author, an, au.c_str());
    }
    if (s.contains("lineEnding") && mu::call(ctx, pdf_annot_has_line_ending_styles, an)) {
        const json& le = s["lineEnding"];
        if (!le.is_array() || le.size() != 2) throw Error("bad_args", "lineEnding must be [start, end]");
        mu::call(ctx, pdf_set_annot_line_ending_styles, an, ending_from(le[0]), ending_from(le[1]));
    }
    if (t == PDF_ANNOT_TEXT && is_new) {
        mu::call(ctx, pdf_set_annot_icon_name, an, "Note");
    }
    if (t == PDF_ANNOT_STAMP && s.value("image", false)) {
        if (!in || in->empty()) throw Error("bad_args", "Stamp image requires image bytes");
        auto buf = mu::buffer_from(ctx, reinterpret_cast<const unsigned char*>(in->data()), in->size());
        mu::Image img(ctx, mu::call(ctx, fz_new_image_from_buffer, buf.get()));
        mu::call(ctx, pdf_set_annot_stamp_image, an, img.get());
    }
}

json Engine::Impl::add_annotation(const json& a, const Bytes* in) {
    int pno = arg_int(a, "page");
    std::string type = arg_str(a, "type");
    enum pdf_annot_type t = mu::call(ctx, pdf_annot_type_from_string, type.c_str());
    if (!creatable(t)) throw Error("bad_args", "cannot create annotation of type '" + type + "'");
    if ((t == PDF_ANNOT_HIGHLIGHT || t == PDF_ANNOT_UNDERLINE || t == PDF_ANNOT_STRIKE_OUT || t == PDF_ANNOT_SQUIGGLY) &&
        !a.contains("quads"))
        throw Error("bad_args", type + " needs quads");
    if (t == PDF_ANNOT_INK && !a.contains("ink")) throw Error("bad_args", "Ink needs ink strokes");
    if ((t == PDF_ANNOT_LINE || t == PDF_ANNOT_POLYGON || t == PDF_ANNOT_POLY_LINE) && !a.contains("points"))
        throw Error("bad_args", type + " needs points");
    auto page = load_page(pno);
    int id = 0;
    journaled("Add annotation", [&] {
        mu::Annot an(ctx, mu::call(ctx, pdf_create_annot, page.get(), t));
        apply_spec(*this, an.get(), a, in, true);
        mu::call(ctx, pdf_update_annot, an.get());
        id = mu::call(ctx, pdf_to_num, mu::call(ctx, pdf_annot_obj, an.get()));
    });
    return {{"id", id}};
}

json Engine::Impl::update_annotation(const json& a) {
    int pno = arg_int(a, "page");
    int id = arg_int(a, "id");
    auto page = load_page(pno);
    pdf_annot* an = find_annot(ctx, page.get(), id);
    if (a.contains("type") && a["type"] != mu::call(ctx, pdf_string_from_annot_type, mu::call(ctx, pdf_annot_type, an)))
        throw Error("bad_args", "annotation type cannot be changed");
    journaled("Edit annotation", [&] {
        // Stamps with a custom image keep their appearance: only the /Rect moves,
        // and the appearance stream is scaled into it by every viewer.
        bool keep_ap = mu::call(ctx, pdf_annot_type, an) == PDF_ANNOT_STAMP && !a.contains("image");
        if (keep_ap && a.contains("rect") && a.size() <= 4) {
            fz_rect r = rect_from_json(a["rect"]);
            fz_matrix inv = fz_invert_matrix(page_ctm(page.get()));
            fz_rect pr = fz_transform_rect(r, inv);
            mu::call(ctx, pdf_dict_put_rect, mu::call(ctx, pdf_annot_obj, an), PDF_NAME(Rect), pr);
            if (a.contains("opacity")) mu::call(ctx, pdf_set_annot_opacity, an, std::clamp(arg_float(a, "opacity"), 0.0f, 1.0f));
            return;
        }
        apply_spec(*this, an, a, nullptr, false);
        mu::call(ctx, pdf_update_annot, an);
    });
    return json::object();
}

json Engine::Impl::delete_annotation(const json& a) {
    int pno = arg_int(a, "page");
    int id = arg_int(a, "id");
    auto page = load_page(pno);
    pdf_annot* an = find_annot(ctx, page.get(), id);
    journaled("Delete annotation", [&] { mu::call(ctx, pdf_delete_annot, page.get(), an); });
    return json::object();
}

}  // namespace pdfedit
