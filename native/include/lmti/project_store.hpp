#pragma once
#include "project.hpp"
#include "project_copy.hpp"
#include "project_hierarchy.hpp"
#include "project_physical_hierarchy.hpp"
#include <QJsonObject>
#include <QString>
#include <memory>
namespace lmti {
ProjectDocument load_project(const QString &path);
struct ProjectMetadata {
    ProjectInfo project;
    std::int64_t revision;
};
// Validated owner metadata only. Does not certify graph health or replace the
// complete document validation required by context, generation or mutations.
ProjectMetadata load_project_metadata(const QString &path);
std::int64_t save_project(const QString &path, const ProjectDocument &document);
// Structured writes require mutable native owner state: a successful commit
// attaches lineage even on the first save. Revision remains the return value.
// The const overload preserves flat compatibility but refuses structured writes.
std::int64_t save_project(const QString &path, ProjectDocument &document);
enum class HierarchyCommitState { Committed, Unknown };
struct HierarchyCommitResult {
    HierarchyCommitState state = HierarchyCommitState::Unknown;
    // Only a known committed result has a revision. Unknown is not evidence of
    // rollback or success and must not automatically replay the attempted edit.
    std::int64_t revision = 0;
};
// Private versioned transport data, never a grant or public/Agent DTO. A trusted
// broker must retain the original token and consume dispatch attempts: this
// value is not authenticated and is not a durable one-use operation receipt.
struct HierarchyReviewToken {
    int version = 1;
    ProjectCopyToken snapshot;
    LogicalHierarchyScope scope;
    LogicalHierarchyProposal proposal;
    QString proposal_digest, diff_digest;
};
struct HierarchyState {
    ProjectCopyToken snapshot;
    LogicalHierarchyProjection projection;
};
// Owner-created, native-only review. Copies share one synchronized consumption
// state. No constructor or mutable document/registry is exposed to callers.
// Scope, snapshot and normalized proposal are pinned privately, without a
// durable per-operation receipt or cross-store/library atomicity claim.
class HierarchyReview final {
    struct Data;
    std::shared_ptr<Data> data_;
    explicit HierarchyReview(std::shared_ptr<Data>);
    friend HierarchyReview preview_logical_hierarchy(const QString &,
        const LogicalHierarchyScope &, const LogicalHierarchyProposal &);
    friend HierarchyCommitResult commit_logical_hierarchy(const QString &,
        const LogicalHierarchyScope &, const HierarchyReview &);
    friend HierarchyReviewToken export_logical_hierarchy_review(const HierarchyReview &);
    friend HierarchyReview restore_logical_hierarchy_review(const QString &,
        const LogicalHierarchyScope &, const HierarchyReviewToken &);
  public:
    HierarchyReview(const HierarchyReview &) = default;
    HierarchyReview &operator=(const HierarchyReview &) = default;
    HierarchyReview(HierarchyReview &&) noexcept = default;
    HierarchyReview &operator=(HierarchyReview &&) noexcept = default;
    const LogicalHierarchyProposal &proposal() const;
    const LogicalHierarchyDiff &diff() const;
    std::int64_t reviewed_revision() const;
};
HierarchyReview preview_logical_hierarchy(const QString &existing_path,
    const LogicalHierarchyScope &, const LogicalHierarchyProposal &);
HierarchyReviewToken export_logical_hierarchy_review(const HierarchyReview &);
// Validates the entire typed token before filesystem I/O, then compares its
// original pins with one held native snapshot. Never replaces stale pins.
HierarchyReview restore_logical_hierarchy_review(const QString &existing_path,
    const LogicalHierarchyScope &, const HierarchyReviewToken &);
// Snapshot and projection come from the same held schema-2 read transaction.
HierarchyState inspect_logical_hierarchy(const QString &existing_path,
    const LogicalHierarchyScope &);
// Revalidates the held snapshot and applies graph/registry/revision in the same
// BEGIN IMMEDIATE transaction. Known pre-COMMIT refusal throws HierarchyError.
// Once DML starts the review is consumed, including a known rollback; ambiguous
// COMMIT outcomes return Unknown and remain consumed.
HierarchyCommitResult commit_logical_hierarchy(const QString &existing_path,
    const LogicalHierarchyScope &, const HierarchyReview &);
#ifdef LMTI_HIERARCHY_OWNER_TEST_HOOKS
// Isolated owner test executable only; absent from the shipped storage library.
enum class HierarchyOwnerTestPoint { BeforeCommit, AfterCommit };
using HierarchyOwnerTestHook = void (*)(HierarchyOwnerTestPoint);
void set_hierarchy_owner_test_hook(HierarchyOwnerTestHook);
#endif
enum class PhysicalHierarchyCommitState { Committed, Unknown };
struct PhysicalHierarchyCommitResult {
    PhysicalHierarchyCommitState state = PhysicalHierarchyCommitState::Unknown;
    // Unknown has no known revision and must never trigger automatic replay.
    std::int64_t revision = 0;
};
// Private transport pins, not authority or an authenticated/durable receipt.
// The physical domain tag and digest framing are distinct from logical review.
struct PhysicalHierarchyReviewToken {
    int version = 1;
    QString domain = QStringLiteral("lmti.physical-hierarchy.review.v1");
    ProjectCopyToken snapshot;
    PhysicalHierarchyScope scope;
    PhysicalHierarchyProposal proposal;
    QString proposal_digest, diff_digest;
};
struct PhysicalHierarchyState {
    ProjectCopyToken snapshot;
    PhysicalHierarchyProjection projection;
};
class PhysicalHierarchyReview final {
    struct Data;
    std::shared_ptr<Data> data_;
    explicit PhysicalHierarchyReview(std::shared_ptr<Data>);
    friend PhysicalHierarchyReview preview_physical_hierarchy(const QString &,
        const PhysicalHierarchyScope &, const PhysicalHierarchyProposal &);
    friend PhysicalHierarchyCommitResult commit_physical_hierarchy(const QString &,
        const PhysicalHierarchyScope &, const PhysicalHierarchyReview &);
    friend PhysicalHierarchyReviewToken export_physical_hierarchy_review(const PhysicalHierarchyReview &);
    friend PhysicalHierarchyReview restore_physical_hierarchy_review(const QString &,
        const PhysicalHierarchyScope &, const PhysicalHierarchyReviewToken &);
  public:
    PhysicalHierarchyReview(const PhysicalHierarchyReview &) = default;
    PhysicalHierarchyReview &operator=(const PhysicalHierarchyReview &) = default;
    PhysicalHierarchyReview(PhysicalHierarchyReview &&) noexcept = default;
    PhysicalHierarchyReview &operator=(PhysicalHierarchyReview &&) noexcept = default;
    const PhysicalHierarchyProposal &proposal() const;
    const PhysicalHierarchyDiff &diff() const;
    std::int64_t reviewed_revision() const;
};
PhysicalHierarchyReview preview_physical_hierarchy(const QString &existing_path,
    const PhysicalHierarchyScope &, const PhysicalHierarchyProposal &);
PhysicalHierarchyReviewToken export_physical_hierarchy_review(const PhysicalHierarchyReview &);
// Entire typed token is validated before filesystem I/O. Restore retains the
// supplied original pins; it does not refresh a stale review or grant authority.
PhysicalHierarchyReview restore_physical_hierarchy_review(const QString &existing_path,
    const PhysicalHierarchyScope &, const PhysicalHierarchyReviewToken &);
PhysicalHierarchyState inspect_physical_hierarchy(const QString &existing_path,
    const PhysicalHierarchyScope &);
// Same-connection snapshot comparison, graph/registry/revision mutation and
// COMMIT. Review copies share synchronized one-use state within this process.
// A known rollback after DML consumes the review too. Unknown is no receipt.
PhysicalHierarchyCommitResult commit_physical_hierarchy(const QString &existing_path,
    const PhysicalHierarchyScope &, const PhysicalHierarchyReview &);
#ifdef LMTI_PHYSICAL_HIERARCHY_OWNER_TEST_HOOKS
enum class PhysicalHierarchyOwnerTestPoint { DuringRowRewrite, BeforeCommit, AfterCommit };
using PhysicalHierarchyOwnerTestHook = void (*)(PhysicalHierarchyOwnerTestPoint);
void set_physical_hierarchy_owner_test_hook(PhysicalHierarchyOwnerTestHook);
#endif

struct RecentProject {
    QString id, label, path;
};
std::vector<RecentProject> recent_projects(const QString &catalog);
void remember_project(const QString &catalog, const RecentProject &project);
struct ProjectScope {
    std::string project_id, site;
    bool external = true;
    std::size_t limit = 100;
};
QJsonObject project_context(const ProjectDocument &, const ProjectScope &);
// Full declared projection of one saved, authorized project revision. Unlike context,
// this boundary never truncates: unsupported/oversized snapshots fail closed.
QJsonObject project_snapshot(const QString &path, const ProjectScope &, bool include_references = false);
// Opt-in hierarchy/reference projection; full authorized snapshot, never truncated.
QJsonObject project_structure_snapshot(const QString &path, const ProjectScope &);
QJsonObject project_impact(const ProjectDocument &, const ProjectScope &, const std::string &component_id);
WorkProposal parse_work_proposal(const QJsonObject &);
QJsonObject work_proposal_json(const WorkProposal &);
} // namespace lmti
