#include "windows_access.hpp"
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <aclapi.h>
#include <sddl.h>
#include <algorithm>
#include <memory>
#include <source_location>
#include <stdexcept>
#include <string_view>

namespace lmti::audit {
namespace {
[[noreturn]] void fail(const std::source_location location = std::source_location::current()) {
    // Numeric source locations aid synthetic test diagnostics without exposing
    // paths, account identifiers, descriptors or OS error text. The IPC helper
    // still catches all exceptions and emits no diagnostic payload.
    throw std::runtime_error("AUDIT_ACCESS_PRESERVATION_FAILED_AT_" + std::to_string(location.line()));
}
struct Handle {
    HANDLE value{INVALID_HANDLE_VALUE};
    ~Handle() { if (value != INVALID_HANDLE_VALUE) CloseHandle(value); }
    Handle(const Handle&) = delete;
    Handle& operator=(const Handle&) = delete;
    explicit Handle(HANDLE handle) : value(handle) { if (value == INVALID_HANDLE_VALUE) fail(); }
};
struct LocalDelete { void operator()(void* value) const { if (value) LocalFree(value); } };
using Local = std::unique_ptr<void, LocalDelete>;

std::wstring normalized(const std::wstring& input) {
    if (input.size() < 4 || input.size() > 32760 || input.find(L'\0') != std::wstring::npos ||
        !((input[0] >= L'A' && input[0] <= L'Z') || (input[0] >= L'a' && input[0] <= L'z')) ||
        input[1] != L':' || (input[2] != L'\\' && input[2] != L'/')) fail();
    std::wstring result(input);
    std::replace(result.begin(), result.end(), L'/', L'\\');
    std::size_t start = 3;
    while (start < result.size()) {
        const auto end = result.find(L'\\', start);
        const auto part = result.substr(start, end == std::wstring::npos ? end : end - start);
        if (part.empty() || part == L"." || part == L".." || part.back() == L'.' || part.back() == L' ' ||
            part.find_first_of(L":\r\n\t") != std::wstring::npos) fail();
        if (end == std::wstring::npos) break;
        start = end + 1;
    }
    if (result.back() == L'\\') fail();
    return result;
}
std::wstring parent(const std::wstring& value) { return value.substr(0, value.find_last_of(L'\\')); }
std::wstring leaf(const std::wstring& value) { return value.substr(value.find_last_of(L'\\') + 1); }
bool same_path(const std::wstring& left, const std::wstring& right) {
    return CompareStringOrdinal(left.c_str(), static_cast<int>(left.size()), right.c_str(), static_cast<int>(right.size()), TRUE) == CSTR_EQUAL;
}
bool temporary_name(const std::wstring& name) {
    constexpr std::wstring_view prefix = L".audit-tmp-";
    if (!name.starts_with(prefix) || name.size() != prefix.size() + 36) return false;
    for (std::size_t i = 0; i < 36; ++i) {
        const auto c = name[prefix.size() + i];
        if (i == 8 || i == 13 || i == 18 || i == 23) { if (c != L'-') return false; }
        else if (!((c >= L'0' && c <= L'9') || (c >= L'a' && c <= L'f'))) return false;
    }
    return true;
}
BY_HANDLE_FILE_INFORMATION file_info(HANDLE handle, bool empty) {
    BY_HANDLE_FILE_INFORMATION info{};
    if (!GetFileInformationByHandle(handle, &info) ||
        (info.dwFileAttributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT)) || info.nNumberOfLinks != 1 ||
        (empty && (info.nFileSizeHigh != 0 || info.nFileSizeLow != 0))) fail();
    return info;
}
bool same_file(const BY_HANDLE_FILE_INFORMATION& left, const BY_HANDLE_FILE_INFORMATION& right) {
    return left.dwVolumeSerialNumber == right.dwVolumeSerialNumber && left.nFileIndexHigh == right.nFileIndexHigh && left.nFileIndexLow == right.nFileIndexLow;
}
void canonical_handle(HANDLE file, const std::wstring& requested) {
    std::wstring actual(32768, L'\0');
    const DWORD length = GetFinalPathNameByHandleW(file, actual.data(), static_cast<DWORD>(actual.size()), FILE_NAME_NORMALIZED | VOLUME_NAME_DOS);
    if (length == 0 || length >= actual.size()) fail();
    actual.resize(length);
    if (!same_path(actual, L"\\\\?\\" + requested)) fail();
}
struct Access {
    Local descriptor;
    PACL dacl{};
    SECURITY_DESCRIPTOR_CONTROL control{};
    std::wstring sddl;
};
Access access(HANDLE file) {
    PSECURITY_DESCRIPTOR raw{}; PACL dacl{};
    if (GetSecurityInfo(file, SE_FILE_OBJECT, DACL_SECURITY_INFORMATION, nullptr, nullptr, &dacl, nullptr, &raw) != ERROR_SUCCESS) fail();
    Local descriptor(raw);
    SECURITY_DESCRIPTOR_CONTROL control{}; DWORD revision{};
    if (!IsValidSecurityDescriptor(raw) || !GetSecurityDescriptorControl(raw, &control, &revision)) fail();
    LPWSTR text{};
    if (!ConvertSecurityDescriptorToStringSecurityDescriptorW(raw, SDDL_REVISION_1, DACL_SECURITY_INFORMATION, &text, nullptr)) fail();
    Local owned_text(text);
    return { std::move(descriptor), dacl, control, std::wstring(text) };
}
}

