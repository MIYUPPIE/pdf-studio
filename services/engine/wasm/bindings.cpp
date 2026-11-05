// Embind surface for the browser. See contracts/engine-api.md "Transport".
//
//   const doc = new Module.Document();
//   const res = JSON.parse(doc.call("open", JSON.stringify({name}), uint8array));
//   const bytes = doc.takeBytes();   // Uint8Array | null
//   doc.delete();
//
// Fonts: set Module.pdfeditFetchFont = (fileName) => Uint8Array | null before
// opening documents. It must be synchronous (sync XHR in a Web Worker, or
// fs.readFileSync in Node). It is called at most once per font file.
#include <emscripten.h>
#include <emscripten/bind.h>
#include <emscripten/val.h>

#include <cstdlib>

#include "pdfedit/engine.hpp"

using emscripten::val;

// Returns the byte length (0 = unavailable) and stores a malloc'd pointer in *out.
EM_JS(int, pdfedit_js_fetch_font, (const char* file, unsigned char** out), {
    const fetchFont = Module["pdfeditFetchFont"];
    if (typeof fetchFont !== "function") return 0;
    let bytes = null;
    try { bytes = fetchFont(UTF8ToString(file)); } catch (e) { bytes = null; }
    if (!bytes || !bytes.length) return 0;
    const ptr = _malloc(bytes.length);
    HEAPU8.set(bytes, ptr);
    HEAPU32[out >> 2] = ptr;
    return bytes.length;
});

namespace {

std::optional<std::string> fetch_font(const std::string& file) {
    unsigned char* ptr = nullptr;
    int n = pdfedit_js_fetch_font(file.c_str(), &ptr);
    if (n <= 0 || !ptr) return std::nullopt;
    std::string bytes(reinterpret_cast<const char*>(ptr), (size_t)n);
    std::free(ptr);
    return bytes;
}

struct InstallFonts {
    InstallFonts() { pdfedit::set_font_provider(fetch_font); }
} install_fonts;

class Document {
public:
    std::string call(const std::string& method, const std::string& args, val bytes) {
        if (bytes.isNull() || bytes.isUndefined()) return engine_.call(method, args, nullptr);
        // Copy the JS Uint8Array into the wasm heap.
        pdfedit::Bytes in;
        const size_t n = bytes["length"].as<size_t>();
        in.resize(n);
        val view(emscripten::typed_memory_view(n, reinterpret_cast<unsigned char*>(in.data())));
        view.call<void>("set", bytes);
        return engine_.call(method, args, &in);
    }

    // Returns a JS-owned copy (Uint8Array) of the last call's binary output, or null.
    val takeBytes() {
        const auto& b = engine_.last_bytes();
        if (!b) return val::null();
        val view(emscripten::typed_memory_view(b->size(), reinterpret_cast<const unsigned char*>(b->data())));
        val copy = val::global("Uint8Array").new_(b->size());
        copy.call<void>("set", view);
        return copy;
    }

private:
    pdfedit::Engine engine_;
};

}  // namespace

EMSCRIPTEN_BINDINGS(pdfedit) {
    emscripten::class_<Document>("Document")
        .constructor<>()
        .function("call", &Document::call)
        .function("takeBytes", &Document::takeBytes);
}
