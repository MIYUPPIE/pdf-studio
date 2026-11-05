// pdfedit engine: one Engine instance owns one open document.
// The method table and JSON shapes are defined in contracts/engine-api.md.
#pragma once

#include <functional>
#include <memory>
#include <optional>
#include <string>

#include "nlohmann/json.hpp"
#include "pdfedit/error.hpp"

namespace pdfedit {

using json = nlohmann::json;
using Bytes = std::string;  // binary-safe byte container

constexpr int ENGINE_API_VERSION = 1;

// Supplies fallback font files by name (e.g. "NotoSerif-Regular.otf") when text
// needs a script the built-in fonts cannot draw. Process-wide; set it before
// creating Engines. Return nullopt if unavailable. Without a provider MuPDF's
// compiled-in fonts are used (native builds include them, the wasm build does not).
using FontProvider = std::function<std::optional<std::string>(const std::string& file)>;
void set_font_provider(FontProvider provider);

struct Result {
    json value = json::object();
    std::optional<Bytes> bytes;
};

class Engine {
public:
    Engine();
    ~Engine();
    Engine(const Engine&) = delete;
    Engine& operator=(const Engine&) = delete;

    // Typed entry point. Throws pdfedit::Error.
    Result invoke(const std::string& method, const json& args, const Bytes* bytes_in = nullptr);

    // Transport entry point (used by the wasm binding). Never throws.
    // Returns {"ok":true,"result":...} or {"ok":false,"error":{"code","message"}}.
    // Binary output of the call is available from last_bytes() until the next call.
    std::string call(const std::string& method, const std::string& args_json, const Bytes* bytes_in);
    const std::optional<Bytes>& last_bytes() const { return last_bytes_; }

    struct Impl;

private:
    std::unique_ptr<Impl> impl_;
    std::optional<Bytes> last_bytes_;
};

}  // namespace pdfedit
