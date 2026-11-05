#pragma once

#include <stdexcept>
#include <string>

namespace pdfedit {

// Error codes are part of contracts/engine-api.md.
class Error : public std::runtime_error {
public:
    Error(std::string code, const std::string& message)
        : std::runtime_error(message), code_(std::move(code)) {}
    const std::string& code() const { return code_; }

private:
    std::string code_;
};

}  // namespace pdfedit
