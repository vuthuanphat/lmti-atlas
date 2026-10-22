#include "project_operations.hpp"
#include "project_operation_json.hpp"
#include "lmti/project_copy.hpp"
#include "lmti/project_library.hpp"
#include "../common/local_owner_path.hpp"
#include "../common/strict_json.hpp"
#include <QCryptographicHash>
#include <QFile>
#include <QJsonArray>
#include <QJsonDocument>
#include <QRegularExpression>
#include <QUuid>
#include <algorithm>
#include <cmath>
#include <cstdio>
#ifdef Q_OS_WIN
#include <fcntl.h>
#include <io.h>
#endif

namespace {
namespace operation_json = lmti::cli::project_operation_json;
constexpr qsizetype request_cap = 32 * 1024;
constexpr qsizetype response_cap = 512 * 1024;
struct Refused { QString code; };
void need(bool value, const char *code = "INVALID_INPUT") {
    if (!value) throw Refused{QString::fromLatin1(code)};
}
QByteArray read_request() {
#ifdef Q_OS_WIN
    // Preserve every input byte, including Ctrl-Z and bytes after it.
    const auto descriptor = _fileno(stdin);
    need(descriptor >= 0);
    need(_setmode(descriptor, _O_BINARY) != -1);
#endif
    // CRT distinguishes a closed input pipe from a read error. Read one
    // byte beyond the limit so a valid JSON prefix cannot hide extra input.
    QByteArray bytes(request_cap + 1, Qt::Uninitialized);
    const auto count = std::fread(bytes.data(), 1, static_cast<size_t>(bytes.size()), stdin);
    need(std::ferror(stdin) == 0);
    need(count <= static_cast<size_t>(request_cap));
    need(std::feof(stdin) != 0);
    bytes.resize(static_cast<qsizetype>(count));
    return bytes;
}
void fields(const QJsonObject &object, const QSet<QString> &keys) {
    need(object.size() == keys.size());
    for (auto i = object.begin(); i != object.end(); ++i) need(keys.contains(i.key()));
}
QString text(const QJsonObject &object, const char *key, qsizetype cap) {
    const auto value = object.value(key);
    need(value.isString());
    const auto result = value.toString();
    need(result.toUtf8().size() <= cap);
    for (const auto c : result) need(c.unicode() >= 32 && c.unicode() != 127);
    return result;
}
QString project_id(const QJsonObject &object) {
    const auto result = text(object, "projectId", 64);
    try { lmti::validate_id(result.toStdString()); }
    catch (const std::exception &) { throw Refused{"INVALID_INPUT"}; }
    return result;
}
QString uuid_field(const QJsonObject &object, const char *key) {
    const auto result = text(object, key, 36);
    const QUuid parsed(result);
    need(!parsed.isNull() && parsed.toString(QUuid::WithoutBraces) == result);
    return result;
}
int integer(const QJsonObject &object, const char *key, int minimum, int maximum) {
    const auto value = object.value(key);
    need(value.isDouble());
    const auto number = value.toDouble();
    need(std::isfinite(number) && std::floor(number) == number &&
         number >= minimum && number <= maximum);
    return static_cast<int>(number);
}
struct Page {
    int offset = 0, limit = 0;
    QString snapshot;
};
Page page_request(const QJsonObject &object) {
    Page result{integer(object, "offset", 0, 1000), integer(object, "limit", 1, 50), {}};
    if (result.offset == 0) need(object.value("snapshot").isNull());
    else {
        result.snapshot = text(object, "snapshot", 64);
        need(QRegularExpression("^[0-9a-f]{64}$").match(result.snapshot).hasMatch());
    }
    return result;
}
QString copy_code(lmti::ProjectCopyCode code) {
    switch (code) {
    case lmti::ProjectCopyCode::None: return "NONE";
    case lmti::ProjectCopyCode::InvalidInput: return "INVALID_INPUT";
    case lmti::ProjectCopyCode::SourceChanged: return "SOURCE_CHANGED";
    case lmti::ProjectCopyCode::UnsupportedSchema: return "UNSUPPORTED_SCHEMA";
    case lmti::ProjectCopyCode::BudgetExceeded: return "BUDGET_EXCEEDED";
    case lmti::ProjectCopyCode::OwnerUnavailable: return "OWNER_UNAVAILABLE";
    case lmti::ProjectCopyCode::EvidenceInvalid: return "EVIDENCE_INVALID";
    case lmti::ProjectCopyCode::TargetChanged: return "TARGET_CHANGED";
    }
    return "OWNER_UNAVAILABLE";
}
QString library_code(lmti::LibraryCode code) {
    switch (code) {
    case lmti::LibraryCode::None: return "NONE";
    case lmti::LibraryCode::InvalidInput: return "INVALID_INPUT";
    case lmti::LibraryCode::UnsupportedFormat: return "UNSUPPORTED_FORMAT";
    case lmti::LibraryCode::Conflict: return "CONFIG_CHANGED";
    case lmti::LibraryCode::BudgetExceeded: return "BUDGET_EXCEEDED";
    case lmti::LibraryCode::OwnerUnavailable: return "OWNER_UNAVAILABLE";
    case lmti::LibraryCode::RecoveryRequired: return "RECOVERY_REQUIRED";
    }
    return "OWNER_UNAVAILABLE";
}
QString mode_name(lmti::ProjectCopyMode mode) {
    switch (mode) {
    case lmti::ProjectCopyMode::MigrateV1: return "migrate_v1";
    case lmti::ProjectCopyMode::CloneV2: return "clone_v2";
    }
    throw Refused{"OWNER_UNAVAILABLE"};
}
QString candidate_state(lmti::ProjectCopyCandidateState state) {
    switch (state) {
    case lmti::ProjectCopyCandidateState::Uninspected: return "uninspected";
    case lmti::ProjectCopyCandidateState::Incomplete: return "incomplete";
    case lmti::ProjectCopyCandidateState::Invalid: return "invalid";
    case lmti::ProjectCopyCandidateState::Unavailable: return "unavailable";
    }
    throw Refused{"OWNER_UNAVAILABLE"};
}
QString activation_state(lmti::LibraryActivationState state) {
    switch (state) {
    case lmti::LibraryActivationState::Prepared: return "prepared";
    case lmti::LibraryActivationState::Activated: return "activated";
    case lmti::LibraryActivationState::Abandoned: return "abandoned";
    }
    throw Refused{"OWNER_UNAVAILABLE"};
}
QString activation_condition(lmti::LibraryActivationCondition condition) {
    switch (condition) {
    case lmti::LibraryActivationCondition::PreparedCurrent: return "prepared_current";
    case lmti::LibraryActivationCondition::PreparedStale: return "prepared_stale";
    case lmti::LibraryActivationCondition::ActivatedCurrent: return "activated_current";
    case lmti::LibraryActivationCondition::ActivatedSuperseded: return "activated_superseded";
    case lmti::LibraryActivationCondition::Abandoned: return "abandoned";
    case lmti::LibraryActivationCondition::Inconsistent: return "inconsistent";
    case lmti::LibraryActivationCondition::Unavailable: return "unavailable";
    }
    throw Refused{"OWNER_UNAVAILABLE"};
}
QJsonValue optional_metadata(const QString &value) {
    return value.isEmpty() ? QJsonValue(QJsonValue::Null) : QJsonValue(value);
}
QJsonObject library_json(const lmti::LibraryToken &token) {
    return {{"schema", token.schema}, {"canonicalPath", token.canonical_path},
        {"uuid", token.schema == 1 ? QJsonValue(QJsonValue::Null) : QJsonValue(token.library_uuid)},
        {"generation", token.schema == 1 ? QJsonValue(QJsonValue::Null) : QJsonValue(token.generation)},
        {"digest", token.digest}};
}
QJsonObject token_json(const lmti::ProjectCopyToken &token) {
    return {{"schemaVersion", token.schema}, {"projectId", token.project_id},
        {"canonicalPath", token.canonical_path}, {"storeUuid", token.store_uuid},
        {"revision", token.revision}, {"contentDigest", token.content_digest},
        {"registryDigest", token.registry_digest}};
}
QJsonObject preview_json(const lmti::ProjectCopyPreview &preview) {
    return {{"mode", mode_name(preview.mode)}, {"seedsInternalSites", preview.seeds_internal_sites},
        {"source", token_json(preview.source)}, {"targetRevision", preview.target_revision},
        {"targetContentDigest", preview.target_content_digest},
        {"targetRegistryDigest", preview.target_registry_digest}};
}
QJsonObject intent_json(const lmti::ProjectCopyIntentMetadata &intent) {
    return {{"mode", mode_name(intent.mode)}, {"seedsInternalSites", intent.seeds_internal_sites},
        {"source", token_json(intent.source)}, {"target", token_json(intent.target)}};
}
QJsonObject status_json(const lmti::ProjectCopyStatus &status) {
    const bool metadata = (status.source.schema == 1 || status.source.schema == 2) &&
                          status.target.schema == 2;
    const auto null = QJsonValue(QJsonValue::Null);
    return {{"operationId", status.operation_id},
        {"state", status.state == lmti::ProjectCopyState::Prepared ? "prepared" : "recovery_required"},
        {"code", copy_code(status.code)},
        {"mode", metadata ? QJsonValue(mode_name(status.mode)) : null},
        {"seedsInternalSites", metadata ? QJsonValue(status.seeds_internal_sites) : null},
        {"verifiedReceipt", status.verified_receipt},
        {"source", metadata ? QJsonValue(token_json(status.source)) : null},
        {"target", metadata ? QJsonValue(token_json(status.target)) : null}};
}
QString digest(const QJsonObject &object) {
    return QString::fromLatin1(QCryptographicHash::hash(
        QJsonDocument(object).toJson(QJsonDocument::Compact), QCryptographicHash::Sha256).toHex());
}
void paginate(QJsonObject &result, const QJsonArray &items, const Page &page,
              const QString &snapshot) {
    if (page.offset > 0) need(page.snapshot == snapshot, "CONFIG_CHANGED");
    need(page.offset <= items.size());
    const auto stop = std::min<qsizetype>(items.size(), page.offset + page.limit);
    QJsonArray selected;
    for (auto i = static_cast<qsizetype>(page.offset); i < stop; ++i) selected.append(items.at(i));
    result["snapshot"] = snapshot;
    result["offset"] = page.offset;
    result["nextOffset"] = stop < items.size() ? QJsonValue(static_cast<qint64>(stop)) : QJsonValue(QJsonValue::Null);
    result["items"] = selected;
}
QString lexical_path(const QString &path) {
    try { return lmti::detail::local_owner_path_lexical(path); }
    catch (const std::exception &) { throw Refused{"INVALID_INPUT"}; }
}
void existing_file(const QString &path) {
    try { (void)lmti::detail::local_owner_path(path); }
    catch (const std::exception &) { throw Refused{"OWNER_UNAVAILABLE"}; }
}
lmti::LibraryInspection library_view(const QString &path) {
    existing_file(path);
    return lmti::inspect_project_library(path);
}
lmti::LibraryEntry selected_entry(const lmti::LibraryInspection &view, const QString &id) {
    const auto found = std::find_if(view.entries.begin(), view.entries.end(),
        [&](const auto &entry) { return entry.id == id; });
    need(found != view.entries.end(), "SCOPE_DENIED");
    return *found;
}
void recheck_library(const QString &path, const lmti::LibraryInspection &before,
                     const lmti::LibraryEntry *selected = nullptr) {
    const auto after = library_view(path);
    need(after.token == before.token, "CONFIG_CHANGED");
    if (selected) {
        const auto entry = std::find_if(after.entries.begin(), after.entries.end(),
            [&](const auto &row) { return row.id == selected->id; });
        need(entry != after.entries.end() && entry->path == selected->path &&
             entry->folder == selected->folder, "CONFIG_CHANGED");
    }
}
QJsonObject success(const QString &action) {
    return {{"ok", true}, {"schema", "lmti.project.operations.v1"}, {"action", action}};
}
QJsonObject execute(const QStringList &arguments, const QByteArray &bytes) {
    need(arguments.size() == 6 && arguments[1] == "--project-operations" &&
         arguments[2] == "--library" && arguments[4] == "--copy-parent");
    // Validate both raw launcher paths without touching either store. Effects
    // below validate only the filesystem locations they actually use.
    const auto library = lexical_path(arguments[3]);
    const auto parent = lexical_path(arguments[5]);
    QJsonObject request;
    try { request = lmti::detail::strict_json_object(bytes, request_cap); }
    catch (const std::exception &) { throw Refused{"INVALID_INPUT"}; }
    const auto action = text(request, "action", 32);
    QString id, operation, library_uuid;
    int from_schema = 0;
    lmti::ProjectCopyMode mode = lmti::ProjectCopyMode::MigrateV1;
    Page page;
    // All action fields and selectors are validated before the first filesystem
    // check. Unknown commands cannot probe a supplied path through a fallback.
    if (action == "inspect") {
        fields(request, {"action", "projectId"}); id = project_id(request);
    } else if (action == "copy-preview") {
        fields(request, {"action", "projectId", "mode"}); id = project_id(request);
        const auto requested = text(request, "mode", 16);
        need(requested == "migrate_v1" || requested == "clone_v2");
        mode = requested == "migrate_v1" ? lmti::ProjectCopyMode::MigrateV1 : lmti::ProjectCopyMode::CloneV2;
    } else if (action == "copy-discover") {
        fields(request, {"action", "offset", "limit", "snapshot"}); page = page_request(request);
    } else if (action == "copy-inspect") {
        fields(request, {"action", "operationId"}); operation = uuid_field(request, "operationId");
    } else if (action == "activation-history") {
        fields(request, {"action", "projectId", "offset", "limit", "snapshot"});
        id = project_id(request); page = page_request(request);
    } else if (action == "library-format-preview") {
        fields(request, {"action", "fromSchema"}); from_schema = integer(request, "fromSchema", 1, 2);
    } else if (action == "library-format-status") {
        fields(request, {"action"});
    } else if (action == "activation-candidate") {
        fields(request, {"action", "projectId", "copyOperationId"});
        id = project_id(request); operation = uuid_field(request, "copyOperationId");
    } else if (action == "activation-inspect") {
        fields(request, {"action", "libraryUuid", "operationId"});
        library_uuid = uuid_field(request, "libraryUuid"); operation = uuid_field(request, "operationId");
    } else throw Refused{"INVALID_INPUT"};
    auto result = success(action);
    if (action == "copy-discover") {
        auto found = lmti::discover_project_copies(parent);
        std::sort(found.candidates.begin(), found.candidates.end(), [](const auto &a, const auto &b) {
            return a.operation_id < b.operation_id;
        });
        QJsonArray items;
        for (const auto &candidate : found.candidates) {
            items.append(QJsonObject{{"operationId", candidate.operation_id},
                {"state", candidate_state(candidate.state)},
                {"intent", candidate.intent ? QJsonValue(intent_json(*candidate.intent)) : QJsonValue(QJsonValue::Null)}});
        }
        const QJsonObject snapshot{{"complete", found.complete}, {"code", copy_code(found.code)},
            {"examinedEntries", static_cast<qint64>(found.examined_entries)},
            {"unattributedEntries", static_cast<qint64>(found.unattributed_entries)}, {"items", items}};
        for (auto i = snapshot.begin(); i != snapshot.end(); ++i)
            if (i.key() != "items") result[i.key()] = i.value();
        paginate(result, items, page, digest(snapshot));
        return result;
    }
    if (action == "copy-inspect") {
        result["status"] = status_json(lmti::inspect_project_copy_operation(parent, operation));
        return result;
    }
    if (action == "library-format-preview") {
        // Format previews read only the library. The v2 owner captures its
        // authority token and full nullable/cosmetic digest in one transaction.
        existing_file(library);
        result["fromSchema"] = from_schema;
        result["toSchema"] = from_schema + 1;
        if (from_schema == 1) {
            const auto current = lmti::inspect_project_library(library);
            need(current.token.schema == 1, "UNSUPPORTED_FORMAT");
            result["expected"] = operation_json::library_json(current.token);
        } else {
            const auto preview = lmti::inspect_library_activation_upgrade(library);
            need(preview.source.schema == 2, "UNSUPPORTED_FORMAT");
            result["expected"] = operation_json::format_preview_json(preview);
        }
        return result;
    }
    if (action == "activation-candidate") {
        const auto preview = lmti::inspect_library_activation_candidate(library, id, parent, operation);
        result["preview"] = operation_json::activation_preview_json(preview);
        return result;
    }
    if (action == "activation-inspect") {
        // The owner distinguishes advisory Prepared readiness from terminal
        // history. Do not pre-open selected projects or the copy directory here.
        const auto inspected = lmti::inspect_library_activation(library, parent, library_uuid, operation);
        result["libraryIdentity"] = operation_json::library_json(inspected.library);
        result["receipt"] = operation_json::activation_receipt_json(inspected.receipt);
        result["condition"] = activation_condition(inspected.condition);
        result["code"] = operation_json::library_code(inspected.code);
        return result;
    }
    const auto before = library_view(library);
    if (action == "library-format-status") {
        // All durable upgrade metadata comes from the same library snapshot;
        // neither project locators nor backup/copy paths are opened for status.
        result["libraryIdentity"] = operation_json::library_json(before.token);
        result["upgradeOperationId"] = optional_metadata(before.upgrade_operation_id);
        result["legacyDigest"] = optional_metadata(before.legacy_digest);
        result["activationFormatOperationId"] = optional_metadata(before.activation_format_operation_id);
        result["activationFormatBackupDigest"] = optional_metadata(before.activation_format_backup_digest);
        return result;
    }
    if (action == "activation-history") {
        auto history = lmti::list_library_activations(library);
        std::sort(history.begin(), history.end(), [](const auto &a, const auto &b) {
            return a.operation_id < b.operation_id;
        });
        QJsonArray items;
        for (const auto &entry : history) if (entry.project_id == id)
            items.append(QJsonObject{{"operationId", entry.operation_id}, {"projectId", entry.project_id},
                {"copyOperationId", entry.copy_operation_id}, {"state", activation_state(entry.state)},
                {"revision", entry.revision}});
        recheck_library(library, before);
        const QJsonObject snapshot{{"libraryIdentity", library_json(before.token)}, {"projectId", id}, {"items", items}};
        result["libraryIdentity"] = snapshot.value("libraryIdentity"); result["projectId"] = id;
        paginate(result, items, page, digest(snapshot));
        return result;
    }
    const auto entry = selected_entry(before, id);
    existing_file(entry.path);
    if (action == "inspect") {
        const auto document = lmti::load_project(entry.path);
        need(document.project.id == id.toStdString(), "SCOPE_DENIED");
        const auto &lineage = document.storage_lineage;
        result["project"] = QJsonObject{{"projectId", id}, {"name", QString::fromStdString(document.project.label)},
            {"database", entry.path}, {"root", entry.folder},
            {"schemaVersion", lineage ? lineage->schema_version : 1},
            {"storeUuid", lineage ? QString::fromStdString(lineage->store_uuid) : QString{}},
            {"revision", document.topology.revision}};
    } else {
        const auto preview = lmti::inspect_project_copy(entry.path, mode);
        need(preview.source.project_id == id, "SCOPE_DENIED");
        result["projectId"] = id; result["preview"] = preview_json(preview);
    }
    recheck_library(library, before, &entry);
    result["libraryIdentity"] = library_json(before.token);
    return result;
}
} // namespace

