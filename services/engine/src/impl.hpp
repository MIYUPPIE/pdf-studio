// Internal engine state shared by the src/*.cpp translation units.
#pragma once

#include <functional>
#include <map>
#include <string>
#include <vector>

#include "mu.hpp"
#include "pdfedit/engine.hpp"

namespace pdfedit {

// Helpers for JSON <-> MuPDF geometry (page space, see contract).
fz_rect rect_from_json(const json& j);
json rect_to_json(fz_rect r);
fz_point point_from_json(const json& j);
json point_to_json(fz_point p);
fz_quad quad_from_json(const json& j);
json quad_to_json(fz_quad q);
// Color [r,g,b] 0..1. Returns number of components written (0 for null/empty).
int color_from_json(const json& j, float out[3]);
json color_to_json(int n, const float* c);

// Arguments helpers that raise bad_args with a precise message.
int arg_int(const json& a, const char* key);
float arg_float(const json& a, const char* key);
std::string arg_str(const json& a, const char* key);
const json& arg(const json& a, const char* key);

void install_font_hooks(fz_context* ctx);

struct Engine::Impl {
    Impl();
    ~Impl();

    fz_context* ctx = nullptr;
    pdf_document* doc = nullptr;
    std::string password;               // last successful password, reused for snapshots on save
    bool locked = false;                // opened but not yet authenticated
    std::map<std::string, mu::Font> user_fonts;  // registerFont

    // --- core.cpp
    json version();
    json open(const json& a, const Bytes* in);
    json authenticate(const json& a);
    json info();
    json render(const json& a, Bytes& out);
    json export_page_image(const json& a, Bytes& out);
    json get_metadata();
    json set_metadata(const json& a);
    json undo();
    json redo();
    json save(const json& a, Bytes& out);
    json register_font(const json& a, const Bytes* in);
    json create(const json& a);
    json formats();
    void apply_layout_args(const json& a);
    fz_rect layout_size = {0, 0, 595, 842};  // page box for reflowable inputs (HTML, DOCX, TXT...)
    float layout_em = 11;

    // --- pages.cpp
    json rotate_pages(const json& a);
    json delete_pages(const json& a);
    json reorder_pages(const json& a);
    json insert_blank_page(const json& a);
    json insert_document(const json& a, const Bytes* in);
    json extract_pages(const json& a, Bytes& out);

    // --- text.cpp
    json text_layout(const json& a);
    json search(const json& a);
    json replace_text(const json& a);
    json add_text(const json& a);
    json add_image(const json& a, const Bytes* in);
    json redact(const json& a);

    // --- annots.cpp
    json list_annotations(const json& a);
    json add_annotation(const json& a, const Bytes* in);
    json update_annotation(const json& a);
    json delete_annotation(const json& a);

    // --- forms.cpp
    json list_fields(const json& a);
    json set_field_value(const json& a);
    json add_field(const json& a);
    json delete_field(const json& a);

    // --- shared helpers (core.cpp unless noted)
    void require_doc() const;
    int page_count();
    mu::Page load_page(int index);       // validates index, throws bad_page
    pdf_obj* page_obj(int index);
    fz_matrix page_ctm(pdf_page* page);  // PDF user space -> page space
    // Open arbitrary bytes as a pdf_document in this context (converts non-PDF formats).
    // fail_if_locked: throw needs_password instead of returning a locked document.
    mu::Doc open_bytes_as_pdf(const Bytes& data, const std::string& name, const std::string& pw,
                              bool fail_if_locked);
    // Serialize the current document (snapshot keeps the live doc untouched).
    Bytes snapshot();
    // Run fn as one undoable journal operation.
    void journaled(const char* label, const std::function<void()>& fn);
    void abandon_operation();

    // --- writer.cpp: append new content to a page inside an isolated Form XObject.
    // draw() receives a pdf output device whose coordinate system is page space.
    void append_page_content(int page, const std::function<void(fz_device*)>& draw);
    // Resolve a font by contract FontName (standard 14 names or a registered font).
    fz_font* resolve_font(const std::string& name, mu::Font& holder);
};

// Accumulates positioned glyphs (page space) and paints them through a device.
// Missing glyphs fall back per character (fz_encode_character_with_fallback);
// fonts that cannot be embedded fall back to Helvetica.
class TextPainter {
public:
    explicit TextPainter(Engine::Impl& E) : E_(E) {}
    // One glyph at a baseline origin. hscale stretches along the baseline.
    // Returns the advance in page units.
    float glyph(fz_font* font, int c, fz_point origin, fz_point dir, float size, float hscale, const float color[3]);
    // A single line of text; returns its advance.
    float line(fz_font* font, const std::vector<int>& cps, fz_point origin, fz_point dir, float size, float hscale,
               const float color[3]);
    // Possibly multi-line text ("\n" moves down by line_height * size).
    void text(fz_font* font, const std::string& utf8, fz_point origin, fz_point dir, float size, float hscale,
              const float color[3], float line_height);
    void fill(fz_device* dev);
    bool empty() const { return runs_.empty(); }

private:
    struct Run {
        float color[3];
        mu::Text text;
    };
    fz_text* run_for(const float color[3]);
    fz_font* helvetica();
    Engine::Impl& E_;
    std::vector<Run> runs_;
    mu::Font helv_;
};

std::vector<int> utf8_codepoints(const std::string& s);
fz_point unit(fz_point dir);

}  // namespace pdfedit
