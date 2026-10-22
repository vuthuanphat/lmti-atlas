#include "windows_access.hpp"
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <array>
#include <cstdint>
#include <cstring>
#include <stdexcept>
#include <string>
#include <vector>

namespace {
constexpr std::size_t limit = 65536;
std::uint32_t length(const unsigned char* value) {
    return static_cast<std::uint32_t>(value[0]) | (static_cast<std::uint32_t>(value[1]) << 8) |
        (static_cast<std::uint32_t>(value[2]) << 16) | (static_cast<std::uint32_t>(value[3]) << 24);
}
std::wstring utf16(const unsigned char* bytes, std::size_t size) {
    if (size == 0 || size > limit || std::memchr(bytes, 0, size)) throw std::runtime_error("invalid");
    const auto input = reinterpret_cast<const char*>(bytes);
    const int required = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, input, static_cast<int>(size), nullptr, 0);
    if (required < 1 || required > 32760) throw std::runtime_error("invalid");
    std::wstring result(static_cast<std::size_t>(required), L'\0');
    if (MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, input, static_cast<int>(size), result.data(), required) != required)
        throw std::runtime_error("invalid");
    return result;
}
}
int wmain(int argc, wchar_t** argv) {
    try {
        SetDefaultDllDirectories(LOAD_LIBRARY_SEARCH_SYSTEM32);
        if (argc != 2 || std::wstring(argv[1]) != L"--copy-access-v1") return 1;
        std::vector<unsigned char> frame;
        std::array<unsigned char, 4096> part{};
        for (;;) {
            DWORD received{};
            if (!ReadFile(GetStdHandle(STD_INPUT_HANDLE), part.data(), static_cast<DWORD>(part.size()), &received, nullptr)) {
                if (GetLastError() == ERROR_BROKEN_PIPE) break;
                return 1;
            }
            if (!received) break;
            if (frame.size() + received > 16 + limit * 2) return 1;
            frame.insert(frame.end(), part.begin(), part.begin() + received);
        }
        if (frame.size() < 16 || std::memcmp(frame.data(), "LMTIACL1", 8) != 0) return 1;
        const auto source_size = length(frame.data() + 8), target_size = length(frame.data() + 12);
        if (source_size > limit || target_size > limit || frame.size() != 16ULL + source_size + target_size) return 1;
        lmti::audit::copy_windows_access(utf16(frame.data() + 16, source_size), utf16(frame.data() + 16 + source_size, target_size));
        DWORD written{};
        return WriteFile(GetStdHandle(STD_OUTPUT_HANDLE), "ok", 2, &written, nullptr) && written == 2 ? 0 : 1;
    } catch (...) { return 1; } // Never emit paths, account SIDs, ACLs or OS error text.
}
