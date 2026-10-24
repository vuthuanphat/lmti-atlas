#include "project_desired_asset.hpp"
#include "lmti/project_desired_asset_store.hpp"
#include "../common/local_owner_path.hpp"
#include "../common/strict_json.hpp"
#include <QFile>
#include <QJsonArray>
#include <QJsonDocument>
#include <QSet>
#include <QUuid>
#include <array>
#include <cmath>
#include <cstdio>
#include <optional>
#ifdef Q_OS_WIN
#include <fcntl.h>
#include <io.h>
#endif

namespace {
using namespace lmti;
using Code = DesiredAssetCode;
constexpr qsizetype input_cap = 64 * 1024, output_cap = 128 * 1024;
constexpr qint64 max_revision = 9007199254740990LL;
constexpr std::array codes{Code::InvalidInput, Code::ScopeDenied, Code::ConfigChanged,
    Code::RevisionConflict, Code::ConfigConflict, Code::OperationConflict,
    Code::UnsupportedSchema, Code::BudgetExceeded, Code::OwnerUnavailable, Code::RecoveryRequired};
struct Refused { Code code; };
void need(bool condition, Code code = Code::InvalidInput) { if (!condition) throw Refused{code}; }
QString s(const std::string &value) { return QString::fromStdString(value); }
const char *name(Code code) noexcept {
    switch (code) {
    case Code::InvalidInput: return "INVALID_INPUT";
    case Code::ScopeDenied: return "SCOPE_DENIED";
    case Code::ConfigChanged: return "CONFIG_CHANGED";
    case Code::RevisionConflict: return "REVISION_CONFLICT";
    case Code::ConfigConflict: return "CONFIG_CONFLICT";
    case Code::OperationConflict: return "OPERATION_CONFLICT";
    case Code::UnsupportedSchema: return "UNSUPPORTED_SCHEMA";
    case Code::BudgetExceeded: return "BUDGET_EXCEEDED";
    case Code::OwnerUnavailable: return "OWNER_UNAVAILABLE";
    case Code::RecoveryRequired: return "RECOVERY_REQUIRED";
    }
    return "OWNER_UNAVAILABLE";
}
std::size_t index(Code code) noexcept {
    for (std::size_t i = 0; i < codes.size(); ++i) if (codes[i] == code) return i;
    return 8;
}
void fields(const QJsonObject &o, const QSet<QString> &keys) {
    need(o.size() == keys.size());
    for (auto it = o.begin(); it != o.end(); ++it) need(keys.contains(it.key()));
}
QJsonObject object(const QJsonValue &value) { need(value.isObject()); return value.toObject(); }
QJsonObject object(const QJsonObject &o, const char *key) { return object(o.value(key)); }
QString text(const QJsonValue &v, qsizetype cap) {
    need(v.isString()); const auto result = v.toString();
    need(result.isValidUtf16() && result.toUtf8().size() <= cap);
    for (const auto c : result) need(c.unicode() >= 32 && c.unicode() != 127);
    return result;
}
QString text(const QJsonObject &o, const char *key, qsizetype cap) { return text(o.value(key), cap); }
std::string id(const QJsonValue &v) {
    const auto result = text(v, 64).toStdString();
    try { validate_id(result); } catch (const Error &) { throw Refused{Code::InvalidInput}; }
    return result;
}
std::string id(const QJsonObject &o, const char *key) { return id(o.value(key)); }
std::string uuid(const QJsonValue &v) {
    const auto result = text(v, 36); const QUuid parsed(result);
    need(result.size() == 36 && !parsed.isNull() && parsed.toString(QUuid::WithoutBraces) == result);
    return result.toStdString();
}
std::string uuid(const QJsonObject &o, const char *key) { return uuid(o.value(key)); }
std::string hex(const QJsonValue &v) {
    const auto result = text(v, 64); need(result.size() == 64);
    for (const auto c : result)
        need((c >= QChar('0') && c <= QChar('9')) || (c >= QChar('a') && c <= QChar('f')));
    return result.toStdString();
}
std::string hex(const QJsonObject &o, const char *key) { return hex(o.value(key)); }
std::string principal(const QJsonValue &v) {
    const auto result = text(v, 160); need(!result.isEmpty()); return result.toStdString();
}
bool boolean(const QJsonObject &o, const char *key) {
    need(o.value(key).isBool()); return o.value(key).toBool();
}
qint64 integer(const QJsonObject &o, const char *key, qint64 low, qint64 high) {
    const auto v = o.value(key); need(v.isDouble()); const auto n = v.toDouble();
    need(std::isfinite(n) && std::floor(n) == n && n >= low && n <= high); return v.toInteger();
}
QString path(const QJsonValue &v) {
    const auto result = text(v, 4096);
    for (const auto c : result) need(!QStringLiteral("<>\"|?*").contains(c));
    try { (void)detail::local_owner_path_lexical(result); }
    catch (const Error &) { throw Refused{Code::InvalidInput}; }
    return result; // Preserve raw spelling; the owner checks the original target.
}
QString decimal(const QJsonObject &o, const char *key, bool positive) {
    const auto result = text(o, key, 40);
    need(!result.isEmpty() && (result.size() == 1 || result[0] != QChar('0')));
    for (const auto c : result) need(c >= QChar('0') && c <= QChar('9'));
    need(!positive || result != "0"); return result; // Owner checks exact Win32 bounds.
}
std::vector<OriginalPhysicalIdentity> chain(const QJsonValue &value) {
    need(value.isArray()); const auto array = value.toArray();
    need(array.size() <= 64, Code::BudgetExceeded); need(!array.isEmpty());
    std::vector<OriginalPhysicalIdentity> result; result.reserve(array.size());
    for (const auto &raw : array) {
        const auto o = object(raw); fields(o, {"dev", "ino", "birthtimeNs"});
        result.push_back({decimal(o, "dev", false), decimal(o, "ino", true),
                          decimal(o, "birthtimeNs", true)});
    }
    return result;
}
OriginalPhysicalTarget physical(const QJsonObject &o) {
    fields(o, {"version", "path", "kind", "state", "chain"});
    integer(o, "version", 1, 1);
    need(text(o, "kind", 4) == "file" && text(o, "state", 7) == "present");
    return {path(o.value("path")), OriginalPhysicalState::Present, chain(o.value("chain"))};
}
DesiredAssetOriginalExpected original(const QJsonObject &o, int schema) {
    fields(o, {"schema", "storeUuid", "physical"});
    return {static_cast<int>(integer(o, "schema", schema, schema)), uuid(o, "storeUuid"),
            physical(object(o, "physical"))};
}
DesiredAssetScope scope(const QJsonObject &o) {
    fields(o, {"projectId", "storeUuid", "principalId", "grantFingerprint",
               "siteId", "environmentId", "allowInternal", "allowDesiredWrite"});
    return {id(o, "projectId"), uuid(o, "storeUuid"), principal(o.value("principalId")),
            hex(o, "grantFingerprint"), id(o, "siteId"), id(o, "environmentId"),
            boolean(o, "allowInternal"), boolean(o, "allowDesiredWrite")};
}
ProjectFormatMaintenanceScope maintenance(const QJsonObject &o) {
    fields(o, {"projectId", "storeUuid", "principalId", "grantFingerprint", "allowUpgrade"});
    return {id(o, "projectId"), uuid(o, "storeUuid"), principal(o.value("principalId")),
            hex(o, "grantFingerprint"), boolean(o, "allowUpgrade")};
}
DesiredAssetValues values(const QJsonObject &o) {
    fields(o, {"enabled", "pollMs"});
    return {boolean(o, "enabled"), static_cast<int>(integer(o, "pollMs", 100, 3600000))};
}
DesiredAssetProposal proposal(const QJsonObject &o) {
    fields(o, {"assetId", "expectedRevision", "expected", "desired", "handoffDigest"});
    return {id(o, "assetId"), integer(o, "expectedRevision", 1, max_revision),
            values(object(o, "expected")), values(object(o, "desired")), hex(o, "handoffDigest")};
}
DesiredAssetDiff diff(const QJsonObject &o) {
    fields(o, {"assetId", "expected", "desired"});
    return {id(o, "assetId"), values(object(o, "expected")), values(object(o, "desired"))};
}
DesiredAssetSnapshotToken snapshot(const QJsonObject &o) {
    fields(o, {"schemaVersion", "projectId", "canonicalPath", "storeUuid", "revision",
               "contentDigest", "registryDigest", "ledgerDigest"});
    return {static_cast<int>(integer(o, "schemaVersion", 3, 3)), id(o, "projectId"),
            path(o.value("canonicalPath")), uuid(o, "storeUuid"), integer(o, "revision", 1, max_revision),
            hex(o, "contentDigest"), hex(o, "registryDigest"), hex(o, "ledgerDigest")};
}
DesiredAssetReviewToken review(const QJsonObject &o) {
    fields(o, {"schema", "operationId", "scope", "originalTargetDigest", "snapshot",
               "proposal", "requestDigest", "diff"});
    need(text(o, "schema", 64) == "lmti.project.desired-asset.review.v1");
    return {1, uuid(o, "operationId"), scope(object(o, "scope")), hex(o, "originalTargetDigest"),
            snapshot(object(o, "snapshot")), proposal(object(o, "proposal")),
            hex(o, "requestDigest"), diff(object(o, "diff"))};
}
ProjectReceiptUpgradeToken upgrade(const QJsonObject &o) {
    fields(o, {"schema", "operationId", "scope", "original", "backupParent", "snapshot", "reviewDigest"});
    need(text(o, "schema", 64) == "lmti.project.proposal-format.review.v1");
    const auto parent = object(o, "backupParent"); fields(parent, {"path", "chain"});
    const auto snap = object(o, "snapshot");
    fields(snap, {"schemaVersion", "projectId", "canonicalPath", "storeUuid", "revision",
                  "contentDigest", "registryDigest"});
    return {1, uuid(o, "operationId"), maintenance(object(o, "scope")), original(object(o, "original"), 2),
            {path(parent.value("path")), chain(parent.value("chain"))},
            {static_cast<int>(integer(snap, "schemaVersion", 2, 2)), id(snap, "projectId"),
             path(snap.value("canonicalPath")), uuid(snap, "storeUuid"), integer(snap, "revision", 1, max_revision),
             hex(snap, "contentDigest"), hex(snap, "registryDigest")}, hex(o, "reviewDigest")};
}
QJsonObject values_json(const DesiredAssetValues &v) { return {{"enabled", v.enabled}, {"pollMs", v.poll_ms}}; }
QJsonObject diff_json(const DesiredAssetDiff &v) {
    return {{"assetId", s(v.asset_id)}, {"expected", values_json(v.expected)}, {"desired", values_json(v.desired)}};
}
QJsonObject proposal_json(const DesiredAssetProposal &v) {
    return {{"assetId", s(v.asset_id)}, {"expectedRevision", v.expected_revision},
            {"expected", values_json(v.expected)}, {"desired", values_json(v.desired)}, {"handoffDigest", s(v.handoff_digest)}};
}
QJsonArray chain_json(const std::vector<OriginalPhysicalIdentity> &v) {
    QJsonArray result;
    for (const auto &row : v) result.append(QJsonObject{{"dev", row.dev}, {"ino", row.ino}, {"birthtimeNs", row.birthtime_ns}});
    return result;
}
QJsonObject original_json(const DesiredAssetOriginalExpected &v) {
    return {{"schema", v.schema}, {"storeUuid", s(v.store_uuid)}, {"physical", QJsonObject{
        {"version", 1}, {"path", v.physical.path}, {"kind", "file"}, {"state", "present"},
        {"chain", chain_json(v.physical.chain)}}}};
}
QJsonObject scope_json(const DesiredAssetScope &v) {
    return {{"projectId", s(v.project_id)}, {"storeUuid", s(v.store_uuid)}, {"principalId", s(v.principal_id)},
            {"grantFingerprint", s(v.grant_fingerprint)}, {"siteId", s(v.site_id)},
            {"environmentId", s(v.environment_id)}, {"allowInternal", v.allow_internal},
            {"allowDesiredWrite", v.allow_desired_write}};
}
QJsonObject review_json(const DesiredAssetReviewToken &v) {
    return {{"schema", "lmti.project.desired-asset.review.v1"}, {"operationId", s(v.operation_id)},
        {"scope", scope_json(v.scope)}, {"originalTargetDigest", s(v.original_target_digest)},
        {"snapshot", QJsonObject{{"schemaVersion", v.snapshot.schema_version}, {"projectId", s(v.snapshot.project_id)},
            {"canonicalPath", v.snapshot.canonical_path}, {"storeUuid", s(v.snapshot.store_uuid)},
            {"revision", v.snapshot.revision}, {"contentDigest", s(v.snapshot.content_digest)},
            {"registryDigest", s(v.snapshot.registry_digest)}, {"ledgerDigest", s(v.snapshot.ledger_digest)}}},
        {"proposal", proposal_json(v.proposal)}, {"requestDigest", s(v.request_digest)}, {"diff", diff_json(v.diff)}};
}
QJsonObject upgrade_json(const ProjectReceiptUpgradeToken &v) {
    return {{"schema", "lmti.project.proposal-format.review.v1"}, {"operationId", s(v.operation_id)},
        {"scope", QJsonObject{{"projectId", s(v.scope.project_id)}, {"storeUuid", s(v.scope.store_uuid)},
            {"principalId", s(v.scope.principal_id)}, {"grantFingerprint", s(v.scope.grant_fingerprint)},
            {"allowUpgrade", v.scope.allow_upgrade}}},
        {"original", original_json(v.original)},
        {"backupParent", QJsonObject{{"path", v.backup_parent.path}, {"chain", chain_json(v.backup_parent.chain)}}},
        {"snapshot", QJsonObject{{"schemaVersion", v.snapshot.schema_version}, {"projectId", s(v.snapshot.project_id)},
            {"canonicalPath", v.snapshot.canonical_path}, {"storeUuid", s(v.snapshot.store_uuid)},
            {"revision", v.snapshot.revision}, {"contentDigest", s(v.snapshot.content_digest)},
            {"registryDigest", s(v.snapshot.registry_digest)}}}, {"reviewDigest", s(v.review_digest)}};
}
QString privacy_json(Privacy v) {
    switch (v) { case Privacy::Public: return "public"; case Privacy::Internal: return "internal"; }
    throw Refused{Code::OwnerUnavailable};
}
QJsonObject state_json(const DesiredAssetState &v) {
    return {{"projectId", s(v.project_id)}, {"storeUuid", s(v.store_uuid)}, {"revision", v.revision},
        {"assetId", s(v.asset_id)}, {"siteId", s(v.site_id)}, {"environmentId", s(v.environment_id)},
        {"effectivePrivacy", privacy_json(v.effective_privacy)}, {"ancestryFingerprint", s(v.ancestry_fingerprint)},
        {"enabled", v.values.enabled}, {"pollMs", v.values.poll_ms}};
}
QJsonObject receipt_json(const DesiredAssetReceipt &v) {
    return {{"schema", "lmti.project.desired-asset.receipt.v1"}, {"originStoreUuid", s(v.origin_store_uuid)},
        {"operationId", s(v.operation_id)}, {"requestDigest", s(v.request_digest)}, {"handoffDigest", s(v.handoff_digest)},
        {"projectId", s(v.project_id)}, {"principalId", s(v.principal_id)}, {"grantFingerprint", s(v.grant_fingerprint)},
        {"siteId", s(v.site_id)}, {"environmentId", s(v.environment_id)}, {"allowInternal", v.allow_internal},
        {"assetId", s(v.asset_id)}, {"effectivePrivacy", privacy_json(v.effective_privacy)},
        {"baseRevision", v.base_revision}, {"committedRevision", v.committed_revision},
        {"expectedEnabled", v.expected.enabled}, {"expectedPollMs", v.expected.poll_ms},
        {"desiredEnabled", v.desired.enabled}, {"desiredPollMs", v.desired.poll_ms},
        {"originalTargetDigest", s(v.original_target_digest)}, {"beforeContentDigest", s(v.before_content_digest)},
        {"afterContentDigest", s(v.after_content_digest)}, {"registryDigest", s(v.registry_digest)},
        {"targetAncestryDigest", s(v.target_ancestry_digest)}, {"receiptDigest", s(v.receipt_digest)}};
}
QJsonObject format_json(const ProjectReceiptFormat &v) {
    return {{"singleton", v.singleton}, {"upgradeOperationId", s(v.upgrade_operation_id)}, {"storeUuid", s(v.store_uuid)},
        {"fromSchema", v.from_schema}, {"sourceRevision", v.source_revision},
        {"sourceContentDigest", s(v.source_content_digest)}, {"sourceRegistryDigest", s(v.source_registry_digest)},
        {"backupSha256", s(v.backup_sha256)}, {"formatDigest", s(v.format_digest)}};
}
QByteArray frame(const QJsonObject &v) { return QJsonDocument(v).toJson(QJsonDocument::Compact) + '\n'; }
QJsonObject request() {
#ifdef Q_OS_WIN
    const auto descriptor = _fileno(stdin);
    need(descriptor >= 0 && _setmode(descriptor, _O_BINARY) != -1, Code::OwnerUnavailable);
#endif
    QByteArray bytes(input_cap + 1, Qt::Uninitialized);
    const auto count = std::fread(bytes.data(), 1, static_cast<std::size_t>(bytes.size()), stdin);
    need(std::ferror(stdin) == 0, Code::OwnerUnavailable);
    need(count <= static_cast<std::size_t>(input_cap), Code::BudgetExceeded);
    need(std::feof(stdin) != 0, Code::OwnerUnavailable);
    bytes.resize(static_cast<qsizetype>(count));
    try { return detail::strict_json_object(bytes, input_cap); }
    catch (const Error &) { throw Refused{Code::InvalidInput}; }
}
struct Mode { bool format, write; };
struct Launch {
    QString db, backup_parent;
    DesiredAssetScope desired;
    ProjectFormatMaintenanceScope maintenance;
};
Launch launch(const QStringList &a, Mode mode) {
    need(a.size() == (mode.format ? 8 : 10));
    Launch result; result.db = path(a[2]);
    const auto project = id(a[3]), store = uuid(a[4]), actor = principal(a[5]), grant = hex(a[6]);
    if (mode.format) {
        result.backup_parent = path(a[7]);
        result.maintenance = {project, store, actor, grant, true};
    } else {
        need(a[9] == "local" || a[9] == "external");
        result.desired = {project, store, actor, grant, id(a[7]), id(a[8]), a[9] == "local", true};
    }
    return result;
}
QJsonValue action_of(const QJsonObject &v, Mode m) {
    const auto action = v.value("action");
    if (!action.isString()) return QJsonValue(QJsonValue::Null);
    const auto s = action.toString();
    const bool known = m.format ? (m.write ? s == "upgrade" : s == "preview-upgrade" || s == "inspect-upgrade")
                               : (m.write ? s == "commit" : s == "inspect" || s == "preview" || s == "receipt");
    return known ? action : QJsonValue(QJsonValue::Null);
}
QJsonObject read_frame(Mode m, const QJsonValue &action, const QJsonValue &details, std::optional<Code> error) {
    return {{"ok", !error}, {"schema", m.format ? "lmti.project.proposal-format.owner.v1" : "lmti.project.desired-asset.owner.v1"},
        {"action", action}, {"details", details},
        {"error", error ? QJsonValue(QJsonObject{{"code", name(*error)}}) : QJsonValue(QJsonValue::Null)}};
}
QJsonObject write_frame(Mode m, const QJsonValue &action, const char *outcome,
                        const QJsonValue &operation, const QJsonValue &details, std::optional<Code> error) {
    return {{"ok", !error}, {"schema", m.format ? "lmti.project.proposal-format.write.v1" : "lmti.project.desired-asset.write.v1"},
        {"action", action}, {"outcome", outcome}, {"operationId", operation}, {"details", details},
        {"error", error ? QJsonValue(QJsonObject{{"code", name(*error)}}) : QJsonValue(QJsonValue::Null)}};
}
enum class Phase { BeforeOwner, EnteredOwner, Confirmed };
struct Frames {
    std::array<QByteArray, codes.size()> refused, unknown;
    QByteArray confirmed;
    Frames(Mode m, const QJsonValue &action, const QJsonValue &operation = QJsonValue(QJsonValue::Null)) {
        for (std::size_t i = 0; i < codes.size(); ++i) {
            refused[i] = frame(m.write ? write_frame(m, action, "refused", operation, QJsonValue::Null, codes[i])
                                      : read_frame(m, action, QJsonValue::Null, codes[i]));
            if (m.write) unknown[i] = frame(write_frame(m, action, "unknown", operation, QJsonValue::Null, codes[i]));
        }
        if (m.write) confirmed = frame(write_frame(m, action, "confirmed", operation, QJsonValue::Null, std::nullopt));
    }
    const QByteArray &fallback(Phase phase, Code error) const noexcept {
        return phase == Phase::Confirmed ? confirmed : phase == Phase::EnteredOwner ?
            unknown[index(error)] : refused[index(error)];
    }
};
QJsonObject read(const Launch &f, Mode m, const QString &action, const QJsonObject &v) {
    if (m.format) {
        if (action == "preview-upgrade") {
            fields(v, {"action", "original"});
            const auto o = original(object(v, "original"), 2);
            const auto token = preview_project_receipt_upgrade(f.db, f.backup_parent, f.maintenance, o);
            const auto expected = upgrade_json(token);
            need(frame({{"action", "upgrade"}, {"expected", expected}}).size() <= input_cap, Code::BudgetExceeded);
            return {{"expected", expected}};
        }
        fields(v, {"action", "expected"});
        const auto result = inspect_project_receipt_upgrade(f.db, f.backup_parent, f.maintenance,
                                                            upgrade(object(v, "expected")));
        QString state;
        switch (result.state) {
        case ProjectReceiptUpgradeCondition::Original: state = "original"; break;
        case ProjectReceiptUpgradeCondition::Upgraded: state = "upgraded"; break;
        case ProjectReceiptUpgradeCondition::Unresolved: state = "unresolved"; break;
        }
        need(!state.isEmpty(), Code::OwnerUnavailable);
        return {{"state", state}, {"backupVerified", result.backup_verified},
            {"format", result.format ? QJsonValue(format_json(*result.format)) : QJsonValue(QJsonValue::Null)}};
    }
    if (action == "inspect") {
        fields(v, {"action", "original", "assetId"});
        return {{"state", state_json(inspect_desired_asset(f.db, f.desired,
            original(object(v, "original"), 3), id(v, "assetId")))}};
    }
    if (action == "receipt") {
        fields(v, {"action", "original", "operationId", "requestDigest"});
        const auto receipt = inspect_desired_asset_receipt(f.db, f.desired, original(object(v, "original"), 3),
                                                          uuid(v, "operationId"), hex(v, "requestDigest"));
        return {{"receipt", receipt ? QJsonValue(receipt_json(*receipt)) : QJsonValue(QJsonValue::Null)}, {"historical", true}};
    }
    fields(v, {"action", "original", "proposal"});
    const auto o = original(object(v, "original"), 3);
    const auto result = preview_desired_asset(f.db, f.desired, o, proposal(object(v, "proposal")));
    const auto expected = review_json(export_desired_asset_review(result));
    need(frame({{"action", "commit"}, {"original", original_json(o)}, {"expected", expected}}).size() <= input_cap,
         Code::BudgetExceeded);
    need(result.reviewed_state().has_value(), Code::OwnerUnavailable);
    return {{"state", state_json(*result.reviewed_state())}, {"expected", expected}, {"diff", diff_json(result.diff())}};
}
} // namespace

