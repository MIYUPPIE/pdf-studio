// Bridge between MuPDF's setjmp/longjmp error model and C++ exceptions.
//
// MuPDF reports errors with fz_try/fz_catch (setjmp/longjmp). A longjmp that
// crosses a C++ frame holding objects with destructors is undefined behaviour,
// so every MuPDF call goes through mu::call(), which wraps exactly ONE C call in
// its own fz_try and converts a MuPDF error into pdfedit::Error *after* the
// fz_catch, where unwinding with C++ exceptions is safe.
#pragma once

extern "C" {
#include "mupdf/fitz.h"
#include "mupdf/pdf.h"
}

#include <string>
#include <type_traits>
#include <utility>

#include "pdfedit/error.hpp"

namespace pdfedit::mu {

[[noreturn]] void rethrow(fz_context* ctx);

template <typename Fn, typename... Args>
auto call(fz_context* ctx, Fn fn, Args... args) -> decltype(fn(ctx, args...)) {
    using R = decltype(fn(ctx, args...));
    if constexpr (std::is_void_v<R>) {
        fz_try(ctx) { fn(ctx, args...); }
        fz_catch(ctx) { rethrow(ctx); }
    } else {
        R result{};
        fz_try(ctx) { result = fn(ctx, args...); }
        fz_catch(ctx) { rethrow(ctx); }
        return result;
    }
}

// Owning handle for a MuPDF object. Drop functions never throw.
template <typename T, void (*Drop)(fz_context*, T*)>
class Ref {
public:
    Ref() = default;
    Ref(fz_context* ctx, T* p) : ctx_(ctx), p_(p) {}
    Ref(const Ref&) = delete;
    Ref& operator=(const Ref&) = delete;
    Ref(Ref&& o) noexcept : ctx_(o.ctx_), p_(std::exchange(o.p_, nullptr)) {}
    Ref& operator=(Ref&& o) noexcept {
        if (this != &o) {
            reset();
            ctx_ = o.ctx_;
            p_ = std::exchange(o.p_, nullptr);
        }
        return *this;
    }
    ~Ref() { reset(); }
    void reset() {
        if (p_) Drop(ctx_, p_);
        p_ = nullptr;
    }
    T* get() const { return p_; }
    T* operator->() const { return p_; }
    explicit operator bool() const { return p_ != nullptr; }
    T* release() { return std::exchange(p_, nullptr); }

private:
    fz_context* ctx_ = nullptr;
    T* p_ = nullptr;
};

using Buffer = Ref<fz_buffer, fz_drop_buffer>;
using Pixmap = Ref<fz_pixmap, fz_drop_pixmap>;
using Image = Ref<fz_image, fz_drop_image>;
using Font = Ref<fz_font, fz_drop_font>;
using Device = Ref<fz_device, fz_drop_device>;
inline void drop_text(fz_context* c, fz_text* t) { fz_drop_text(c, t); }
using Text = Ref<fz_text, drop_text>;
using STextPage = Ref<fz_stext_page, fz_drop_stext_page>;
using Obj = Ref<pdf_obj, pdf_drop_obj>;
using Annot = Ref<pdf_annot, pdf_drop_annot>;
using Doc = Ref<pdf_document, pdf_drop_document>;
using FzDoc = Ref<fz_document, fz_drop_document>;
using Stream = Ref<fz_stream, fz_drop_stream>;
using Output = Ref<fz_output, fz_drop_output>;
using GraftMap = Ref<pdf_graft_map, pdf_drop_graft_map>;
inline void drop_path(fz_context* c, fz_path* p) { fz_drop_path(c, p); }
using Path = Ref<fz_path, drop_path>;

inline void drop_pdf_page(fz_context* ctx, pdf_page* p) { fz_drop_page(ctx, &p->super); }
using Page = Ref<pdf_page, drop_pdf_page>;
using FzPage = Ref<fz_page, fz_drop_page>;

// Copy a buffer's bytes out.
std::string buffer_bytes(fz_context* ctx, fz_buffer* buf);

// Build an fz_buffer owning a copy of data.
Buffer buffer_from(fz_context* ctx, const unsigned char* data, size_t len);

}  // namespace pdfedit::mu
