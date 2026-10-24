#pragma once
#include "project.hpp"
#include <QString>
#include <optional>
#include <vector>

namespace lmti {
enum class ProjectCopyMode { MigrateV1, CloneV2 };
enum class ProjectCopyState { Prepared, RecoveryRequired };
enum class ProjectCopyCode { None, InvalidInput, SourceChanged, UnsupportedSchema, BudgetExceeded,
                             OwnerUnavailable, EvidenceInvalid, TargetChanged };
class ProjectCopyError : public Error {
  public:
    ProjectCopyCode code;
    explicit ProjectCopyError(ProjectCopyCode value) : Error("Project copy was refused."), code(value) {}
};
// Private operator/owner data, never an Agent projection or a path authorization.
struct ProjectCopyToken {
    int schema = 0;
    QString project_id, canonical_path, store_uuid;
    std::int64_t revision = 0;
    QString content_digest, registry_digest;
    bool operator==(const ProjectCopyToken &) const = default;
};
struct ProjectCopyPreview {
    ProjectCopyMode mode = ProjectCopyMode::MigrateV1;
    ProjectCopyToken source;
    std::int64_t target_revision = 0;
    QString target_content_digest, target_registry_digest;
    // Migration seeds known Site tokens with Internal privacy; clone is unchanged.
    bool seeds_internal_sites = false;
    bool operator==(const ProjectCopyPreview &) const = default;
};
struct ProjectCopyStatus {
    QString operation_id;
    ProjectCopyState state = ProjectCopyState::RecoveryRequired;
    ProjectCopyCode code = ProjectCopyCode::OwnerUnavailable;
    ProjectCopyMode mode = ProjectCopyMode::MigrateV1;
    bool seeds_internal_sites = false;
    bool verified_receipt = false;
    ProjectCopyToken source, target;
};
ProjectCopyPreview inspect_project_copy(const QString &source, ProjectCopyMode mode);
// Requires a fixed trusted local parent and a fresh expected preview. Chooses an
// exclusive UUID child directory and project.sqlite; never changes a library.
ProjectCopyStatus prepare_project_copy(const QString &source, const QString &trusted_parent,
                                      const ProjectCopyPreview &expected);
// Read-only reconciliation of fixed receipt/target filenames. Never retries writes,
// follows receipt-supplied paths or treats preparation evidence as activation.
ProjectCopyStatus inspect_project_copy_operation(const QString &trusted_parent, const QString &operation_id);

inline constexpr std::size_t max_project_copy_discovery_entries = 1000;
enum class ProjectCopyCandidateState { Uninspected, Incomplete, Invalid, Unavailable };
// Parsed intent metadata only. No source/target database or verified receipt was
// opened; even a well-formed intent is not proof that a copy exists or is valid.
struct ProjectCopyIntentMetadata {
    ProjectCopyMode mode = ProjectCopyMode::MigrateV1;
    bool seeds_internal_sites = false;
    ProjectCopyToken source, target;
};
struct ProjectCopyCandidate {
    QString operation_id;
    ProjectCopyCandidateState state = ProjectCopyCandidateState::Unavailable;
    std::optional<ProjectCopyIntentMetadata> intent;
};
struct ProjectCopyDiscovery {
    // Enumeration finished within the budget with no unavailable/raced entries.
    // This does not mean that candidates are valid copies or a complete history.
    bool complete = false;
    ProjectCopyCode code = ProjectCopyCode::OwnerUnavailable;
    // Every immediate entry counts, including invalid names. The first excess
    // entry is observed only as an overflow sentinel: maximum 1001, processed 1000.
    std::size_t examined_entries = 0;
    // Processed entries without validated intent; excludes an overflow sentinel.
    std::size_t unattributed_entries = 0;
    std::vector<ProjectCopyCandidate> candidates;
};
// Read-only, immediate-child discovery under one trusted local parent. Only
// canonical UUID names are candidates. Missing/invalid intent cannot attribute a
// child to a project. Never resumes writes, chooses the newest match or retries.
ProjectCopyDiscovery discover_project_copies(const QString &trusted_parent);
} // namespace lmti
