#pragma once
#include "project_store.hpp"
#include "project_copy.hpp"
#include <optional>

namespace lmti {
inline constexpr std::size_t max_library_entries = 500;
// Local library metadata only. Folder references confer no Agent/file permission.
struct LibraryEntry {
    QString id, label, path, folder;
    bool pinned = false;
    qint64 opened = 0;
};
std::vector<LibraryEntry> project_library(const QString &library);
void import_recent_library(const QString &catalog, const QString &library);
void remember_library_project(const QString &library, const LibraryEntry &entry);
// Explicit local operator bootstrap. Reserves a new v1 library exclusively;
// existing libraries require reviewed upgrades and the CAS registration API.
void initialize_project_library(const QString &library, const LibraryEntry &entry);
void pin_library_project(const QString &library, const QString &id, bool pinned);
void link_library_folder(const QString &library, const QString &id, const QString &folder);
void forget_library_project(const QString &library, const QString &id);
QString checked_project_folder(const QString &folder);

enum class LibraryCode { None, InvalidInput, UnsupportedFormat, Conflict, BudgetExceeded,
                         OwnerUnavailable, RecoveryRequired };
class LibraryError : public Error {
  public:
    LibraryCode code;
    explicit LibraryError(LibraryCode value) : Error("Library operation was refused."), code(value) {}
};
// Private native operator state. This token never authorizes browser paths or
// access to referenced files. V1 digest is full rows; v2 digest is bindings only.
struct LibraryToken {
    int schema = 0;
    QString canonical_path, library_uuid;
    qint64 generation = 0;
    QString digest;
    bool operator==(const LibraryToken &) const = default;
};
struct LibraryInspection {
    LibraryToken token;
    std::vector<LibraryEntry> entries;
    QString upgrade_operation_id, legacy_digest;
    QString activation_format_operation_id, activation_format_backup_digest;
};
enum class LibraryUpgradeState { Upgraded, RecoveryRequired };
struct LibraryUpgradeStatus {
    LibraryUpgradeState state = LibraryUpgradeState::RecoveryRequired;
    LibraryCode code = LibraryCode::RecoveryRequired;
    QString operation_id, backup_path;
    // On RecoveryRequired this can be empty or an intended, uncommitted token.
    // Only fresh inspection matching UUID + operation ID + backup digest proves
    // the upgrade is durable. Never infer success or replay from this field.
    LibraryToken library;
};
LibraryInspection inspect_project_library(const QString &library);
LibraryToken pin_library_project_cas(const QString &library, const QString &id, bool pinned,
                                    bool expected_pinned, const LibraryToken &expected);
// Explicit opt-in, verified typed v1 backup retained in a fresh UUID directory.
LibraryUpgradeStatus upgrade_project_library(const QString &library, const QString &trusted_backup_parent,
                                            const LibraryToken &expected);
// Native explicit intents only. No existing-ID database-path replacement API.
LibraryToken register_library_project_cas(const QString &library, const LibraryEntry &entry,
                                         const LibraryToken &expected);
LibraryToken link_library_folder_cas(const QString &library, const QString &id, const QString &folder,
                                    const LibraryToken &expected);
LibraryToken forget_library_project_cas(const QString &library, const QString &id,
                                       const LibraryToken &expected);

inline constexpr std::size_t max_library_activations = 1000;
struct LibraryFormatPreview {
    LibraryToken source;
    QString full_snapshot_digest;
    bool operator==(const LibraryFormatPreview &) const = default;
};
inline constexpr std::size_t max_library_backup_recovery_entries = 1000;
enum class LibraryBackupObservationState { Verified, Incomplete, Invalid, Foreign, Unavailable };
enum class LibraryBackupReceiptMatch { None, UpgradeV1, UpgradeV2 };
enum class LibraryUpgradeRecoveryCondition { OriginalStateVerified, CommittedStateVerified, Unresolved };
struct LibraryBackupObservation {
    QString artifact_key;
    // A canonical directory name is not attribution to an unknown operation.
    std::optional<QString> operation_id;
    std::optional<int> schema;
    std::optional<QString> full_snapshot_digest;
    LibraryBackupObservationState state = LibraryBackupObservationState::Unavailable;
    LibraryBackupReceiptMatch receipt_match = LibraryBackupReceiptMatch::None;
    bool matches_expected = false;
};
struct LibraryUpgradeRecovery {
    LibraryUpgradeRecoveryCondition condition = LibraryUpgradeRecoveryCondition::Unresolved;
    LibraryCode code = LibraryCode::RecoveryRequired;
    bool complete = false;
    std::size_t examined_entries = 0, unresolved_entries = 0;
    std::optional<LibraryToken> current;
    QString current_snapshot_digest, parent_snapshot_digest;
    // Only current durable owner metadata can populate this field.
    std::optional<QString> committed_operation_id;
    std::vector<LibraryBackupObservation> artifacts;
};
// Read-only full-parent observation. Valid equivalent artifacts can support a
// fresh-state review, but never identify a lost operation or rewrite its outcome.
// Source WAL reads may coordinate through an existing SHM; backups are immutable
// standalone reads. No domain mutation, checkpoint, retry, or artifact cleanup.
LibraryUpgradeRecovery inspect_library_upgrade_recovery(const QString &library,
    const QString &trusted_backup_parent, const LibraryFormatPreview &expected);

enum class LibraryActivationState { Prepared, Activated, Abandoned };
enum class LibraryActivationCondition {
    PreparedCurrent, PreparedStale, ActivatedCurrent, ActivatedSuperseded,
    Abandoned, Inconsistent, Unavailable
};
struct LibraryActivationPreview {
    LibraryToken library;
    QString project_id, copy_parent, copy_operation_id;
    ProjectCopyMode mode = ProjectCopyMode::MigrateV1;
    bool seeds_internal_sites = false;
    ProjectCopyToken source, target;
    bool operator==(const LibraryActivationPreview &) const = default;
};
struct LibraryActivationToken {
    QString library_uuid, operation_id, receipt_digest;
    qint64 revision = 0;
    bool operator==(const LibraryActivationToken &) const = default;
};
struct LibraryActivationReceipt {
    LibraryActivationToken token;
    LibraryActivationState state = LibraryActivationState::Prepared;
    LibraryActivationPreview prepared;
    std::optional<QString> source_folder, source_folder_key;
    qint64 activated_generation = 0;
    bool operator==(const LibraryActivationReceipt &) const = default;
};
struct LibraryActivationInspection {
    LibraryToken library;
    LibraryActivationReceipt receipt;
    LibraryActivationCondition condition = LibraryActivationCondition::Unavailable;
    LibraryCode code = LibraryCode::OwnerUnavailable;
};
struct LibraryActivationStatus {
    LibraryCode code = LibraryCode::RecoveryRequired;
    QString operation_id;
    // On RecoveryRequired, this may describe an intended uncommitted receipt.
    // Fresh UUID/operation inspection establishes durable state; never replay.
    std::optional<LibraryActivationReceipt> receipt;
};
struct LibraryActivationSummary {
    QString operation_id, project_id, copy_operation_id;
    LibraryActivationState state = LibraryActivationState::Prepared;
    qint64 revision = 0;
};
LibraryFormatPreview inspect_library_activation_upgrade(const QString &library);
LibraryUpgradeStatus upgrade_library_activation_format(const QString &library,
    const QString &trusted_backup_parent, const LibraryFormatPreview &expected);
LibraryActivationPreview inspect_library_activation_candidate(const QString &library,
    const QString &project_id, const QString &trusted_copy_parent, const QString &copy_operation_id);
LibraryActivationStatus prepare_library_activation(const QString &library,
    const QString &trusted_copy_parent, const LibraryActivationPreview &expected);
// Read-only lookup intentionally uses operation identity, not an obsolete receipt
// revision, so a lost response can be reconciled after a committed transition.
LibraryActivationInspection inspect_library_activation(const QString &library,
    const QString &trusted_copy_parent, const QString &expected_library_uuid, const QString &operation_id);
LibraryActivationStatus activate_library_copy(const QString &library,
    const QString &trusted_copy_parent, const LibraryActivationToken &expected_prepared);
LibraryActivationStatus abandon_library_activation(const QString &library,
    const LibraryActivationToken &expected_prepared);
std::vector<LibraryActivationSummary> list_library_activations(const QString &library);
#ifdef LMTI_LIBRARY_CORE_TEST_HOOKS
// Only the isolated test executable compiles this control; not shipped storage.
enum class LibraryTestFault { None, AfterBackupVerification, BeforeUpgradeCommit, AfterUpgradeCommit,
    BeforeMutationCommit, AfterMutationCommit, AfterFormatBackupVerification,
    BeforeFormatCommit, AfterFormatCommit, BeforePreparationCommit, AfterPreparationCommit,
    BeforeActivationCommit, AfterActivationCommit, BeforeAbandonCommit, AfterAbandonCommit };
void set_library_test_fault(LibraryTestFault value);
#endif
} // namespace lmti