int project_desired_asset_main(const QStringList &arguments) {
    const auto command = arguments.size() > 1 ? arguments[1] : QString();
    const Mode mode{command.startsWith("proposal-format-"), command.endsWith("-write")};
#ifdef Q_OS_WIN
    const auto descriptor = _fileno(stdout);
    if (descriptor < 0 || _setmode(descriptor, _O_BINARY) == -1) return 1;
#endif
    QFile output; if (!output.open(stdout, QIODevice::WriteOnly)) return 1;
    std::optional<Frames> base, recognized, authorized;
    try { base.emplace(mode, QJsonValue::Null); } catch (...) { return 1; }
    const Frames *fallback = &*base;
    Phase phase = Phase::BeforeOwner; Code error = Code::OwnerUnavailable;
    QByteArray bytes; bool success = false;
    try {
        const auto value = request(); const auto action = action_of(value, mode);
        need(!action.isNull()); recognized.emplace(mode, action); fallback = &*recognized;
        const auto fixed = launch(arguments, mode);
        if (!mode.write) {
            bytes = frame(read_frame(mode, action, read(fixed, mode, action.toString(), value), std::nullopt));
            need(bytes.size() <= output_cap, Code::BudgetExceeded); success = true;
        } else if (!mode.format) {
            fields(value, {"action", "original", "expected"});
            const auto o = original(object(value, "original"), 3);
            const auto token = review(object(value, "expected"));
            const auto restored = restore_desired_asset_review(fixed.db, fixed.desired, o, token);
            // Native restore authorized the exact original scope. Allocate all
            // fallbacks before entering the write owner, including the UUID.
            authorized.emplace(mode, action, s(token.operation_id)); fallback = &*authorized;
            phase = Phase::EnteredOwner;
            const auto result = commit_desired_asset(fixed.db, fixed.desired, o, restored);
            if (result.state == DesiredAssetCommitState::Confirmed) {
                phase = Phase::Confirmed; // No later allocation can demote this.
                success = true;
                need(result.operation_id == token.operation_id && result.receipt.has_value(), Code::OwnerUnavailable);
                bytes = frame(write_frame(mode, action, "confirmed", s(token.operation_id),
                    QJsonObject{{"receipt", receipt_json(*result.receipt)}, {"historical", true}, {"replayed", result.replayed}},
                    std::nullopt));
                need(bytes.size() <= output_cap, Code::BudgetExceeded);
            } else error = Code::RecoveryRequired;
        } else {
            fields(value, {"action", "expected"});
            const auto token = upgrade(object(value, "expected"));
            // This is prepared before DML but is not selected until the owner
            // returns an authorized result. Refusals cannot echo an untrusted ID.
            authorized.emplace(mode, action, s(token.operation_id));
            phase = Phase::EnteredOwner;
            const auto result = commit_project_receipt_upgrade(fixed.db, fixed.backup_parent, fixed.maintenance, token);
            if (result.state == ProjectReceiptUpgradeState::Confirmed) {
                phase = Phase::Confirmed; success = true;
                if (result.operation_id == token.operation_id) fallback = &*authorized;
                need(result.operation_id == token.operation_id && result.format.has_value(), Code::OwnerUnavailable);
                bytes = frame(write_frame(mode, action, "confirmed", s(token.operation_id),
                    QJsonObject{{"format", format_json(*result.format)}, {"backupVerified", true}}, std::nullopt));
                need(bytes.size() <= output_cap, Code::BudgetExceeded);
            } else {
                if (result.operation_id == token.operation_id) fallback = &*authorized;
                error = Code::RecoveryRequired;
            }
        }
    } catch (const Refused &e) { bytes.clear(); error = e.code; }
      catch (const DesiredAssetError &e) {
        bytes.clear(); error = e.code;
        // The owner only throws a typed refusal for proven pre-COMMIT failure.
        if (phase != Phase::Confirmed) phase = Phase::BeforeOwner;
    } catch (...) { bytes.clear(); error = Code::OwnerUnavailable; }
    const auto &response = bytes.isEmpty() ? fallback->fallback(phase, error) : bytes;
    if (output.write(response) != response.size() || !output.flush()) return 1;
    return phase == Phase::Confirmed || success ? 0 : phase == Phase::EnteredOwner ? 3 : 1;
}
