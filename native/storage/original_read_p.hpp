#pragma once
#include "lmti/original_read.hpp"
#include "lmti/project_store.hpp"
#include <QDir>
#include <QStringList>
#include <QUuid>
#include <algorithm>
#include <array>
#include <limits>
#include <optional>
#ifdef Q_OS_WIN
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#endif

namespace lmti::detail {
class OriginalProjectChanged : public Error {
  public:
    OriginalProjectChanged() : Error("Original project identity changed.") {}
};
// Caller must hold original namespace leases. One read connection checks the
// identity before graph rows. No profile-storage dependency is added here.
ProjectDocument read_original_project(const QString &path, int expected_schema,
    const std::string &expected_project_id, const std::string &expected_store_uuid);

#ifdef LMTI_ORIGINAL_READ_TEST_HOOKS
enum class OriginalReadPhase {
    AfterLeasesAcquired, AfterInitialLocatorCompared, BeforeProjectOpen,
    BeforeProjectContent, BeforeProfileOpen, BeforeFinalVerification
};
using OriginalReadTestHook = void (*)(OriginalReadPhase, const QString &);
void set_original_read_test_hook(OriginalReadTestHook);
void original_read_test_point(OriginalReadPhase, const QString &);
#endif


HierarchyState read_original_hierarchy(const QString &, const LogicalHierarchyScope &,
    const std::string &expected_store_uuid);
// Physical state uses the same immutable identity gate on the capture
// connection; OriginalProjectChanged must survive its domain error mapping.
PhysicalHierarchyState read_original_physical_hierarchy(const QString &,
    const PhysicalHierarchyScope &,const std::string &expected_store_uuid);
} // namespace lmti::detail

