// Engine lifecycle, dispatch, open/info/render/save/metadata/history.
#include <algorithm>
#include <cmath>
#include <cstring>
#include <exception>
#include <unordered_map>

#include "impl.hpp"

namespace pdfedit {

// ---------------------------------------------------------------- mu helpers
namespace mu {

void rethrow(fz_context* ctx) {
    int code = 0;
    const char* msg = fz_convert_error(ctx, &code);
    std::string m = msg ? msg : "unknown MuPDF error";
    if (code == FZ_ERROR_ARGUMENT) throw Error("bad_args", m);
    if (code == FZ_ERROR_UNSUPPORTED) throw Error("unsupported", m);
    throw Error("mupdf", m);
}

std::string buffer_bytes(fz_context* ctx, fz_buffer* buf) {
    unsigned char* data = nullptr;
    size_t len = fz_buffer_storage(ctx, buf, &data);
    return std::string(reinterpret_cast<const char*>(data), len);
}

Buffer buffer_from(fz_context* ctx, const unsigned char* data, size_t len) {
    return Buffer(ctx, call(ctx, fz_new_buffer_from_copied_data, data, len));
}

}  // namespace mu

// ---------------------------------------------------------------- json helpers
const json& arg(const json& a, const char* key) {
    auto it = a.find(key);
    if (it == a.end() || it->is_null()) throw Error("bad_args", std::string("missing argument '") + key + "'");
    return *it;
}
int arg_int(const json& a, const char* key) {
    const json& v = arg(a, key);
    if (!v.is_number()) throw Error("bad_args", std::string("argument '") + key + "' must be a number");
    return v.get<int>();
}
float arg_float(const json& a, const char* key) {
    const json& v = arg(a, key);
    if (!v.is_number()) throw Error("bad_args", std::string("argument '") + key + "' must be a number");
    float f = v.get<float>();
    if (!std::isfinite(f)) throw Error("bad_args", std::string("argument '") + key + "' must be finite");
    return f;
}
std::string arg_str(const json& a, const char* key) {
    const json& v = arg(a, key);
    if (!v.is_string()) throw Error("bad_args", std::string("argument '") + key + "' must be a string");
    return v.get<std::string>();
}

static float num(const json& v, const char* what) {
    if (!v.is_number()) throw Error("bad_args", std::string(what) + " must contain numbers");
    float f = v.get<float>();
    if (!std::isfinite(f)) throw Error("bad_args", std::string(what) + " must be finite");
    return f;
}

fz_rect rect_from_json(const json& j) {
    if (!j.is_array() || j.size() != 4) throw Error("bad_args", "rect must be [x0,y0,x1,y1]");
    fz_rect r{num(j[0], "rect"), num(j[1], "rect"), num(j[2], "rect"), num(j[3], "rect")};
    if (r.x0 > r.x1) std::swap(r.x0, r.x1);
    if (r.y0 > r.y1) std::swap(r.y0, r.y1);
    return r;
}
json rect_to_json(fz_rect r) { return json::array({r.x0, r.y0, r.x1, r.y1}); }
fz_point point_from_json(const json& j) {
    if (!j.is_array() || j.size() != 2) throw Error("bad_args", "point must be [x,y]");
    return fz_point{num(j[0], "point"), num(j[1], "point")};
}
json point_to_json(fz_point p) { return json::array({p.x, p.y}); }
fz_quad quad_from_json(const json& j) {
    if (!j.is_array() || j.size() != 8) throw Error("bad_args", "quad must have 8 numbers");
    float v[8];
    for (int i = 0; i < 8; ++i) v[i] = num(j[i], "quad");
    return fz_quad{{v[0], v[1]}, {v[2], v[3]}, {v[4], v[5]}, {v[6], v[7]}};
}
json quad_to_json(fz_quad q) {
    return json::array({q.ul.x, q.ul.y, q.ur.x, q.ur.y, q.ll.x, q.ll.y, q.lr.x, q.lr.y});
}
int color_from_json(const json& j, float out[3]) {
    if (j.is_null()) return 0;
    if (!j.is_array() || (j.size() != 3 && j.size() != 0)) throw Error("bad_args", "color must be [r,g,b]");
    if (j.empty()) return 0;
    for (int i = 0; i < 3; ++i) out[i] = std::clamp(num(j[i], "color"), 0.0f, 1.0f);
    return 3;
}
json color_to_json(int n, const float* c) {
    if (n == 0) return nullptr;
    if (n == 1) return json::array({c[0], c[0], c[0]});
    if (n == 4) {  // CMYK -> RGB (naive, display only)
        return json::array({(1 - c[0]) * (1 - c[3]), (1 - c[1]) * (1 - c[3]), (1 - c[2]) * (1 - c[3])});
    }
    return json::array({c[0], c[1], c[2]});
}

// ---------------------------------------------------------------- lifecycle
Engine::Impl::Impl() {
#ifdef __EMSCRIPTEN__
    size_t store = 64u << 20;
#else
    size_t store = FZ_STORE_DEFAULT;
#endif
    ctx = fz_new_context(nullptr, nullptr, store);
    if (!ctx) throw Error("mupdf", "cannot create MuPDF context");
    mu::call(ctx, fz_register_document_handlers);
    install_font_hooks(ctx);
    // Quiet the console: errors are reported through the API.
    fz_set_warning_callback(ctx, [](void*, const char*) {}, nullptr);
    fz_set_error_callback(ctx, [](void*, const char*) {}, nullptr);
}

Engine::Impl::~Impl() {
    user_fonts.clear();
    if (doc) pdf_drop_document(ctx, doc);
    fz_drop_context(ctx);
}

Engine::Engine() : impl_(std::make_unique<Impl>()) {}
Engine::~Engine() = default;

void Engine::Impl::require_doc() const {
    if (!doc) throw Error("no_document", "no document is open");
    if (locked) throw Error("needs_password", "document is password protected");
}

int Engine::Impl::page_count() { return mu::call(ctx, pdf_count_pages, doc); }

mu::Page Engine::Impl::load_page(int index) {
    require_doc();
    int n = page_count();
    if (index < 0 || index >= n)
        throw Error("bad_page", "page " + std::to_string(index) + " out of range (0.." + std::to_string(n - 1) + ")");
    return mu::Page(ctx, mu::call(ctx, pdf_load_page, doc, index));
}

pdf_obj* Engine::Impl::page_obj(int index) {
    require_doc();
    int n = page_count();
    if (index < 0 || index >= n) throw Error("bad_page", "page " + std::to_string(index) + " out of range");
    return mu::call(ctx, pdf_lookup_page_obj, doc, index);
}

fz_matrix Engine::Impl::page_ctm(pdf_page* page) {
    fz_rect mediabox;
    fz_matrix ctm;
    fz_try(ctx) { pdf_page_transform(ctx, page, &mediabox, &ctm); }
    fz_catch(ctx) { mu::rethrow(ctx); }
    return ctm;
}

void Engine::Impl::abandon_operation() {
    fz_try(ctx) { pdf_abandon_operation(ctx, doc); }
    fz_catch(ctx) { fz_ignore_error(ctx); }
}

void Engine::Impl::journaled(const char* label, const std::function<void()>& fn) {
    require_doc();
    mu::call(ctx, pdf_begin_operation, doc, label);
    std::exception_ptr failure;
    try {
        fn();
    } catch (...) {
        failure = std::current_exception();
    }
    if (failure) {
        // Roll back whatever part of the operation already happened.
        // (Outside the catch block: wasm EH forbids setjmp inside a catch clause.)
        abandon_operation();
        std::rethrow_exception(failure);
    }
    mu::call(ctx, pdf_end_operation, doc);
}

// ---------------------------------------------------------------- open
static bool looks_like_pdf(const Bytes& b) {
    size_t lim = std::min<size_t>(b.size(), 1024);
    return b.substr(0, lim).find("%PDF") != std::string::npos;
}

static std::string magic_for(const std::string& name, const Bytes& data) {
    if (looks_like_pdf(data)) return "application/pdf";
    auto dot = name.rfind('.');
    if (dot != std::string::npos) return name.substr(dot);  // ".png", ".xps", ...
    return name.empty() ? "application/pdf" : name;
}

mu::Doc Engine::Impl::open_bytes_as_pdf(const Bytes& data, const std::string& name, const std::string& pw,
                                         bool fail_if_locked) {
    if (data.empty()) throw Error("bad_args", "file is empty");
    auto buf = mu::buffer_from(ctx, reinterpret_cast<const unsigned char*>(data.data()), data.size());
    std::string magic = magic_for(name, data);
    mu::FzDoc fzdoc(ctx, mu::call(ctx, fz_open_document_with_buffer, magic.c_str(), buf.get()));

    if (pdf_document* p = pdf_document_from_fz_document(ctx, fzdoc.get())) {
        pdf_keep_document(ctx, p);
        mu::Doc out(ctx, p);
        // NOTE: pdf_needs_password() re-authenticates with "" and would wipe keys
        // from an earlier successful login, so it is only called on fresh docs.
        if (mu::call(ctx, pdf_needs_password, p)) {
            if (pw.empty()) {
                if (fail_if_locked) throw Error("needs_password", "document is password protected");
            } else if (!mu::call(ctx, pdf_authenticate_password, p, pw.c_str())) {
                throw Error("bad_password", "incorrect password");
            }
        } else if (!pw.empty()) {
            // Owner password on a doc with an empty user password: grants full permissions.
            mu::call(ctx, pdf_authenticate_password, p, pw.c_str());
        }
        return out;
    }

    // Not a PDF (image, XPS, EPUB, CBZ...): render each page through the PDF writer.
    if (mu::call(ctx, fz_needs_password, fzdoc.get())) {
        if (pw.empty() || !mu::call(ctx, fz_authenticate_password, fzdoc.get(), pw.c_str()))
            throw Error("needs_password", "document is password protected");
    }
    mu::Buffer outbuf(ctx, mu::call(ctx, fz_new_buffer, (size_t)64 * 1024));
    fz_document_writer* wri = mu::call(ctx, fz_new_document_writer_with_buffer, outbuf.get(), "pdf", "");
    if (mu::call(ctx, fz_is_document_reflowable, fzdoc.get()))
        mu::call(ctx, fz_layout_document, fzdoc.get(), layout_size.x1, layout_size.y1, layout_em);
    int n = mu::call(ctx, fz_count_pages, fzdoc.get());
    if (n <= 0) throw Error("unsupported", "document has no pages");
    try {
        for (int i = 0; i < n; ++i) {
            mu::FzPage page(ctx, mu::call(ctx, fz_load_page, fzdoc.get(), i));
            fz_rect bounds = mu::call(ctx, fz_bound_page, page.get());
            fz_device* dev = mu::call(ctx, fz_begin_page, wri, bounds);
            mu::call(ctx, fz_run_page, page.get(), dev, fz_identity, (fz_cookie*)nullptr);
            mu::call(ctx, fz_end_page, wri);
        }
        mu::call(ctx, fz_close_document_writer, wri);
    } catch (...) {
        fz_drop_document_writer(ctx, wri);
        throw;
    }
    fz_drop_document_writer(ctx, wri);
    mu::Stream stm(ctx, mu::call(ctx, fz_open_buffer, outbuf.get()));
    return mu::Doc(ctx, mu::call(ctx, pdf_open_document_with_stream, stm.get()));
}

json Engine::Impl::version() {
    return {{"api", ENGINE_API_VERSION}, {"mupdf", FZ_VERSION}};
}

json Engine::Impl::open(const json& a, const Bytes* in) {
    if (!in) throw Error("bad_args", "open requires file bytes");
    std::string name = a.value("name", std::string("document.pdf"));
    std::string pw = a.value("password", std::string());
    apply_layout_args(a);
    mu::Doc d = open_bytes_as_pdf(*in, name, pw, false);
    bool is_locked = pw.empty() && mu::call(ctx, pdf_needs_password, d.get());
    if (doc) pdf_drop_document(ctx, doc);
    doc = d.release();
    password = pw;
    locked = is_locked;
    user_fonts.clear();
    if (!locked) mu::call(ctx, pdf_enable_journal, doc);
    return info();
}

// Page size for reflowable inputs: {"pageSize": "A4"|"Letter"|"Legal"|"A3"|"A5"|[w,h], "fontSize": 11}
void Engine::Impl::apply_layout_args(const json& a) {
    if (a.contains("pageSize")) {
        const json& ps = a["pageSize"];
        float w = 0, h = 0;
        if (ps.is_string()) {
            std::string n = ps.get<std::string>();
            if (n == "A4") w = 595, h = 842;
            else if (n == "Letter") w = 612, h = 792;
            else if (n == "Legal") w = 612, h = 1008;
            else if (n == "A3") w = 842, h = 1191;
            else if (n == "A5") w = 420, h = 595;
            else throw Error("bad_args", "unknown pageSize '" + n + "'");
        } else {
            fz_point p = point_from_json(ps);
            w = p.x, h = p.y;
        }
        if (w < 72 || h < 72 || w > 14400 || h > 14400) throw Error("bad_args", "pageSize out of range");
        layout_size = fz_make_rect(0, 0, w, h);
    }
    if (a.contains("fontSize")) {
        float em = arg_float(a, "fontSize");
        if (em < 4 || em > 72) throw Error("bad_args", "fontSize must be in [4, 72]");
        layout_em = em;
    }
}

json Engine::Impl::create(const json& a) {
    apply_layout_args(a);
    int pages = a.value("pages", 1);
    if (pages < 1 || pages > 1000) throw Error("bad_args", "pages must be in [1, 1000]");
    mu::Doc d(ctx, mu::call(ctx, pdf_create_document));
    for (int i = 0; i < pages; ++i) {
        mu::Obj res(ctx, mu::call(ctx, pdf_new_dict, d.get(), 1));
        mu::Buffer contents(ctx, mu::call(ctx, fz_new_buffer, (size_t)16));
        mu::Obj po(ctx, mu::call(ctx, pdf_add_page, d.get(), layout_size, 0, res.get(), contents.get()));
        mu::call(ctx, pdf_insert_page, d.get(), -1, po.get());
    }
    // Round-trip through bytes so the document has a real file behind it, like opened ones.
    mu::Buffer buf(ctx, mu::call(ctx, fz_new_buffer, (size_t)4096));
    {
        mu::Output o(ctx, mu::call(ctx, fz_new_output_with_buffer, buf.get()));
        pdf_write_options wo = pdf_default_write_options;
        mu::call(ctx, pdf_write_document, d.get(), o.get(), (const pdf_write_options*)&wo);
        mu::call(ctx, fz_close_output, o.get());
    }
    Bytes bytes = mu::buffer_bytes(ctx, buf.get());
    return open({{"name", "untitled.pdf"}}, &bytes);
}

json Engine::Impl::formats() {
    // Probe which inputs this build can open (each is converted to PDF on open).
    static const char* const kCandidates[] = {
        "pdf", "xps", "oxps", "epub", "mobi", "fb2", "cbz", "cbr", "cbt", "cb7", "svg",
        "html", "htm", "xhtml", "txt", "text", "log", "md", "docx", "xlsx", "pptx", "hwpx",
        "png", "jpg", "jpeg", "jfif", "jpx", "jp2", "gif", "bmp", "tif", "tiff", "pnm", "pbm",
        "pgm", "ppm", "pam", "pfm", "psd", "jxr", "jxl", "jb2", "jbig2", "webp", "heic", "avif",
        "doc", "odt", "rtf", "xls", "ppt",
    };
    json exts = json::array();
    for (const char* e : kCandidates) {
        std::string probe = std::string("file.") + e;
        const fz_document_handler* h = nullptr;
        fz_try(ctx) { h = fz_recognize_document(ctx, probe.c_str()); }
        fz_catch(ctx) { fz_ignore_error(ctx); h = nullptr; }
        if (h) exts.push_back(e);
    }
    return {{"extensions", exts}};
}

json Engine::Impl::authenticate(const json& a) {
    if (!doc) throw Error("no_document", "no document is open");
    std::string pw = arg_str(a, "password");
    if (!locked) return info();
    if (!mu::call(ctx, pdf_authenticate_password, doc, pw.c_str()))
        throw Error("bad_password", "incorrect password");
    password = pw;
    locked = false;
    mu::call(ctx, pdf_enable_journal, doc);
    return info();
}

json Engine::Impl::info() {
    if (!doc) throw Error("no_document", "no document is open");
    json j;
    j["needsPassword"] = locked;
    j["isPdf"] = true;
    j["encrypted"] = pdf_crypt_method(ctx, doc->crypt) != nullptr && std::strcmp(pdf_crypt_method(ctx, doc->crypt), "None") != 0;
    if (locked) {
        j["pageCount"] = 0;
        j["pages"] = json::array();
        j["canUndo"] = false;
        j["canRedo"] = false;
        j["hasForms"] = false;
        j["title"] = "";
        return j;
    }
    int n = page_count();
    j["pageCount"] = n;
    json pages = json::array();
    for (int i = 0; i < n; ++i) {
        pdf_obj* po = mu::call(ctx, pdf_lookup_page_obj, doc, i);
        fz_rect box;
        fz_matrix ctm;
        fz_try(ctx) { pdf_page_obj_transform(ctx, po, &box, &ctm); }
        fz_catch(ctx) { mu::rethrow(ctx); }
        fz_rect shown = fz_transform_rect(box, ctm);
        int rot = pdf_to_int(ctx, pdf_dict_get_inheritable(ctx, po, PDF_NAME(Rotate)));
        rot = ((rot % 360) + 360) % 360;
        pages.push_back({{"width", shown.x1 - shown.x0}, {"height", shown.y1 - shown.y0}, {"rotation", rot}});
    }
    j["pages"] = std::move(pages);
    j["canUndo"] = (bool)mu::call(ctx, pdf_can_undo, doc);
    j["canRedo"] = (bool)mu::call(ctx, pdf_can_redo, doc);
    pdf_obj* fields = pdf_dict_getp(ctx, pdf_trailer(ctx, doc), "Root/AcroForm/Fields");
    j["hasForms"] = pdf_array_len(ctx, fields) > 0;
    char title[512] = {0};
    fz_try(ctx) { pdf_lookup_metadata(ctx, doc, FZ_META_INFO_TITLE, title, sizeof title); }
    fz_catch(ctx) { fz_ignore_error(ctx); title[0] = 0; }
    j["title"] = std::string(title);
    return j;
}

// ---------------------------------------------------------------- render
static mu::Pixmap render_pixmap(Engine::Impl& E, pdf_page* page, float scale, bool annots, bool widgets,
                                bool alpha_channel) {
    fz_context* ctx = E.ctx;
    fz_matrix ctm = fz_scale(scale, scale);
    fz_rect bounds = mu::call(ctx, pdf_bound_page, page, FZ_CROP_BOX);
    fz_irect bbox = fz_round_rect(fz_transform_rect(bounds, ctm));
    long long w = bbox.x1 - bbox.x0, h = bbox.y1 - bbox.y0;
    if (w <= 0 || h <= 0) throw Error("mupdf", "page has empty bounds");
    if (w * h > 40ll * 1000 * 1000) throw Error("bad_args", "render too large; lower the scale");
    mu::Pixmap pix(ctx, mu::call(ctx, fz_new_pixmap_with_bbox, fz_device_rgb(ctx), bbox, (fz_separations*)nullptr,
                                 alpha_channel ? 1 : 0));
    mu::call(ctx, fz_clear_pixmap_with_value, pix.get(), 0xff);
    mu::Device dev(ctx, mu::call(ctx, fz_new_draw_device, fz_identity, pix.get()));
    mu::call(ctx, pdf_run_page_contents, page, dev.get(), ctm, (fz_cookie*)nullptr);
    if (annots) mu::call(ctx, pdf_run_page_annots, page, dev.get(), ctm, (fz_cookie*)nullptr);
    if (widgets) mu::call(ctx, pdf_run_page_widgets, page, dev.get(), ctm, (fz_cookie*)nullptr);
    mu::call(ctx, fz_close_device, dev.get());
    return pix;
}

json Engine::Impl::render(const json& a, Bytes& out) {
    int pno = arg_int(a, "page");
    float scale = a.contains("scale") ? arg_float(a, "scale") : 1.0f;
    if (scale <= 0 || scale > 16) throw Error("bad_args", "scale must be in (0, 16]");
    auto page = load_page(pno);
    auto pix = render_pixmap(*this, page.get(), scale, a.value("annots", true), a.value("widgets", true), true);
    int w = fz_pixmap_width(ctx, pix.get()), h = fz_pixmap_height(ctx, pix.get());
    int stride = fz_pixmap_stride(ctx, pix.get());
    const unsigned char* s = fz_pixmap_samples(ctx, pix.get());
    out.resize((size_t)w * h * 4);
    for (int y = 0; y < h; ++y) std::memcpy(&out[(size_t)y * w * 4], s + (size_t)y * stride, (size_t)w * 4);
    return {{"width", w}, {"height", h}};
}

json Engine::Impl::export_page_image(const json& a, Bytes& out) {
    int pno = arg_int(a, "page");
    float dpi = a.contains("dpi") ? arg_float(a, "dpi") : 150.0f;
    if (dpi < 18 || dpi > 1200) throw Error("bad_args", "dpi must be in [18, 1200]");
    std::string fmt = a.value("format", std::string("png"));
    auto page = load_page(pno);
    auto pix = render_pixmap(*this, page.get(), dpi / 72.0f, true, true, false);
    fz_set_pixmap_resolution(ctx, pix.get(), (int)dpi, (int)dpi);
    mu::Buffer buf;
    if (fmt == "png")
        buf = mu::Buffer(ctx, mu::call(ctx, fz_new_buffer_from_pixmap_as_png, pix.get(), fz_default_color_params));
    else if (fmt == "jpeg" || fmt == "jpg")
        buf = mu::Buffer(ctx, mu::call(ctx, fz_new_buffer_from_pixmap_as_jpeg, pix.get(), fz_default_color_params,
                                       a.value("quality", 90), 0));
    else
        throw Error("bad_args", "format must be png or jpeg");
    out = mu::buffer_bytes(ctx, buf.get());
    return json::object();
}

// ---------------------------------------------------------------- metadata
static const char* META_KEYS[][2] = {
    {"title", "info:Title"},       {"author", "info:Author"},     {"subject", "info:Subject"},
    {"keywords", "info:Keywords"}, {"creator", "info:Creator"},   {"producer", "info:Producer"},
};

json Engine::Impl::get_metadata() {
    require_doc();
    json j;
    for (auto& k : META_KEYS) {
        char buf[2048] = {0};
        fz_try(ctx) { pdf_lookup_metadata(ctx, doc, k[1], buf, sizeof buf); }
        fz_catch(ctx) { fz_ignore_error(ctx); buf[0] = 0; }
        j[k[0]] = std::string(buf);
    }
    return j;
}

json Engine::Impl::set_metadata(const json& a) {
    journaled("Edit metadata", [&] {
        for (auto& k : META_KEYS) {
            if (std::strcmp(k[0], "creator") == 0 || std::strcmp(k[0], "producer") == 0) continue;
            if (a.contains(k[0])) {
                if (!a[k[0]].is_string()) throw Error("bad_args", std::string(k[0]) + " must be a string");
                std::string v = a[k[0]].get<std::string>();
                mu::call(ctx, fz_set_metadata, &doc->super, k[1], v.c_str());
            }
        }
    });
    return json::object();
}

// ---------------------------------------------------------------- history
json Engine::Impl::undo() {
    require_doc();
    if (!mu::call(ctx, pdf_can_undo, doc)) throw Error("not_found", "nothing to undo");
    mu::call(ctx, pdf_undo, doc);
    return info();
}

json Engine::Impl::redo() {
    require_doc();
    if (!mu::call(ctx, pdf_can_redo, doc)) throw Error("not_found", "nothing to redo");
    mu::call(ctx, pdf_redo, doc);
    return info();
}

// ---------------------------------------------------------------- fonts
json Engine::Impl::register_font(const json& a, const Bytes* in) {
    std::string name = arg_str(a, "name");
    if (!in || in->empty()) throw Error("bad_args", "registerFont requires font bytes");
    auto buf = mu::buffer_from(ctx, reinterpret_cast<const unsigned char*>(in->data()), in->size());
    mu::Font font(ctx, mu::call(ctx, fz_new_font_from_buffer, name.c_str(), buf.get(), 0, 0));
    std::string family = fz_font_name(ctx, font.get());
    user_fonts[name] = std::move(font);
    return {{"name", name}, {"family", family}};
}

// ---------------------------------------------------------------- save
// Deep-copy the live document into an independent, unencrypted pdf_document.
//
// Why not pdf_write_document()/pdf_write_snapshot() on the live doc? MuPDF's
// undo journal keeps edits in the incremental xref section. A snapshot is an
// incremental write that marks that section as saved (the next snapshot then
// drops every earlier edit), and a full write merges it into a solid xref
// (undo silently stops working). Grafting only *reads* the live document.
Bytes Engine::Impl::snapshot() {
    mu::Doc dst(ctx, mu::call(ctx, pdf_create_document));
    {
        mu::GraftMap map(ctx, mu::call(ctx, pdf_new_graft_map, dst.get()));
        pdf_obj* src_trailer = mu::call(ctx, pdf_trailer, doc);
        pdf_obj* dst_trailer = mu::call(ctx, pdf_trailer, dst.get());
        for (pdf_obj* key : {PDF_NAME(Root), PDF_NAME(Info)}) {
            pdf_obj* v = mu::call(ctx, pdf_dict_get, src_trailer, key);
            if (!v) continue;
            mu::Obj copy(ctx, mu::call(ctx, pdf_graft_mapped_object, map.get(), v));
            mu::call(ctx, pdf_dict_put, dst_trailer, key, copy.get());
        }
    }
    // Serialise (dropping the placeholder catalog pdf_create_document made) so
    // the copy is reopened with clean internal state.
    mu::Buffer buf(ctx, mu::call(ctx, fz_new_buffer, (size_t)256 * 1024));
    mu::Output out(ctx, mu::call(ctx, fz_new_output_with_buffer, buf.get()));
    pdf_write_options wo = pdf_default_write_options;
    wo.do_garbage = 1;
    mu::call(ctx, pdf_write_document, dst.get(), out.get(), (const pdf_write_options*)&wo);
    mu::call(ctx, fz_close_output, out.get());
    return mu::buffer_bytes(ctx, buf.get());
}

static int permissions_from_json(const json& p) {
    // Start from "everything allowed", clear what the caller denies.
    int perm = PDF_PERM_PRINT | PDF_PERM_MODIFY | PDF_PERM_COPY | PDF_PERM_ANNOTATE | PDF_PERM_FORM |
               PDF_PERM_ACCESSIBILITY | PDF_PERM_ASSEMBLE | PDF_PERM_PRINT_HQ;
    auto deny = [&](const char* k, int bits) {
        if (p.contains(k) && p[k].is_boolean() && !p[k].get<bool>()) perm &= ~bits;
    };
    deny("print", PDF_PERM_PRINT | PDF_PERM_PRINT_HQ);
    deny("copy", PDF_PERM_COPY);
    deny("edit", PDF_PERM_MODIFY | PDF_PERM_ASSEMBLE);
    deny("annotate", PDF_PERM_ANNOTATE);
    deny("forms", PDF_PERM_FORM);
    return perm;
}

json Engine::Impl::save(const json& a, Bytes& out) {
    require_doc();
    // Work on a copy so saving (garbage collection renumbers objects, baking
    // flattens annotations...) never disturbs the live, journaled document.
    Bytes snap = snapshot();
    mu::Doc copy = open_bytes_as_pdf(snap, "snapshot.pdf", "", true);
    pdf_document* d = copy.get();
    pdf_obj* live_encrypt = mu::call(ctx, pdf_dict_get, mu::call(ctx, pdf_trailer, doc), PDF_NAME(Encrypt));

    if (a.value("flatten", false)) mu::call(ctx, pdf_bake_document, d, 1, 1);

    if (a.value("compressImages", false)) {
        int dpi = a.value("imageDpi", 150);
        if (dpi < 36 || dpi > 1200) throw Error("bad_args", "imageDpi must be in [36, 1200]");
        pdf_image_rewriter_options io;
        std::memset(&io, 0, sizeof io);
        char quality[] = "75";
        io.color_lossy_image_subsample_method = FZ_SUBSAMPLE_BICUBIC;
        io.color_lossless_image_subsample_method = FZ_SUBSAMPLE_BICUBIC;
        io.gray_lossy_image_subsample_method = FZ_SUBSAMPLE_BICUBIC;
        io.gray_lossless_image_subsample_method = FZ_SUBSAMPLE_BICUBIC;
        io.color_lossy_image_subsample_threshold = io.color_lossless_image_subsample_threshold = dpi * 3 / 2;
        io.color_lossy_image_subsample_to = io.color_lossless_image_subsample_to = dpi;
        io.gray_lossy_image_subsample_threshold = io.gray_lossless_image_subsample_threshold = dpi * 3 / 2;
        io.gray_lossy_image_subsample_to = io.gray_lossless_image_subsample_to = dpi;
        io.color_lossy_image_recompress_method = FZ_RECOMPRESS_JPEG;
        io.color_lossless_image_recompress_method = FZ_RECOMPRESS_JPEG;
        io.gray_lossy_image_recompress_method = FZ_RECOMPRESS_JPEG;
        io.gray_lossless_image_recompress_method = FZ_RECOMPRESS_JPEG;
        io.color_lossy_image_recompress_quality = quality;
        io.color_lossless_image_recompress_quality = quality;
        io.gray_lossy_image_recompress_quality = quality;
        io.gray_lossless_image_recompress_quality = quality;
        io.recompress_when = FZ_RECOMPRESS_WHEN_SMALLER;
        mu::call(ctx, pdf_rewrite_images, d, &io);
    }

    if (a.value("subsetFonts", true)) {
        fz_try(ctx) { pdf_subset_fonts(ctx, d, 0, nullptr); }
        fz_catch(ctx) { fz_ignore_error(ctx); }  // subsetting is an optimisation; never fail a save on it
    }

    pdf_write_options wo = pdf_default_write_options;
    int garbage = a.value("garbage", 3);
    if (garbage < 0 || garbage > 4) throw Error("bad_args", "garbage must be 0..4");
    wo.do_garbage = garbage;
    bool compress = a.value("compress", true);
    wo.do_compress = compress ? 1 : 0;
    wo.do_compress_images = compress ? 1 : 0;
    wo.do_compress_fonts = compress ? 1 : 0;
    wo.do_use_objstms = compress ? 1 : 0;
    wo.do_linear = a.value("linearize", false) ? 1 : 0;
    if (wo.do_linear) wo.do_use_objstms = 0;
    wo.do_encrypt = PDF_ENCRYPT_NONE;

    if (live_encrypt && !a.value("decrypt", false)) {
        // Keep the file protected: AES-256, same open password, same permission
        // bits. The original owner password is not recoverable, so a random one
        // is used (use "encrypt" to set explicit passwords). Never downgrades:
        // a file that needed a password to open still needs it.
        int p = (int)pdf_to_int(ctx, mu::call(ctx, pdf_dict_get, live_encrypt, PDF_NAME(P)));
        unsigned char rnd[16];
        fz_memrnd(ctx, rnd, sizeof rnd);
        char owner[33];
        for (int i = 0; i < 16; ++i) std::snprintf(owner + i * 2, 3, "%02x", rnd[i]);
        if (password.size() >= sizeof wo.upwd_utf8) throw Error("bad_args", "password too long");
        wo.do_encrypt = PDF_ENCRYPT_AES_256;
        std::strncpy(wo.opwd_utf8, owner, sizeof wo.opwd_utf8 - 1);
        std::strncpy(wo.upwd_utf8, password.c_str(), sizeof wo.upwd_utf8 - 1);
        wo.permissions = p;
    }
    if (a.contains("encrypt") && a["encrypt"].is_object()) {
        const json& e = a["encrypt"];
        std::string owner = e.value("ownerPassword", std::string());
        std::string user = e.value("userPassword", std::string());
        if (owner.empty() && user.empty()) throw Error("bad_args", "encrypt needs ownerPassword or userPassword");
        if (owner.empty()) owner = user;
        if (owner.size() >= sizeof wo.opwd_utf8 || user.size() >= sizeof wo.upwd_utf8)
            throw Error("bad_args", "password too long (max 127 bytes)");
        wo.do_encrypt = PDF_ENCRYPT_AES_256;
        std::strncpy(wo.opwd_utf8, owner.c_str(), sizeof wo.opwd_utf8 - 1);
        std::strncpy(wo.upwd_utf8, user.c_str(), sizeof wo.upwd_utf8 - 1);
        wo.permissions = permissions_from_json(e.value("permissions", json::object()));
    }

    mu::Buffer buf(ctx, mu::call(ctx, fz_new_buffer, snap.size() + 1024));
    mu::Output outp(ctx, mu::call(ctx, fz_new_output_with_buffer, buf.get()));
    mu::call(ctx, pdf_write_document, d, outp.get(), (const pdf_write_options*)&wo);
    mu::call(ctx, fz_close_output, outp.get());
    out = mu::buffer_bytes(ctx, buf.get());
    return {{"size", out.size()}};
}

// ---------------------------------------------------------------- dispatch
Result Engine::invoke(const std::string& method, const json& args, const Bytes* in) {
    Impl& E = *impl_;
    const json& a = args.is_object() ? args : json::object();
    if (!args.is_object() && !args.is_null()) throw Error("bad_args", "args must be a JSON object");
    Result r;
    Bytes out;
    auto with_bytes = [&](json v) {
        r.value = std::move(v);
        r.bytes = std::move(out);
    };

    using Fn = std::function<void()>;
    const std::unordered_map<std::string, Fn> table = {
        {"version", [&] { r.value = E.version(); }},
        {"open", [&] { r.value = E.open(a, in); }},
        {"create", [&] { r.value = E.create(a); }},
        {"formats", [&] { r.value = E.formats(); }},
        {"authenticate", [&] { r.value = E.authenticate(a); }},
        {"info", [&] { r.value = E.info(); }},
        {"render", [&] { with_bytes(E.render(a, out)); }},
        {"exportPageImage", [&] { with_bytes(E.export_page_image(a, out)); }},
        {"textLayout", [&] { r.value = E.text_layout(a); }},
        {"search", [&] { r.value = E.search(a); }},
        {"replaceText", [&] { r.value = E.replace_text(a); }},
        {"addText", [&] { r.value = E.add_text(a); }},
        {"addImage", [&] { r.value = E.add_image(a, in); }},
        {"listAnnotations", [&] { r.value = E.list_annotations(a); }},
        {"addAnnotation", [&] { r.value = E.add_annotation(a, in); }},
        {"updateAnnotation", [&] { r.value = E.update_annotation(a); }},
        {"deleteAnnotation", [&] { r.value = E.delete_annotation(a); }},
        {"listFields", [&] { r.value = E.list_fields(a); }},
        {"setFieldValue", [&] { r.value = E.set_field_value(a); }},
        {"addField", [&] { r.value = E.add_field(a); }},
        {"deleteField", [&] { r.value = E.delete_field(a); }},
        {"redact", [&] { r.value = E.redact(a); }},
        {"rotatePages", [&] { r.value = E.rotate_pages(a); }},
        {"deletePages", [&] { r.value = E.delete_pages(a); }},
        {"reorderPages", [&] { r.value = E.reorder_pages(a); }},
        {"insertBlankPage", [&] { r.value = E.insert_blank_page(a); }},
        {"insertDocument", [&] { r.value = E.insert_document(a, in); }},
        {"extractPages", [&] { with_bytes(E.extract_pages(a, out)); }},
        {"registerFont", [&] { r.value = E.register_font(a, in); }},
        {"getMetadata", [&] { r.value = E.get_metadata(); }},
        {"setMetadata", [&] { r.value = E.set_metadata(a); }},
        {"undo", [&] { r.value = E.undo(); }},
        {"redo", [&] { r.value = E.redo(); }},
        {"save", [&] { with_bytes(E.save(a, out)); }},
    };
    auto it = table.find(method);
    if (it == table.end()) throw Error("bad_args", "unknown method '" + method + "'");
    it->second();
    return r;
}

std::string Engine::call(const std::string& method, const std::string& args_json, const Bytes* in) {
    last_bytes_.reset();
    json res;
    try {
        json args = args_json.empty() ? json::object() : json::parse(args_json);
        Result r = invoke(method, args, in);
        last_bytes_ = std::move(r.bytes);
        res = {{"ok", true}, {"result", std::move(r.value)}};
    } catch (const Error& e) {
        res = {{"ok", false}, {"error", {{"code", e.code()}, {"message", e.what()}}}};
    } catch (const json::exception& e) {
        res = {{"ok", false}, {"error", {{"code", "bad_args"}, {"message", e.what()}}}};
    } catch (const std::bad_alloc&) {
        res = {{"ok", false}, {"error", {{"code", "mupdf"}, {"message", "out of memory"}}}};
    } catch (const std::exception& e) {
        res = {{"ok", false}, {"error", {{"code", "mupdf"}, {"message", e.what()}}}};
    }
    return res.dump(-1, ' ', false, json::error_handler_t::replace);
}

}  // namespace pdfedit
