// pdfedit-cli: run engine calls from a JSON script. Used by evals and for debugging.
//
//   pdfedit-cli <script.json>        or   pdfedit-cli -   (script on stdin)
//
// Script: { "steps": [ { "method": "open", "args": {...}, "in": "file.pdf", "out": "result.pdf" }, ... ] }
// "in"  : path whose bytes are passed as the call's binary input.
// "out" : path where the call's binary output is written.
// Prints one JSON line per step: the transport response ({"ok":..,"result"|"error"}).
// Exit code 0 if every step succeeded, 1 otherwise.
#include <fstream>
#include <iostream>
#include <iterator>
#include <sstream>

#include "pdfedit/engine.hpp"

static std::string slurp(std::istream& in) { return std::string(std::istreambuf_iterator<char>(in), {}); }

int main(int argc, char** argv) {
    if (argc != 2) {
        std::cerr << "usage: pdfedit-cli <script.json | ->\n";
        return 2;
    }
    std::string text;
    if (std::string(argv[1]) == "-") {
        text = slurp(std::cin);
    } else {
        std::ifstream f(argv[1], std::ios::binary);
        if (!f) {
            std::cerr << "cannot read " << argv[1] << "\n";
            return 2;
        }
        text = slurp(f);
    }
    pdfedit::json script = pdfedit::json::parse(text);
    pdfedit::Engine engine;
    bool all_ok = true;
    for (auto& step : script.at("steps")) {
        std::string method = step.at("method");
        std::string args = step.value("args", pdfedit::json::object()).dump();
        std::string in_bytes;
        bool has_in = step.contains("in");
        if (has_in) {
            std::ifstream f(step["in"].get<std::string>(), std::ios::binary);
            if (!f) {
                std::cout << R"({"ok":false,"error":{"code":"bad_args","message":"cannot read input file"}})" << "\n";
                all_ok = false;
                continue;
            }
            in_bytes = slurp(f);
        }
        std::string res = engine.call(method, args, has_in ? &in_bytes : nullptr);
        std::cout << res << "\n";
        auto parsed = pdfedit::json::parse(res);
        if (!parsed["ok"].get<bool>()) all_ok = false;
        if (step.contains("out") && engine.last_bytes()) {
            std::ofstream o(step["out"].get<std::string>(), std::ios::binary);
            o << *engine.last_bytes();
        }
    }
    return all_ok ? 0 : 1;
}
