#pragma once
#include "project.hpp"
#include <optional>
#include <variant>

namespace lmti {
inline constexpr std::size_t max_logical_hierarchy_changes = 32;
inline constexpr std::size_t max_logical_hierarchy_request_bytes = 32768;

// Trusted local-operator capability for the whole project's logical hierarchy.
// Neither an Agent read scope nor a project-copy grant implies this capability.
// These values are never decoded from untrusted proposal arguments.
struct LogicalHierarchyScope {
    std::string project_id;
    bool allow_logical_write = false;
    bool allow_internal = false;
    bool operator==(const LogicalHierarchyScope &) const = default;
};
struct LogicalSubsystemRow {
    Subsystem value;
    std::vector<std::string> ancestors;
    Privacy classification;
};
struct LogicalComponentRow {
    SoftwareComponent value;
    std::optional<ComponentMembership> membership;
    std::vector<std::string> ancestors;
    Privacy classification;
};
struct LogicalHierarchyProjection {
    std::string project_id;
    std::int64_t revision;
    std::vector<LogicalSubsystemRow> subsystems;
    std::vector<LogicalComponentRow> components;
};
// Complete authorized logical view in stable ID order. Effective classification
// includes project, repository and subsystem ancestry; hidden rows are omitted
// without promoting their children or changing any original membership.
LogicalHierarchyProjection project_logical_hierarchy(
    const ProjectDocument &, const LogicalHierarchyScope &);
struct AddSubsystem {
    Subsystem desired; // New IDs require Internal classification in this slice.
    bool operator==(const AddSubsystem &) const = default;
};
struct RenameSubsystem {
    Subsystem expected;
    std::string desired_label;
    bool operator==(const RenameSubsystem &) const = default;
};
struct ReparentSubsystem {
    Subsystem expected;
    std::string desired_parent_id; // Empty means the project root.
    bool operator==(const ReparentSubsystem &) const = default;
};
struct SetComponentMembership {
    SoftwareComponent expected_component;
    std::optional<ComponentMembership> expected; // Original snapshot membership.
    std::optional<std::string> desired_subsystem_id; // nullopt means unassigned.
    bool operator==(const SetComponentMembership &) const = default;
};
struct RetireEmptySubsystem {
    Subsystem expected; // Emptiness is checked on the final draft, not this row.
    bool operator==(const RetireEmptySubsystem &) const = default;
};
using LogicalHierarchyChange = std::variant<AddSubsystem, RenameSubsystem,
    ReparentSubsystem, SetComponentMembership, RetireEmptySubsystem>;
struct LogicalHierarchyProposal {
    std::string project_id;
    std::int64_t expected_revision = 0;
    std::vector<LogicalHierarchyChange> changes;
    bool operator==(const LogicalHierarchyProposal &) const = default;
};
enum class HierarchyCode {
    InvalidArgument, ScopeDenied, Conflict, Unsupported, BudgetExceeded, OwnerUnavailable
};
class HierarchyError : public Error {
    HierarchyCode code_;
public:
    explicit HierarchyError(HierarchyCode code);
    HierarchyCode code() const noexcept { return code_; }
};
enum class HierarchyEntityKind { Subsystem, Component };
struct SubsystemChange {
    std::string id;
    std::optional<Subsystem> before, after;
    bool operator==(const SubsystemChange &) const = default;
};
struct ComponentMembershipChange {
    std::string component_id;
    std::optional<ComponentMembership> before, after;
    bool operator==(const ComponentMembershipChange &) const = default;
};
struct HierarchyAffectedIdentity {
    HierarchyEntityKind kind;
    std::string id;
    std::optional<Privacy> before_classification, after_classification;
    // Root-to-parent subsystem IDs; project identity is in the proposal.
    // Components include their direct subsystem. Absent rows have empty paths.
    std::vector<std::string> before_ancestors, after_ancestors;
    bool operator==(const HierarchyAffectedIdentity &) const = default;
};
struct LogicalHierarchyDiff {
    // Stable order by ID (affected: kind, then ID), independent of input order.
    std::vector<SubsystemChange> subsystems;
    std::vector<ComponentMembershipChange> memberships;
    std::vector<HierarchyAffectedIdentity> affected;
    bool operator==(const LogicalHierarchyDiff &) const = default;
};
struct LogicalHierarchyTransition {
    ProjectDocument document; // Revision/lineage are unchanged; storage owns commit.
    LogicalHierarchyDiff diff;
};
// Pure pre-I/O validation plus stable target-kind/ID ordering. Uses a bounded
// JSON-escaped UTF-8 footprint including conservative per-operation framing.
LogicalHierarchyProposal normalize_logical_hierarchy_proposal(
    const LogicalHierarchyScope &scope, const LogicalHierarchyProposal &proposal);
// Pure, nonwriting transition. Expected values use the original snapshot; all
// desired references and empty retirements use the complete final draft.
// Storage must additionally enforce its current registry, lineage and token.
LogicalHierarchyTransition apply_logical_hierarchy(const ProjectDocument &current,
    const LogicalHierarchyScope &scope, const LogicalHierarchyProposal &proposal);
} // namespace lmti
