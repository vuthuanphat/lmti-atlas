#pragma once
#include "topology.hpp"
#include <optional>

namespace lmti {
inline constexpr std::size_t max_project_records = 2000;
enum class ComponentKind { Firmware, Gateway, Backend, Desktop, Driver, Library };
enum class WorkState { Todo, InProgress, Review, Done, Blocked };
enum class WorkKind { Task, Bug, Integration, Validation };
enum class ReleaseState { Draft, Candidate, Approved, Archived };
enum class EvidenceResult { OperatorDeclared, Passed, Failed };
struct ProjectInfo {
    std::string id, label, goal;
    Privacy privacy = Privacy::Internal;
    bool operator==(const ProjectInfo &) const = default;
};
struct RepositoryRef {
    std::string id, label, locator;
    Privacy privacy = Privacy::Internal;
    bool operator==(const RepositoryRef &) const = default;
};
struct SoftwareComponent {
    std::string id, label, repository_id;
    ComponentKind kind = ComponentKind::Firmware;
    Privacy privacy = Privacy::Internal;
    bool operator==(const SoftwareComponent &) const = default;
};
struct HardwareTarget {
    std::string id, label, hardware_revision, architecture;
    Privacy privacy = Privacy::Internal;
    bool operator==(const HardwareTarget &) const = default;
};
struct SoftwareRelease {
    std::string id, label, component_id, target_id, source_revision;
    ReleaseState state = ReleaseState::Draft;
    Privacy privacy = Privacy::Internal;
    bool operator==(const SoftwareRelease &) const = default;
};
struct SoftwareBinding {
    std::string id, asset_id, component_id, release_id, target_id;
    Privacy privacy = Privacy::Internal;
    bool operator==(const SoftwareBinding &) const = default;
};
struct ComponentDependency {
    std::string id, from, to, contract;
    Privacy privacy = Privacy::Internal;
    bool operator==(const ComponentDependency &) const = default;
};
struct VerificationRecord {
    std::string id, release_id, asset_id, evidence, source;
    std::int64_t at = 0;
    EvidenceResult result = EvidenceResult::OperatorDeclared;
    Privacy privacy = Privacy::Internal;
    bool operator==(const VerificationRecord &) const = default;
};
struct Milestone {
    std::string id, label, criteria, due_date;
    Privacy privacy = Privacy::Internal;
    bool accepted = false;
    std::string evidence;
    bool operator==(const Milestone &) const = default;
};
struct WorkItem {
    std::string id, label, component_id, asset_id, release_id, milestone_id, checklist, evidence;
    WorkKind kind = WorkKind::Task;
    WorkState state = WorkState::Todo;
    Privacy privacy = Privacy::Internal;
    bool operator==(const WorkItem &) const = default;
};
struct KnowledgeRef {
    std::string id, label, component_id, reference, fingerprint;
    Privacy privacy = Privacy::Internal;
    bool operator==(const KnowledgeRef &) const = default;
};
inline constexpr std::size_t max_structure_depth = 32; // Edges from project/site root.
enum class PhysicalRole { Host, Gateway, Device };
struct Subsystem {
    std::string id, label, parent_subsystem_id;
    Privacy privacy = Privacy::Internal;
    bool operator==(const Subsystem &) const = default;
};
struct ComponentMembership {
    std::string component_id, subsystem_id;
    bool operator==(const ComponentMembership &) const = default;
};
struct Site {
    std::string id, label;
    Privacy privacy = Privacy::Internal;
    bool operator==(const Site &) const = default;
};
struct Area {
    std::string id, label, site_id, parent_area_id;
    Privacy privacy = Privacy::Internal;
    bool operator==(const Area &) const = default;
};
struct Environment {
    std::string id, label;
    Privacy privacy = Privacy::Internal;
    bool operator==(const Environment &) const = default;
};
struct AssetPlacement {
    std::string asset_id, area_id, parent_asset_id, environment_id;
    // An unspecified role stays unknown, regardless of Asset.kind or label.
    std::optional<PhysicalRole> role;
    bool operator==(const AssetPlacement &) const = default;
};
struct ProjectStructure {
    std::vector<Subsystem> subsystems;
    std::vector<ComponentMembership> component_memberships;
    std::vector<Site> sites;
    std::vector<Area> areas;
    std::vector<Environment> environments;
    std::vector<AssetPlacement> asset_placements;
    bool operator==(const ProjectStructure &) const = default;
};
struct ProjectDocument {
    ProjectInfo project;
    Topology topology;
    std::vector<RepositoryRef> repositories;
    std::vector<SoftwareComponent> components;
    std::vector<HardwareTarget> targets;
    std::vector<SoftwareRelease> releases;
    std::vector<SoftwareBinding> bindings;
    std::vector<ComponentDependency> dependencies;
    std::vector<VerificationRecord> verification;
    std::vector<Milestone> milestones;
    std::vector<WorkItem> work;
    std::vector<KnowledgeRef> knowledge;
    // Absent means legacy/unavailable, not a declared empty hierarchy.
    std::optional<ProjectStructure> structure;
    struct StorageLineage {
        std::string project_id;
        int schema_version = 2; // Actual structured container version: 2 or receipt-capable 3.
        std::string store_path, store_uuid;
        bool operator==(const StorageLineage &) const = default;
    };
    // Native-only load/save marker; never part of an Agent projection. Copying
    // a saved v2 document needs an explicit registry-preserving owner API.
    std::optional<StorageLineage> storage_lineage;
    bool operator==(const ProjectDocument &) const = default;
};
struct WorkProposal {
    std::string project_id, work_id;
    std::int64_t revision = 0;
    WorkState expected = WorkState::Todo, desired = WorkState::Review;
};
void validate(const ProjectDocument &document);
void validate_project_info(const ProjectInfo &project);
void validate_update(const ProjectDocument &before, const ProjectDocument &after);
ProjectDocument demo_project();
ProjectDocument apply_proposal(const ProjectDocument &, const WorkProposal &);
std::string name(ComponentKind);
std::string name(WorkKind);
std::string name(WorkState);
std::string name(ReleaseState);
std::string name(EvidenceResult);
std::string name(PhysicalRole);
ComponentKind component_kind(const std::string &);
WorkKind work_kind(const std::string &);
WorkState work_state(const std::string &);
ReleaseState release_state(const std::string &);
EvidenceResult evidence_result(const std::string &);
PhysicalRole physical_role(const std::string &);
} // namespace lmti
