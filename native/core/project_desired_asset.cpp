#include "lmti/project_desired_asset.hpp"
#include <algorithm>
#include <utility>

namespace lmti {
DesiredAssetError::DesiredAssetError(DesiredAssetCode value)
    : Error("Desired Asset operation was refused."), code(value) {}

namespace {
using Code = DesiredAssetCode;
constexpr std::int64_t max_saved_revision = 9007199254740990LL;
[[noreturn]] void refuse(Code code) { throw DesiredAssetError(code); }
void need(bool condition, Code code = Code::InvalidInput) {
    if (!condition) refuse(code);
}
bool hex(char value) {
    return (value >= '0' && value <= '9') || (value >= 'a' && value <= 'f');
}
bool digest(const std::string &value) {
    return value.size() == 64 && std::all_of(value.begin(), value.end(), hex);
}
bool uuid(const std::string &value) {
    if (value.size() != 36) return false;
    bool nonzero = false;
    for (std::size_t i = 0; i < value.size(); ++i) {
        if (i == 8 || i == 13 || i == 18 || i == 23) {
            if (value[i] != '-') return false;
        } else {
            if (!hex(value[i])) return false;
            nonzero = nonzero || value[i] != '0';
        }
    }
    return nonzero;
}
void asset_id(const std::string &value) {
    try { validate_id(value); }
    catch (const Error &) { refuse(Code::InvalidInput); }
}
void values(const DesiredAssetValues &value) {
    need(value.poll_ms >= 100 && value.poll_ms <= 3600000);
}
[[noreturn]] void physical_failure(PhysicalHierarchyCode code) {
    switch (code) {
    case PhysicalHierarchyCode::ScopeDenied: refuse(Code::ScopeDenied);
    case PhysicalHierarchyCode::Unsupported: refuse(Code::UnsupportedSchema);
    case PhysicalHierarchyCode::BudgetExceeded: refuse(Code::BudgetExceeded);
    // Caller IDs were already validated. Any remaining shape error belongs
    // to the current graph, not to the caller's desired-value envelope.
    case PhysicalHierarchyCode::InvalidArgument:
    case PhysicalHierarchyCode::Conflict:
    case PhysicalHierarchyCode::OwnerUnavailable: refuse(Code::OwnerUnavailable);
    }
    refuse(Code::OwnerUnavailable);
}
} // namespace

void validate_desired_asset_scope(const DesiredAssetScope &scope, bool require_write) {
    try {
        validate_id(scope.project_id);
        validate_id(scope.site_id);
        validate_id(scope.environment_id);
        need(uuid(scope.store_uuid) && digest(scope.grant_fingerprint));
        need(!scope.principal_id.empty() && scope.principal_id.size() <= 160 &&
             valid_metadata_utf8(scope.principal_id) && !secret_like(scope.principal_id));
        if (require_write) need(scope.allow_desired_write, Code::ScopeDenied);
    } catch (const DesiredAssetError &) { throw; }
    catch (const Error &) { refuse(Code::InvalidInput); }
    catch (const std::exception &) { refuse(Code::OwnerUnavailable); }
}

DesiredAssetProposal normalize_desired_asset_proposal(
    const DesiredAssetScope &scope, const DesiredAssetProposal &proposal) {
    validate_desired_asset_scope(scope, true);
    asset_id(proposal.asset_id);
    need(proposal.expected_revision >= 1 && proposal.expected_revision <= max_saved_revision);
    values(proposal.expected);
    values(proposal.desired);
    need(digest(proposal.handoff_digest));
    need(proposal.expected != proposal.desired); // Caller-only no-op, before any graph access.
    return proposal; // Scalars remain exact; no case folding or lossy conversion.
}

DesiredAssetSelection select_desired_asset(const ProjectDocument &current,
    const DesiredAssetScope &scope, const std::string &id) {
    validate_desired_asset_scope(scope);
    asset_id(id);
    try {
        auto selected = project_physical_asset(current, scope.project_id, id, scope.allow_internal);
        need(selected.value.site == scope.site_id && selected.path.site_id == scope.site_id &&
             selected.placement.has_value() &&
             selected.placement->environment_id == scope.environment_id &&
             selected.path.environment_id == scope.environment_id, Code::ScopeDenied);
        // Shared validation already enforces parent placement consistency and
        // full Area/Asset depth. A missing role is neither inferred nor denied.
        const auto &asset = find_asset(current.topology, id);
        return {std::move(selected), {asset.enabled, asset.poll_ms}, current.topology.revision};
    } catch (const DesiredAssetError &) { throw; }
    catch (const PhysicalHierarchyError &error) { physical_failure(error.code()); }
    catch (const std::exception &) { refuse(Code::OwnerUnavailable); }
}

DesiredAssetTransition apply_desired_asset(const ProjectDocument &current,
    const DesiredAssetScope &scope, const DesiredAssetProposal &proposal) {
    const auto normalized = normalize_desired_asset_proposal(scope, proposal);
    auto before = select_desired_asset(current, scope, normalized.asset_id);
    // Do not move these comparisons ahead of complete inherited authorization.
    need(before.revision == normalized.expected_revision, Code::RevisionConflict);
    need(before.values == normalized.expected, Code::ConfigConflict);
    need(before.revision < max_saved_revision, Code::BudgetExceeded);
    try {
        auto draft = current;
        auto found = std::find_if(draft.topology.assets.begin(), draft.topology.assets.end(),
            [&](const auto &asset) { return asset.id == normalized.asset_id; });
        need(found != draft.topology.assets.end(), Code::OwnerUnavailable);
        found->enabled = normalized.desired.enabled;
        found->poll_ms = normalized.desired.poll_ms;
        validate(draft);
        // The owner alone advances revision, checks registry/lineage and writes.
        return {std::move(draft), std::move(before),
                {normalized.asset_id, normalized.expected, normalized.desired}};
    } catch (const DesiredAssetError &) { throw; }
    catch (const std::exception &) { refuse(Code::OwnerUnavailable); }
}
} // namespace lmti
