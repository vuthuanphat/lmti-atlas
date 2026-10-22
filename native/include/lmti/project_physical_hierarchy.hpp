#pragma once
#include "project.hpp"
#include <optional>
#include <variant>

namespace lmti {
inline constexpr std::size_t max_physical_hierarchy_changes = 32;
inline constexpr std::size_t max_physical_hierarchy_request_bytes = 32768;

// Trusted local whole-project capability. Logical/Agent/site/copy grants do not
// imply this authority, and untrusted proposal fields never supply these flags.
struct PhysicalHierarchyScope {
    std::string project_id;
    bool allow_physical_write = false;
    bool allow_internal = false;
    bool operator==(const PhysicalHierarchyScope &) const = default;
};
struct PhysicalAssetAnchor {
    std::string id, label, site;
    Kind kind = Kind::Machine;
    Privacy privacy = Privacy::Internal;
    bool operator==(const PhysicalAssetAnchor &) const = default;
};
// Site context is populated for sites/areas/assets, empty for environments.
// Area rows list root-to-parent areas; assets include their direct area.
// Asset ancestry is root-to-parent and excludes the asset itself. Environment
// is a separate membership, never a containment edge. Absent rows use {}.
struct PhysicalHierarchyPath {
    std::string site_id;
    std::vector<std::string> area_ancestors, asset_ancestors;
    std::string environment_id;
    bool operator==(const PhysicalHierarchyPath &) const = default;
};
struct PhysicalSiteRow {
    Site value;
    Privacy classification;
};
struct PhysicalAreaRow {
    Area value;
    std::vector<std::string> ancestors;
    Privacy classification;
};
struct PhysicalEnvironmentRow {
    Environment value;
    Privacy classification;
};
struct PhysicalAssetRow {
    PhysicalAssetAnchor value;
    std::optional<AssetPlacement> placement;
    PhysicalHierarchyPath path;
    Privacy classification;
};
struct PhysicalHierarchyProjection {
    std::string project_id;
    std::int64_t revision;
    std::vector<PhysicalSiteRow> sites;
    std::vector<PhysicalAreaRow> areas;
    std::vector<PhysicalEnvironmentRow> environments;
    std::vector<PhysicalAssetRow> assets;
};

struct AddSite { Site desired; bool operator==(const AddSite &) const = default; };
struct RenameSite {
    Site expected;
    std::string desired_label;
    bool operator==(const RenameSite &) const = default;
};
struct RetireEmptySite { Site expected; bool operator==(const RetireEmptySite &) const = default; };
struct AddArea { Area desired; bool operator==(const AddArea &) const = default; };
struct RenameArea {
    Area expected;
    std::string desired_label;
    bool operator==(const RenameArea &) const = default;
};
struct ReparentArea {
    Area expected;
    std::string desired_parent_id; // Empty means the same site's root.
    bool operator==(const ReparentArea &) const = default;
};
struct RetireEmptyArea { Area expected; bool operator==(const RetireEmptyArea &) const = default; };
struct AddEnvironment { Environment desired; bool operator==(const AddEnvironment &) const = default; };
struct RenameEnvironment {
    Environment expected;
    std::string desired_label;
    bool operator==(const RenameEnvironment &) const = default;
};
struct RetireEmptyEnvironment {
    Environment expected;
    bool operator==(const RetireEmptyEnvironment &) const = default;
};
struct SetAssetPlacement {
    PhysicalAssetAnchor expected_asset;
    std::optional<AssetPlacement> expected, desired;
    bool operator==(const SetAssetPlacement &) const = default;
};
using PhysicalHierarchyChange = std::variant<AddSite, RenameSite, RetireEmptySite,
    AddArea, RenameArea, ReparentArea, RetireEmptyArea,
    AddEnvironment, RenameEnvironment, RetireEmptyEnvironment, SetAssetPlacement>;
struct PhysicalHierarchyProposal {
    std::string project_id;
    std::int64_t expected_revision = 0;
    std::vector<PhysicalHierarchyChange> changes;
    bool operator==(const PhysicalHierarchyProposal &) const = default;
};
enum class PhysicalHierarchyCode {
    InvalidArgument, ScopeDenied, Conflict, Unsupported, BudgetExceeded, OwnerUnavailable
};
class PhysicalHierarchyError : public Error {
    PhysicalHierarchyCode code_;
public:
    explicit PhysicalHierarchyError(PhysicalHierarchyCode code);
    PhysicalHierarchyCode code() const noexcept { return code_; }
};
enum class PhysicalHierarchyEntityKind { Site, Area, Environment, Asset };
struct PhysicalSiteChange {
    std::string id;
    std::optional<Site> before, after;
    bool operator==(const PhysicalSiteChange &) const = default;
};
struct PhysicalAreaChange {
    std::string id;
    std::optional<Area> before, after;
    bool operator==(const PhysicalAreaChange &) const = default;
};
struct PhysicalEnvironmentChange {
    std::string id;
    std::optional<Environment> before, after;
    bool operator==(const PhysicalEnvironmentChange &) const = default;
};
struct PhysicalPlacementChange {
    std::string asset_id;
    std::optional<AssetPlacement> before, after;
    bool operator==(const PhysicalPlacementChange &) const = default;
};
struct PhysicalHierarchyAffectedIdentity {
    PhysicalHierarchyEntityKind kind;
    std::string id;
    std::optional<Privacy> before_classification, after_classification;
    PhysicalHierarchyPath before_path, after_path;
    bool operator==(const PhysicalHierarchyAffectedIdentity &) const = default;
};
struct PhysicalHierarchyDiff {
    // Stable ID order; affected rows use kind then ID.
    std::vector<PhysicalSiteChange> sites;
    std::vector<PhysicalAreaChange> areas;
    std::vector<PhysicalEnvironmentChange> environments;
    std::vector<PhysicalPlacementChange> placements;
    std::vector<PhysicalHierarchyAffectedIdentity> affected;
    bool operator==(const PhysicalHierarchyDiff &) const = default;
};
struct PhysicalHierarchyTransition {
    ProjectDocument document; // Storage owns revision, lineage and registry.
    PhysicalHierarchyDiff diff;
};

// Pure pre-I/O request validation and stable target kind/ID ordering.
PhysicalHierarchyProposal normalize_physical_hierarchy_proposal(
    const PhysicalHierarchyScope &, const PhysicalHierarchyProposal &);
// Complete authorized physical view, stable ID order, including unused catalogs.
// Stored privacy remains in values; effective inherited privacy is separate.
PhysicalHierarchyProjection project_physical_hierarchy(
    const ProjectDocument &, const PhysicalHierarchyScope &);
// Targeted read capability: shares the full inherited path/privacy policy above
// without granting physical editing. Missing/hidden targets use ScopeDenied.
// Placement declaration/role are preserved; storage owns registry and lineage.
PhysicalAssetRow project_physical_asset(const ProjectDocument &,
    const std::string &project_id, const std::string &asset_id, bool allow_internal);
// Original old values; final-draft references and empty retirement; no implicit
// relocation/cascade/declassification. Every unrelated document field is kept.
// Storage must separately enforce lineage and active/retired identity registry.
PhysicalHierarchyTransition apply_physical_hierarchy(const ProjectDocument &,
    const PhysicalHierarchyScope &, const PhysicalHierarchyProposal &);
} // namespace lmti
