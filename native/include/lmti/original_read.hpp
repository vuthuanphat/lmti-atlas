#pragma once
#include "project_library.hpp"
#include <QString>
#include <vector>

namespace lmti {
enum class OriginalReadCode {
    InvalidInput, ScopeDenied, ConfigChanged, OwnerUnavailable,
    NotSupported, LimitExceeded, RecoveryRequired
};
class OriginalReadError : public Error {
  public:
    OriginalReadCode code;
    explicit OriginalReadError(OriginalReadCode value)
        : Error("Original binding read was refused."), code(value) {}
};
struct OriginalPhysicalIdentity {
    QString dev, ino, birthtime_ns; // Exact unsigned decimal text; never doubles.
    bool operator==(const OriginalPhysicalIdentity &) const = default;
};
enum class OriginalPhysicalState { Present, Missing };
struct OriginalPhysicalTarget {
    QString path;
    OriginalPhysicalState state = OriginalPhysicalState::Present;
    // Volume-first path components. Missing permits only the final file leaf.
    std::vector<OriginalPhysicalIdentity> chain;
};
struct OriginalLibraryExpected {
    int schema = 0;
    QString canonical_path, uuid; // V1 UUID is empty, not a fabricated identity.
    OriginalPhysicalTarget physical;
};
struct OriginalProjectExpected {
    int schema = 0;
    QString store_uuid; // V1 is empty.
    OriginalPhysicalTarget physical;
};
} // namespace lmti