namespace lmti::detail::original_read {
[[noreturn]] inline void refused(OriginalReadCode code) { throw OriginalReadError(code); }
inline void need(bool condition,OriginalReadCode code = OriginalReadCode::InvalidInput) {
    if (!condition) refused(code);
}
inline bool scalar(const QString &value) {
    return QString::fromUtf8(value.toUtf8()) == value;
}
inline QString path_text(const QString &value,bool optional = false) {
    if (optional && value.isEmpty()) return {};
    need(!value.isEmpty() && value.size() <= 1024 && scalar(value));
    for (const auto c : value)
        need(c.unicode() >= 32 && c.unicode() != 127 &&
             c != '<' && c != '>' && c != '"' && c != '|' && c != '?' && c != '*');
    auto normalized = value;
    normalized.replace('\\','/');
    need(normalized.size() >= 3 &&
         ((normalized[0] >= 'A' && normalized[0] <= 'Z') ||
          (normalized[0] >= 'a' && normalized[0] <= 'z')) &&
         normalized[1] == ':' && normalized[2] == '/');
    const auto tail = normalized.mid(3);
    need(!tail.contains(':'));
    if (!tail.isEmpty()) {
        for (const auto &part : tail.split('/')) {
            need(!part.isEmpty() && part != "." && part != ".." &&
                 !part.endsWith('.') && !part.endsWith(' '));
            const auto device = part.section('.',0,0).toLower();
            need(device != "con" && device != "prn" && device != "aux" && device != "nul" &&
                 !(device.size() == 4 && (device.startsWith("com") || device.startsWith("lpt")) &&
                   device[3] >= '1' && device[3] <= '9'));
        }
    }
    return normalized;
}
inline QStringList parts(const QString &path) {
    const auto normalized = path_text(path);
    QStringList result{normalized.left(3)};
    const auto tail = normalized.mid(3);
    if (!tail.isEmpty()) for (const auto &part : tail.split('/'))
        result.push_back(result.back() + (result.size() == 1 ? "" : "/") + part);
    need(result.size() <= 64,OriginalReadCode::LimitExceeded);
    return result;
}
inline bool decimal(const QString &value,bool positive,std::size_t cap) {
    if (value.isEmpty() || static_cast<std::size_t>(value.size()) > cap ||
        (value.size() > 1 && value[0] == '0') || (positive && value == "0")) return false;
    return std::all_of(value.begin(),value.end(),[](QChar c) { return c >= '0' && c <= '9'; });
}
inline void identity_shape(const OriginalPhysicalIdentity &id) {
    need(decimal(id.dev,false,20) && decimal(id.ino,true,20) &&
         decimal(id.birthtime_ns,true,40));
    bool ok = false;
    const auto device = id.dev.toULongLong(&ok);
    need(ok && device <= std::numeric_limits<quint32>::max());
    (void)id.ino.toULongLong(&ok); need(ok);
    // FILETIME has exact 100ns units. Divide as decimal text before conversion,
    // avoiding multiplication into an overflowing nanosecond uint64 value.
    need(id.birthtime_ns.size() >= 3 && id.birthtime_ns.endsWith("00"));
    const auto units = id.birthtime_ns.left(id.birthtime_ns.size()-2).toULongLong(&ok);
    constexpr quint64 epoch = 116444736000000000ULL;
    need(ok && units > 0 && units <= std::numeric_limits<quint64>::max()-epoch);
}
inline bool uuid(const QString &text) {
    if (text.size() != 36 || !scalar(text)) return false;
    const QUuid value(text);
    return !value.isNull() && value.toString(QUuid::WithoutBraces) == text;
}
inline void physical_shape(const OriginalPhysicalTarget &target,bool allow_missing) {
    need(target.chain.size() <= 64,OriginalReadCode::LimitExceeded);
    const auto chain = parts(target.path);
    need(chain.size() > 1);
    need(target.state == OriginalPhysicalState::Present || target.state == OriginalPhysicalState::Missing);
    if (target.state == OriginalPhysicalState::Missing) {
        need(allow_missing,OriginalReadCode::RecoveryRequired);
        // Only the final leaf may be absent under fully pinned ancestors.
        need(target.chain.size() == static_cast<std::size_t>(chain.size()-1),
             OriginalReadCode::RecoveryRequired);
    } else need(target.chain.size() == static_cast<std::size_t>(chain.size()));
    for (const auto &id : target.chain) identity_shape(id);
}
#ifdef Q_OS_WIN
class HeldHandle {
    HANDLE value_ = INVALID_HANDLE_VALUE;
  public:
    explicit HeldHandle(HANDLE value) : value_(value) {}
    HeldHandle(const HeldHandle &) = delete;
    HeldHandle &operator=(const HeldHandle &) = delete;
    HeldHandle(HeldHandle &&other) noexcept : value_(other.value_) { other.value_ = INVALID_HANDLE_VALUE; }
    ~HeldHandle() { if (value_ != INVALID_HANDLE_VALUE) CloseHandle(value_); }
    HANDLE get() const { return value_; }
};
struct HeldFile {
    OriginalPhysicalIdentity identity;
    quint64 size = 0;
};
class NamespaceLease {
    std::vector<HeldHandle> handles_;
  public:
    NamespaceLease() { handles_.reserve(3*64+18); }
    HeldFile retain(const QString &path,bool directory,
                    const OriginalPhysicalIdentity *expected = nullptr) {
        // Main ancestors are acquired volume-first. Fixed sidecar leaves use
        // the same held parent; OPEN_REPARSE_POINT covers each leaf itself.
        const auto native = QDir::toNativeSeparators(path).toStdWString();
        HeldHandle handle(CreateFileW(native.c_str(),
            FILE_READ_DATA|FILE_READ_ATTRIBUTES,FILE_SHARE_READ|FILE_SHARE_WRITE,
            nullptr,OPEN_EXISTING,FILE_FLAG_OPEN_REPARSE_POINT |
            (directory ? FILE_FLAG_BACKUP_SEMANTICS : 0),nullptr));
        need(handle.get() != INVALID_HANDLE_VALUE,OriginalReadCode::OwnerUnavailable);
        BY_HANDLE_FILE_INFORMATION info{};
        need(GetFileType(handle.get()) == FILE_TYPE_DISK &&
             GetFileInformationByHandle(handle.get(),&info) &&
             !(info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) &&
             bool(info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) == directory &&
             (directory || info.nNumberOfLinks == 1),OriginalReadCode::OwnerUnavailable);
        const auto ticks = (quint64(info.ftCreationTime.dwHighDateTime)<<32) |
                           quint64(info.ftCreationTime.dwLowDateTime);
        constexpr quint64 epoch = 116444736000000000ULL;
        need(ticks > epoch,OriginalReadCode::NotSupported);
        const auto index = (quint64(info.nFileIndexHigh)<<32) | quint64(info.nFileIndexLow);
        need(index != 0,OriginalReadCode::NotSupported);
        HeldFile result{{QString::number(info.dwVolumeSerialNumber),QString::number(index),
                         QString::number(ticks-epoch)+QStringLiteral("00")},
                        (quint64(info.nFileSizeHigh)<<32)|quint64(info.nFileSizeLow)};
        if (expected) need(result.identity == *expected,OriginalReadCode::ConfigChanged);
        handles_.push_back(std::move(handle));
        return result;
    }
    void retain_target(const OriginalPhysicalTarget &target,quint64 cap) {
        const auto chain = parts(target.path);
        for (std::size_t i=0;i<target.chain.size();++i) {
            const bool directory = i+1 != static_cast<std::size_t>(chain.size());
            const auto file = retain(chain[static_cast<qsizetype>(i)],directory,&target.chain[i]);
            if (!directory) need(file.size <= cap,OriginalReadCode::LimitExceeded);
        }
    }
};
inline bool present_leaf(const QString &path) {
    const auto native = QDir::toNativeSeparators(path).toStdWString();
    SetLastError(ERROR_SUCCESS);
    const auto attributes = GetFileAttributesW(native.c_str());
    if (attributes == INVALID_FILE_ATTRIBUTES) {
        const auto error = GetLastError();
        // Parent is retained. PATH_NOT_FOUND is not a mere missing leaf.
        if (error == ERROR_FILE_NOT_FOUND) return false;
        refused(OriginalReadCode::OwnerUnavailable);
    }
    need(!(attributes & FILE_ATTRIBUTE_REPARSE_POINT) &&
         !(attributes & FILE_ATTRIBUTE_DIRECTORY),OriginalReadCode::OwnerUnavailable);
    return true;
}
struct SidecarState {
    QString path;
    std::array<std::optional<OriginalPhysicalIdentity>,3> identities;
};
inline constexpr std::array<const char *,3> suffixes{"-wal","-shm","-journal"};
inline SidecarState retain_sidecars(NamespaceLease &lease,const QString &path) {
    SidecarState result{path,{}};
    for (std::size_t i=0;i<suffixes.size();++i) {
        const auto candidate = path+QString::fromLatin1(suffixes[i]);
        if (!present_leaf(candidate)) continue;
        const auto held = lease.retain(candidate,false);
        need(held.size <= (i == 1 ? 1024ULL*1024 : 128ULL*1024*1024),
             OriginalReadCode::LimitExceeded);
        if (i == 2) need(held.size == 0,OriginalReadCode::OwnerUnavailable);
        result.identities[i] = held.identity;
    }
    need(result.identities[0].has_value() == result.identities[1].has_value(),
         OriginalReadCode::OwnerUnavailable);
    return result;
}
inline void check_sidecars(NamespaceLease &lease,const SidecarState &before) {
    for (std::size_t i=0;i<suffixes.size();++i)
        need(present_leaf(before.path+QString::fromLatin1(suffixes[i])) == before.identities[i].has_value(),
             OriginalReadCode::ConfigChanged);
    const auto after = retain_sidecars(lease,before.path);
    need(after.identities == before.identities,OriginalReadCode::ConfigChanged);
}
#endif
inline const LibraryEntry &selected(const LibraryInspection &value,const std::string &id) {
    const auto found = std::find_if(value.entries.begin(),value.entries.end(),
        [&](const auto &row) { return row.id == QString::fromStdString(id); });
    need(found != value.entries.end(),OriginalReadCode::ScopeDenied);
    return *found;
}
template<class Expected>
void matches_original_library(const LibraryInspection &view,const Expected &expected) {
    need(view.token.schema == expected.library.schema &&
         view.token.canonical_path == expected.library.canonical_path &&
         view.token.library_uuid == expected.library.uuid,OriginalReadCode::ConfigChanged);
    const auto &row = selected(view,expected.project_id);
    need(row.path == expected.project.physical.path && row.folder == expected.linked_root,
         OriginalReadCode::ConfigChanged);
}
} // namespace lmti::detail::original_read