void copy_windows_access(const std::wstring& source_input, const std::wstring& target_input) {
    const auto source = normalized(source_input), target = normalized(target_input);
    const auto source_parent = parent(source), target_parent = parent(target);
    if (leaf(source) != L"audit.jsonl" || leaf(source_parent) != L"privacy" || leaf(parent(source_parent)) != L".lmti" ||
        !temporary_name(leaf(target)) ||
        (!same_path(source_parent, target_parent) && !same_path(source_parent + L"\\archive", target_parent))) fail();
    constexpr DWORD sharing = FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE;
    // FILE_WRITE_DATA is intentional: parent delete/rename permission must never
    // bypass an existing source DACL denying mutation. No privileges are enabled.
    Handle source_file(CreateFileW((L"\\\\?\\" + source).c_str(), READ_CONTROL | FILE_READ_ATTRIBUTES | FILE_WRITE_DATA,
        sharing, nullptr, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
    Handle target_file(CreateFileW((L"\\\\?\\" + target).c_str(), READ_CONTROL | WRITE_DAC | FILE_READ_ATTRIBUTES,
        sharing, nullptr, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
    const auto source_identity = file_info(source_file.value, false), target_identity = file_info(target_file.value, true);
    if (same_file(source_identity, target_identity)) fail();
    canonical_handle(source_file.value, source); canonical_handle(target_file.value, target);
    const auto before = access(source_file.value);
    const auto protection = (before.control & SE_DACL_PROTECTED) ? PROTECTED_DACL_SECURITY_INFORMATION : UNPROTECTED_DACL_SECURITY_INFORMATION;
    if (SetSecurityInfo(target_file.value, SE_FILE_OBJECT, DACL_SECURITY_INFORMATION | protection,
        nullptr, nullptr, before.dacl, nullptr) != ERROR_SUCCESS) fail();
    // Compare the complete Access SDDL (ACE order/masks/inheritance/protection),
    // not a lossy allow-list. Fail closed on any OS normalization difference.
    if (access(target_file.value).sddl != before.sddl || access(source_file.value).sddl != before.sddl ||
        !same_file(source_identity, file_info(source_file.value, false)) ||
        !same_file(target_identity, file_info(target_file.value, true))) fail();
    canonical_handle(source_file.value, source); canonical_handle(target_file.value, target);
}
}
