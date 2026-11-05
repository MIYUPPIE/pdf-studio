// Page-level operations: rotate, delete, reorder, insert blank, merge, extract.
#include <algorithm>
#include <set>

#include "impl.hpp"

namespace pdfedit {

static std::vector<int> page_list(const json& a, const char* key, int count, bool allow_empty = false) {
    const json& v = arg(a, key);
    if (!v.is_array()) throw Error("bad_args", std::string(key) + " must be an array of page indices");
    std::vector<int> out;
    for (auto& p : v) {
        if (!p.is_number_integer()) throw Error("bad_args", std::string(key) + " must contain integers");
        int i = p.get<int>();
        if (i < 0 || i >= count) throw Error("bad_page", "page " + std::to_string(i) + " out of range");
        out.push_back(i);
    }
    if (out.empty() && !allow_empty) throw Error("bad_args", std::string(key) + " must not be empty");
    return out;
}

json Engine::Impl::rotate_pages(const json& a) {
    require_doc();
    auto pages = page_list(a, "pages", page_count());
    int deg = arg_int(a, "degrees");
    if (deg % 90 != 0) throw Error("bad_args", "degrees must be a multiple of 90");
    journaled("Rotate pages", [&] {
        for (int p : std::set<int>(pages.begin(), pages.end())) {
            pdf_obj* po = page_obj(p);
            int cur = pdf_to_int(ctx, mu::call(ctx, pdf_dict_get_inheritable, po, PDF_NAME(Rotate)));
            int next = (((cur + deg) % 360) + 360) % 360;
            mu::call(ctx, pdf_dict_put_int, po, PDF_NAME(Rotate), (int64_t)next);
        }
    });
    return info();
}

json Engine::Impl::delete_pages(const json& a) {
    require_doc();
    int n = page_count();
    auto pages = page_list(a, "pages", n);
    std::set<int> uniq(pages.begin(), pages.end());
    if ((int)uniq.size() >= n) throw Error("bad_args", "cannot delete every page of a document");
    journaled("Delete pages", [&] {
        for (auto it = uniq.rbegin(); it != uniq.rend(); ++it) mu::call(ctx, pdf_delete_page, doc, *it);
    });
    return info();
}

json Engine::Impl::reorder_pages(const json& a) {
    require_doc();
    auto order = page_list(a, "order", page_count());
    journaled("Reorder pages", [&] {
        mu::call(ctx, pdf_rearrange_pages, doc, (int)order.size(), (const int*)order.data(), PDF_CLEAN_STRUCTURE_KEEP);
    });
    return info();
}

json Engine::Impl::insert_blank_page(const json& a) {
    require_doc();
    int n = page_count();
    int at = arg_int(a, "at");
    if (at < 0 || at > n) throw Error("bad_page", "insert position out of range");
    float w = a.contains("width") ? arg_float(a, "width") : 595.0f;
    float h = a.contains("height") ? arg_float(a, "height") : 842.0f;
    if (w < 3 || h < 3 || w > 14400 || h > 14400) throw Error("bad_args", "page size must be in [3, 14400] points");
    journaled("Insert page", [&] {
        mu::Obj res(ctx, mu::call(ctx, pdf_new_dict, doc, 1));
        mu::Buffer contents(ctx, mu::call(ctx, fz_new_buffer, (size_t)16));
        mu::Obj po(ctx, mu::call(ctx, pdf_add_page, doc, fz_make_rect(0, 0, w, h), 0, res.get(), contents.get()));
        mu::call(ctx, pdf_insert_page, doc, at, po.get());
    });
    return info();
}

json Engine::Impl::insert_document(const json& a, const Bytes* in) {
    require_doc();
    if (!in) throw Error("bad_args", "insertDocument requires file bytes");
    int n = page_count();
    int at = a.contains("at") ? arg_int(a, "at") : n;
    if (at < 0 || at > n) throw Error("bad_page", "insert position out of range");
    mu::Doc src = open_bytes_as_pdf(*in, a.value("name", std::string("insert.pdf")), a.value("password", std::string()), true);
    int sn = mu::call(ctx, pdf_count_pages, src.get());
    journaled("Insert document", [&] {
        mu::GraftMap map(ctx, mu::call(ctx, pdf_new_graft_map, doc));
        for (int i = 0; i < sn; ++i) mu::call(ctx, pdf_graft_mapped_page, map.get(), at + i, src.get(), i);
    });
    return info();
}

json Engine::Impl::extract_pages(const json& a, Bytes& out) {
    require_doc();
    auto pages = page_list(a, "pages", page_count());
    mu::Doc dst(ctx, mu::call(ctx, pdf_create_document));
    {
        mu::GraftMap map(ctx, mu::call(ctx, pdf_new_graft_map, dst.get()));
        for (size_t i = 0; i < pages.size(); ++i) mu::call(ctx, pdf_graft_mapped_page, map.get(), (int)i, doc, pages[i]);
    }
    pdf_write_options wo = pdf_default_write_options;
    wo.do_garbage = 3;
    wo.do_compress = 1;
    wo.do_compress_images = 1;
    wo.do_compress_fonts = 1;
    wo.do_use_objstms = 1;
    mu::Buffer buf(ctx, mu::call(ctx, fz_new_buffer, (size_t)64 * 1024));
    mu::Output o(ctx, mu::call(ctx, fz_new_output_with_buffer, buf.get()));
    mu::call(ctx, pdf_write_document, dst.get(), o.get(), (const pdf_write_options*)&wo);
    mu::call(ctx, fz_close_output, o.get());
    out = mu::buffer_bytes(ctx, buf.get());
    return {{"size", out.size()}};
}

}  // namespace pdfedit
