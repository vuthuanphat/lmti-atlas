#pragma once
#include "lmti/project_physical_hierarchy.hpp"
#include <cstdint>
#include <string>

namespace lmti {
enum class DesiredAssetCode {
    InvalidInput, ScopeDenied, ConfigChanged, RevisionConflict, ConfigConflict,
    OperationConflict, UnsupportedSchema, BudgetExceeded, OwnerUnavailable, RecoveryRequired
};
class DesiredAssetError : public Error {
  public:
    DesiredAssetCode code;
    explicit DesiredAssetError(DesiredAssetCode);
};
struct DesiredAssetScope {
    std::string project_id, store_uuid, principal_id, grant_fingerprint;
    std::string site_id, environment_id;
    bool allow_internal = false, allow_desired_write = false;
    bool operator==(const DesiredAssetScope &) const = default;
};
struct DesiredAssetValues {
    bool enabled = false;
    int poll_ms = 1000;
    bool operator==(const DesiredAssetValues &) const = default;
};
struct DesiredAssetProposal {
    std::string asset_id;
    std::int64_t expected_revision = 0;
    DesiredAssetValues expected, desired;
    std::string handoff_digest;
    bool operator==(const DesiredAssetProposal &) const = default;
};
struct DesiredAssetDiff {
    std::string asset_id;
    DesiredAssetValues expected, desired;
    bool operator==(const DesiredAssetDiff &) const = default;
};
struct DesiredAssetSelection {
    PhysicalAssetRow asset;
    DesiredAssetValues values;
    std::int64_t revision = 0;
};
struct DesiredAssetTransition {
    ProjectDocument document; // Unchanged revision/lineage; owner advances once.
    DesiredAssetSelection before;
    DesiredAssetDiff diff;
};

// Add only this read helper to the existing physical core/header. It does not
// require or fabricate the unrelated physical-hierarchy write permission.
PhysicalAssetRow project_physical_asset(const ProjectDocument &,
    const std::string &project_id, const std::string &asset_id, bool allow_internal);

void validate_desired_asset_scope(const DesiredAssetScope &, bool require_write = false);
DesiredAssetProposal normalize_desired_asset_proposal(
    const DesiredAssetScope &, const DesiredAssetProposal &);
DesiredAssetSelection select_desired_asset(const ProjectDocument &,
    const DesiredAssetScope &, const std::string &asset_id);
DesiredAssetTransition apply_desired_asset(const ProjectDocument &,
    const DesiredAssetScope &, const DesiredAssetProposal &);
// Pure input validation precedes graph access; complete target authorization
// precedes RevisionConflict/ConfigConflict. No-op=>InvalidInput, exhausted next
// revision=>BudgetExceeded. select reads the maximum valid saved revision.
// Malformed graph=>OwnerUnavailable; absent structure=>UnsupportedSchema.
} // namespace lmti

