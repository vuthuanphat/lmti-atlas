#pragma once
#include "lmti/project_desired_asset.hpp"

// Include the pure header above rather than repeating its definitions.
#include "lmti/original_read.hpp"
#include <QString>
#include <memory>
#include <optional>
#include <vector>

namespace lmti {
struct DesiredAssetOriginalExpected {
    int schema = 3; // Exactly3 desired API; exactly2 maintenance preview.
    std::string store_uuid;
    OriginalPhysicalTarget physical;
};
struct DesiredAssetState {
    std::string project_id, store_uuid;
    std::int64_t revision = 0;
    std::string asset_id, site_id, environment_id;
    Privacy effective_privacy = Privacy::Internal;
    std::string ancestry_fingerprint;
    DesiredAssetValues values; // Flatten enabled/pollMs on the wire.
};
struct DesiredAssetSnapshotToken {
    int schema_version = 3;
    std::string project_id;
    QString canonical_path; // Comparison only; never used as an I/O path.
    std::string store_uuid;
    std::int64_t revision = 0;
    std::string content_digest, registry_digest, ledger_digest;
    bool operator==(const DesiredAssetSnapshotToken &) const = default;
};
struct DesiredAssetReviewToken {
    int version = 1;
    std::string operation_id;
    DesiredAssetScope scope;
    std::string original_target_digest;
    DesiredAssetSnapshotToken snapshot;
    DesiredAssetProposal proposal;
    std::string request_digest;
    DesiredAssetDiff diff;
    bool operator==(const DesiredAssetReviewToken &) const = default;
};
struct DesiredAssetReceipt {
    std::string origin_store_uuid, operation_id, request_digest, handoff_digest;
    std::string project_id, principal_id, grant_fingerprint, site_id, environment_id;
    bool allow_internal = false;
    std::string asset_id;
    Privacy effective_privacy = Privacy::Internal;
    std::int64_t base_revision = 0, committed_revision = 0;
    DesiredAssetValues expected, desired;
    std::string original_target_digest, before_content_digest, after_content_digest;
    std::string registry_digest, target_ancestry_digest, receipt_digest;
    bool operator==(const DesiredAssetReceipt &) const = default;
};
enum class DesiredAssetCommitState { Confirmed, Unknown };
struct DesiredAssetCommitResult {
    DesiredAssetCommitState state = DesiredAssetCommitState::Unknown;
    std::string operation_id;
    std::optional<DesiredAssetReceipt> receipt;
    bool replayed = false;
};
class DesiredAssetReview {
  public:
    DesiredAssetReview(const DesiredAssetReview &) = default;
    DesiredAssetReview &operator=(const DesiredAssetReview &) = default;
    DesiredAssetReview(DesiredAssetReview &&) noexcept = default;
    DesiredAssetReview &operator=(DesiredAssetReview &&) noexcept = default;
    const DesiredAssetReviewToken &token() const;
    const std::optional<DesiredAssetState> &reviewed_state() const;
    const DesiredAssetDiff &diff() const;
    // Copyable immutable shared state; replay-only restore has nullopt state.
  private:
    struct Data;
    std::shared_ptr<Data> data_;
    explicit DesiredAssetReview(std::shared_ptr<Data>);
    friend DesiredAssetReview preview_desired_asset(const QString &,
        const DesiredAssetScope &, const DesiredAssetOriginalExpected &, const DesiredAssetProposal &);
    friend DesiredAssetReview restore_desired_asset_review(const QString &,
        const DesiredAssetScope &, const DesiredAssetOriginalExpected &, const DesiredAssetReviewToken &);
    friend DesiredAssetReviewToken export_desired_asset_review(const DesiredAssetReview &);
    friend DesiredAssetCommitResult commit_desired_asset(const QString &,
        const DesiredAssetScope &, const DesiredAssetOriginalExpected &, const DesiredAssetReview &);
};
DesiredAssetState inspect_desired_asset(const QString &fixed_db,
    const DesiredAssetScope &, const DesiredAssetOriginalExpected &, const std::string &asset_id);
DesiredAssetReview preview_desired_asset(const QString &fixed_db,
    const DesiredAssetScope &, const DesiredAssetOriginalExpected &, const DesiredAssetProposal &);
DesiredAssetReviewToken export_desired_asset_review(const DesiredAssetReview &);
DesiredAssetReview restore_desired_asset_review(const QString &fixed_db,
    const DesiredAssetScope &, const DesiredAssetOriginalExpected &, const DesiredAssetReviewToken &);
DesiredAssetCommitResult commit_desired_asset(const QString &fixed_db,
    const DesiredAssetScope &, const DesiredAssetOriginalExpected &, const DesiredAssetReview &);
std::optional<DesiredAssetReceipt> inspect_desired_asset_receipt(const QString &fixed_db,
    const DesiredAssetScope &, const DesiredAssetOriginalExpected &,
    const std::string &operation_id, const std::string &request_digest);

struct ProjectFormatMaintenanceScope {
    std::string project_id, store_uuid, principal_id, grant_fingerprint;
    bool allow_upgrade = false;
    bool operator==(const ProjectFormatMaintenanceScope &) const = default;
};
struct OriginalDirectoryExpected {
    QString path;
    std::vector<OriginalPhysicalIdentity> chain;
};
struct ProjectReceiptUpgradeSnapshot {
    int schema_version = 2;
    std::string project_id;
    QString canonical_path;
    std::string store_uuid;
    std::int64_t revision = 0;
    std::string content_digest, registry_digest;
};
struct ProjectReceiptUpgradeToken {
    int version = 1;
    std::string operation_id;
    ProjectFormatMaintenanceScope scope;
    DesiredAssetOriginalExpected original; // Must be schema2.
    OriginalDirectoryExpected backup_parent;
    ProjectReceiptUpgradeSnapshot snapshot;
    std::string review_digest;
};
struct ProjectReceiptFormat {
    int singleton = 1;
    std::string upgrade_operation_id, store_uuid;
    int from_schema = 2;
    std::int64_t source_revision = 0;
    std::string source_content_digest, source_registry_digest;
    std::string backup_sha256, format_digest;
};
enum class ProjectReceiptUpgradeState { Confirmed, Unknown };
struct ProjectReceiptUpgradeResult {
    ProjectReceiptUpgradeState state = ProjectReceiptUpgradeState::Unknown;
    std::string operation_id;
    std::optional<ProjectReceiptFormat> format;
};
enum class ProjectReceiptUpgradeCondition { Original, Upgraded, Unresolved };
struct ProjectReceiptUpgradeInspection {
    ProjectReceiptUpgradeCondition state = ProjectReceiptUpgradeCondition::Unresolved;
    bool backup_verified = false;
    std::optional<ProjectReceiptFormat> format;
};
ProjectReceiptUpgradeToken preview_project_receipt_upgrade(const QString &fixed_db,
    const QString &fixed_backup_parent, const ProjectFormatMaintenanceScope &,
    const DesiredAssetOriginalExpected &original_schema2);
ProjectReceiptUpgradeResult commit_project_receipt_upgrade(const QString &fixed_db,
    const QString &fixed_backup_parent, const ProjectFormatMaintenanceScope &,
    const ProjectReceiptUpgradeToken &);
ProjectReceiptUpgradeInspection inspect_project_receipt_upgrade(const QString &fixed_db,
    const QString &fixed_backup_parent, const ProjectFormatMaintenanceScope &,
    const ProjectReceiptUpgradeToken &);
#ifdef LMTI_DESIRED_ASSET_OWNER_TEST_HOOKS
// Isolated tests only. This declaration and all hook calls are absent from the
// shipped storage build. No environment or request field can select a fault.
enum class DesiredAssetOwnerTestPoint {
    AfterAssetUpdateBeforeReceipt, BeforeCommit, AfterCommit,
    UpgradeAfterBackupVerified, UpgradeBeforeCommit, UpgradeAfterCommit
};
using DesiredAssetOwnerTestHook = void (*)(DesiredAssetOwnerTestPoint);
void set_desired_asset_owner_test_hook(DesiredAssetOwnerTestHook);
#endif
// No SQL connection or arbitrary production callback is public.
} // namespace lmti
