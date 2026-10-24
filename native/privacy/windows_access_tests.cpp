#include "windows_access.hpp"
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <aclapi.h>
#include <sddl.h>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <stdexcept>

namespace fs = std::filesystem;
namespace {
void require(bool condition) { if (!condition) throw std::runtime_error("check failed"); }
std::wstring dacl(const fs::path& path) {
    PSECURITY_DESCRIPTOR raw{};
    require(GetNamedSecurityInfoW(path.c_str(), SE_FILE_OBJECT, DACL_SECURITY_INFORMATION, nullptr, nullptr, nullptr, nullptr, &raw) == ERROR_SUCCESS);
    LPWSTR text{};
    const auto ok = ConvertSecurityDescriptorToStringSecurityDescriptorW(raw, SDDL_REVISION_1, DACL_SECURITY_INFORMATION, &text, nullptr);
    LocalFree(raw); require(ok != FALSE);
    const std::wstring result(text); LocalFree(text); return result;
}
void protect(const fs::path& path) {
    PSECURITY_DESCRIPTOR raw{}; PACL acl{};
    require(GetNamedSecurityInfoW(path.c_str(), SE_FILE_OBJECT, DACL_SECURITY_INFORMATION, nullptr, nullptr, &acl, nullptr, &raw) == ERROR_SUCCESS);
    const auto status = SetNamedSecurityInfoW(const_cast<wchar_t*>(path.c_str()), SE_FILE_OBJECT,
        DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION, nullptr, nullptr, acl, nullptr);
    LocalFree(raw); require(status == ERROR_SUCCESS);
}
template<class Function> void rejects(Function operation) {
    bool rejected = false;
    try { operation(); } catch (...) { rejected = true; }
    require(rejected);
}
}
int main() {
    fs::path root;
    int stage = 0;
    try {
        wchar_t temporary[MAX_PATH + 1]{}, unique[MAX_PATH + 1]{};
        require(GetTempPathW(MAX_PATH, temporary) != 0 && GetTempFileNameW(temporary, L"lma", 0, unique) != 0);
        root = fs::absolute(unique);
        require(root.parent_path() == fs::absolute(temporary).lexically_normal().parent_path() || root.parent_path() == fs::absolute(temporary).lexically_normal());
        require(DeleteFileW(root.c_str()) != FALSE);
        fs::create_directory(root);
        stage = 1;
        const auto privacy = root / L"Unicode-đồ án [literal] $;" / L".lmti" / L"privacy";
        fs::create_directories(privacy / L"archive");
        const auto source = privacy / L"audit.jsonl";
        const auto target = privacy / L".audit-tmp-00000000-0000-0000-0000-000000000001";
        const auto archive = privacy / L"archive" / L".audit-tmp-00000000-0000-0000-0000-000000000002";
        { std::ofstream file(source, std::ios::binary); file << "synthetic"; }
        { std::ofstream file(target, std::ios::binary); }
        { std::ofstream file(archive, std::ios::binary); }
        const auto inherited = dacl(source);
        stage = 2;
        lmti::audit::copy_windows_access(source, target);
        require(dacl(target) == inherited && fs::file_size(target) == 0 && fs::file_size(source) == 9);
        stage = 3;
        lmti::audit::copy_windows_access(source, archive);
        require(dacl(archive) == inherited);
        stage = 4;
        protect(source);
        const auto protected_acl = dacl(source);
        lmti::audit::copy_windows_access(source, target);
        require(dacl(target) == protected_acl);
        stage = 5;
        { std::ofstream file(target, std::ios::binary); file << "must not change"; }
        rejects([&] { lmti::audit::copy_windows_access(source, target); });
        require(fs::file_size(target) == 15);
        stage = 6;
        const auto unrelated = privacy / L"unrelated";
        { std::ofstream file(unrelated, std::ios::binary); }
        rejects([&] { lmti::audit::copy_windows_access(source, unrelated); });
        rejects([&] { lmti::audit::copy_windows_access(unrelated, archive); });
        rejects([&] { lmti::audit::copy_windows_access(source, fs::path(privacy.wstring() + L"\\..\\privacy\\") / archive.filename()); });
        const auto linked = privacy / L".audit-tmp-00000000-0000-0000-0000-000000000003";
        stage = 7;
        fs::create_hard_link(archive, linked);
        rejects([&] { lmti::audit::copy_windows_access(source, linked); });
        fs::remove(linked);
        fs::create_hard_link(source, privacy / L"source-copy");
        stage = 8;
        rejects([&] { lmti::audit::copy_windows_access(source, archive); });
        // Only this freshly generated fixture tree is removed; never caller paths.
        require(root.filename().wstring().starts_with(L"lma") && root.parent_path() == fs::path(unique).parent_path());
        fs::remove_all(root);
        std::cout << "audit ACL native: 9 checks passed\n";
        return 0;
    } catch (const std::exception& error) {
        // Preserve the synthetic fixture on failure; output no path or ACL data.
        std::cerr << "audit ACL native check failed at stage " << stage << "\n";
        const std::string message(error.what());
        constexpr std::string_view prefix = "AUDIT_ACCESS_PRESERVATION_FAILED_AT_";
        if (message.starts_with(prefix) && message.find_first_not_of("0123456789", prefix.size()) == std::string::npos)
            std::cerr << message << "\n";
        return 1;
    }
}