int project_operations_main(const QStringList &arguments) {
#ifdef Q_OS_WIN
    // Keep the serialized byte count exact, including its single LF terminator.
    const auto output_descriptor = _fileno(stdout);
    if (output_descriptor < 0 || _setmode(output_descriptor, _O_BINARY) == -1) return 1;
#endif
    QFile output;
    if (!output.open(stdout, QIODevice::WriteOnly)) return 1;
    QJsonObject result;
    try {
        result = execute(arguments, read_request());
    } catch (const Refused &error) {
        result = {{"ok", false}, {"code", error.code}};
    } catch (const lmti::ProjectCopyError &error) {
        result = {{"ok", false}, {"code", copy_code(error.code)}};
    } catch (const lmti::LibraryError &error) {
        result = {{"ok", false}, {"code", library_code(error.code)}};
    } catch (const std::exception &) {
        result = {{"ok", false}, {"code", "OWNER_UNAVAILABLE"}};
    }
    auto bytes = QJsonDocument(result).toJson(QJsonDocument::Compact) + '\n';
    if (bytes.size() > response_cap)
        bytes = QByteArrayLiteral("{\"ok\":false,\"code\":\"BUDGET_EXCEEDED\"}\n");
    return output.write(bytes) == bytes.size() && output.flush() ? 0 : 1;
}
