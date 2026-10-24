#pragma once
#include "lmti/project_library.hpp"
#include <QJsonObject>

// Private native protocol values. These serializers confer no path authority.
namespace lmti::cli::project_operation_json {
inline QString library_code(LibraryCode code) {
    switch (code) {
    case LibraryCode::None: return "NONE";
    case LibraryCode::InvalidInput: return "INVALID_INPUT";
    case LibraryCode::UnsupportedFormat: return "UNSUPPORTED_FORMAT";
    case LibraryCode::Conflict: return "CONFIG_CHANGED";
    case LibraryCode::BudgetExceeded: return "BUDGET_EXCEEDED";
    case LibraryCode::OwnerUnavailable: return "OWNER_UNAVAILABLE";
    case LibraryCode::RecoveryRequired: return "RECOVERY_REQUIRED";
    }
    return "OWNER_UNAVAILABLE";
}
inline QString copy_code(ProjectCopyCode code) {
    switch (code) {
    case ProjectCopyCode::None: return "NONE";
    case ProjectCopyCode::InvalidInput: return "INVALID_INPUT";
    case ProjectCopyCode::SourceChanged: return "SOURCE_CHANGED";
    case ProjectCopyCode::UnsupportedSchema: return "UNSUPPORTED_SCHEMA";
    case ProjectCopyCode::BudgetExceeded: return "BUDGET_EXCEEDED";
    case ProjectCopyCode::OwnerUnavailable: return "OWNER_UNAVAILABLE";
    case ProjectCopyCode::EvidenceInvalid: return "EVIDENCE_INVALID";
    case ProjectCopyCode::TargetChanged: return "TARGET_CHANGED";
    }
    return "OWNER_UNAVAILABLE";
}
inline QString mode_name(ProjectCopyMode mode) {
    switch (mode) {
    case ProjectCopyMode::MigrateV1: return "migrate_v1";
    case ProjectCopyMode::CloneV2: return "clone_v2";
    }
    throw Error("Private operation value unavailable.");
}
inline QString activation_state(LibraryActivationState state) {
    switch (state) {
    case LibraryActivationState::Prepared: return "prepared";
    case LibraryActivationState::Activated: return "activated";
    case LibraryActivationState::Abandoned: return "abandoned";
    }
    throw Error("Private operation value unavailable.");
}
inline QJsonObject library_json(const LibraryToken &token) {
    return {{"schema", token.schema}, {"canonicalPath", token.canonical_path},
        {"uuid", token.schema == 1 ? QJsonValue(QJsonValue::Null) : QJsonValue(token.library_uuid)},
        {"generation", token.schema == 1 ? QJsonValue(QJsonValue::Null) : QJsonValue(token.generation)},
        {"digest", token.digest}};
}
inline QJsonObject token_json(const ProjectCopyToken &token) {
    return {{"schemaVersion", token.schema}, {"projectId", token.project_id},
        {"canonicalPath", token.canonical_path}, {"storeUuid", token.store_uuid},
        {"revision", token.revision}, {"contentDigest", token.content_digest},
        {"registryDigest", token.registry_digest}};
}
inline QJsonObject preview_json(const ProjectCopyPreview &preview) {
    return {{"mode", mode_name(preview.mode)}, {"seedsInternalSites", preview.seeds_internal_sites},
        {"source", token_json(preview.source)}, {"targetRevision", preview.target_revision},
        {"targetContentDigest", preview.target_content_digest},
        {"targetRegistryDigest", preview.target_registry_digest}};
}
inline QJsonObject format_preview_json(const LibraryFormatPreview &preview) {
    return {{"source", library_json(preview.source)}, {"fullSnapshotDigest", preview.full_snapshot_digest}};
}
inline QJsonObject activation_preview_json(const LibraryActivationPreview &preview) {
    return {{"library", library_json(preview.library)}, {"projectId", preview.project_id},
        {"copyParent", preview.copy_parent}, {"copyOperationId", preview.copy_operation_id},
        {"mode", mode_name(preview.mode)}, {"seedsInternalSites", preview.seeds_internal_sites},
        {"source", token_json(preview.source)}, {"target", token_json(preview.target)}};
}
inline QJsonObject activation_token_json(const LibraryActivationToken &token) {
    return {{"libraryUuid", token.library_uuid}, {"operationId", token.operation_id},
        {"receiptDigest", token.receipt_digest}, {"revision", token.revision}};
}
inline QJsonObject activation_receipt_json(const LibraryActivationReceipt &receipt) {
    return {{"token", activation_token_json(receipt.token)}, {"state", activation_state(receipt.state)},
        {"prepared", activation_preview_json(receipt.prepared)},
        {"sourceFolder", receipt.source_folder ? QJsonValue(*receipt.source_folder) : QJsonValue(QJsonValue::Null)},
        {"sourceFolderKey", receipt.source_folder_key ? QJsonValue(*receipt.source_folder_key) : QJsonValue(QJsonValue::Null)},
        {"activatedGeneration", receipt.activated_generation}};
}
inline QJsonObject status_json(const ProjectCopyStatus &status) {
    const bool metadata = (status.source.schema == 1 || status.source.schema == 2) && status.target.schema == 2;
    const auto null = QJsonValue(QJsonValue::Null);
    return {{"operationId", status.operation_id},
        {"state", status.state == ProjectCopyState::Prepared ? "prepared" : "recovery_required"},
        {"code", copy_code(status.code)},
        {"mode", metadata ? QJsonValue(mode_name(status.mode)) : null},
        {"seedsInternalSites", metadata ? QJsonValue(status.seeds_internal_sites) : null},
        {"verifiedReceipt", status.verified_receipt},
        {"source", metadata ? QJsonValue(token_json(status.source)) : null},
        {"target", metadata ? QJsonValue(token_json(status.target)) : null}};
}
} // namespace lmti::cli::project_operation_json
