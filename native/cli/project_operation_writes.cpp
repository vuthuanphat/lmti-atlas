#include "project_operation_writes.hpp"
#include "project_operation_json.hpp"
#include "../common/local_owner_path.hpp"
#include "../common/strict_json.hpp"
#include <QFile>
#include <QJsonDocument>
#include <QRegularExpression>
#include <QSet>
#include <QUuid>
#include <algorithm>
#include <array>
#include <cmath>
#include <cstdio>
#include <optional>
#ifdef Q_OS_WIN
#include <fcntl.h>
#include <io.h>
#endif
#ifdef LMTI_PROJECT_OPERATION_WRITE_TESTING
#include "../storage/project_copy_p.hpp"
#endif

namespace {
namespace json = lmti::cli::project_operation_json;
constexpr qsizetype request_cap = 32 * 1024, response_cap = 512 * 1024;
constexpr qint64 safe_integer = 9007199254740991LL;
enum class Code { None, InvalidInput, ScopeDenied, UnsupportedSchema, UnsupportedFormat,
    SourceChanged, ConfigChanged, BudgetExceeded, OwnerUnavailable, RecoveryRequired,
    EvidenceInvalid, TargetChanged, Count };
constexpr std::array code_names{"NONE", "INVALID_INPUT", "SCOPE_DENIED", "UNSUPPORTED_SCHEMA",
    "UNSUPPORTED_FORMAT", "SOURCE_CHANGED", "CONFIG_CHANGED", "BUDGET_EXCEEDED",
    "OWNER_UNAVAILABLE", "RECOVERY_REQUIRED", "EVIDENCE_INVALID", "TARGET_CHANGED"};
enum class Action { Copy, UpgradeV1, UpgradeV2, Prepare, Activate, Abandon };
constexpr std::array action_names{"copy-prepare", "library-upgrade-v1", "library-upgrade-v2",
    "activation-prepare", "activation-activate", "activation-abandon"};
enum class Phase { BeforeOwner, EnteredOwner, Confirmed };
struct Refused { Code code; };
void need(bool value, Code code = Code::InvalidInput) { if (!value) throw Refused{code}; }
Code code(lmti::LibraryCode value) noexcept {
    switch (value) {
    case lmti::LibraryCode::None: return Code::None;
    case lmti::LibraryCode::InvalidInput: return Code::InvalidInput;
    case lmti::LibraryCode::UnsupportedFormat: return Code::UnsupportedFormat;
    case lmti::LibraryCode::Conflict: return Code::ConfigChanged;
    case lmti::LibraryCode::BudgetExceeded: return Code::BudgetExceeded;
    case lmti::LibraryCode::OwnerUnavailable: return Code::OwnerUnavailable;
    case lmti::LibraryCode::RecoveryRequired: return Code::RecoveryRequired;
    }
    return Code::OwnerUnavailable;
}
Code code(lmti::ProjectCopyCode value) noexcept {
    switch (value) {
    case lmti::ProjectCopyCode::None: return Code::None;
    case lmti::ProjectCopyCode::InvalidInput: return Code::InvalidInput;
    case lmti::ProjectCopyCode::SourceChanged: return Code::SourceChanged;
    case lmti::ProjectCopyCode::UnsupportedSchema: return Code::UnsupportedSchema;
    case lmti::ProjectCopyCode::BudgetExceeded: return Code::BudgetExceeded;
    case lmti::ProjectCopyCode::OwnerUnavailable: return Code::OwnerUnavailable;
    case lmti::ProjectCopyCode::EvidenceInvalid: return Code::EvidenceInvalid;
    case lmti::ProjectCopyCode::TargetChanged: return Code::TargetChanged;
    }
    return Code::OwnerUnavailable;
}
void fields(const QJsonObject &object, const QSet<QString> &expected) {
    need(object.size() == expected.size());
    for (auto i = object.begin(); i != object.end(); ++i) need(expected.contains(i.key()));
}
QJsonObject object(const QJsonObject &parent, const char *name) {
    need(parent.value(name).isObject()); return parent.value(name).toObject();
}
QString text(const QJsonObject &parent, const char *name, qsizetype cap) {
    need(parent.value(name).isString());
    const auto result = parent.value(name).toString();
    need(result.toUtf8().size() <= cap);
    for (const auto c : result) need(c.unicode() >= 32 && c.unicode() != 127);
    return result;
}
qint64 integer(const QJsonObject &parent, const char *name, qint64 minimum, qint64 maximum) {
    need(parent.value(name).isDouble());
    const auto value = parent.value(name).toDouble();
    need(std::isfinite(value) && std::floor(value) == value && value >= minimum && value <= maximum);
    return static_cast<qint64>(value);
}
bool boolean(const QJsonObject &parent, const char *name) {
    need(parent.value(name).isBool()); return parent.value(name).toBool();
}
QString id(const QJsonObject &parent, const char *name) {
    const auto value = text(parent, name, 64);
    try { lmti::validate_id(value.toStdString()); } catch (const std::exception &) { throw Refused{Code::InvalidInput}; }
    return value;
}
QString uuid(const QJsonObject &parent, const char *name) {
    const auto value = text(parent, name, 36); const QUuid parsed(value);
    need(!parsed.isNull() && parsed.toString(QUuid::WithoutBraces) == value); return value;
}
QString digest(const QJsonObject &parent, const char *name) {
    const auto value = text(parent, name, 64);
    need(QRegularExpression("^[0-9a-f]{64}$").match(value).hasMatch()); return value;
}
QString lexical(const QString &value) {
    try { return lmti::detail::local_owner_path_lexical(value); }
    catch (const std::exception &) { throw Refused{Code::InvalidInput}; }
}
QString key(const QString &value) {
    auto result = lexical(value);
#ifdef Q_OS_WIN
    result = result.toCaseFolded();
#endif
    return result;
}
QString identity_path(const QJsonObject &parent, const char *name) {
    // Owner path limits count QString code units; UTF-8 may expand them.
    const auto value = text(parent, name, 4096); need(key(value) == value); return value;
}
lmti::ProjectCopyMode mode(const QJsonObject &parent) {
    const auto value = text(parent, "mode", 16);
    need(value == "migrate_v1" || value == "clone_v2");
    return value == "migrate_v1" ? lmti::ProjectCopyMode::MigrateV1 : lmti::ProjectCopyMode::CloneV2;
}
lmti::LibraryToken library_token(const QJsonObject &value) {
    fields(value, {"schema", "canonicalPath", "uuid", "generation", "digest"});
    lmti::LibraryToken result;
    result.schema = static_cast<int>(integer(value, "schema", 1, 3));
    result.canonical_path = identity_path(value, "canonicalPath"); result.digest = digest(value, "digest");
    if (result.schema == 1) need(value.value("uuid").isNull() && value.value("generation").isNull());
    else { result.library_uuid = uuid(value, "uuid"); result.generation = integer(value, "generation", 1, safe_integer); }
    return result;
}
lmti::ProjectCopyToken copy_token(const QJsonObject &value) {
    fields(value, {"schemaVersion", "projectId", "canonicalPath", "storeUuid", "revision", "contentDigest", "registryDigest"});
    lmti::ProjectCopyToken result;
    result.schema = static_cast<int>(integer(value, "schemaVersion", 1, 2));
    result.project_id = id(value, "projectId"); result.canonical_path = identity_path(value, "canonicalPath");
    result.revision = integer(value, "revision", 1, safe_integer - 1);
    result.content_digest = digest(value, "contentDigest"); result.registry_digest = digest(value, "registryDigest");
    if (result.schema == 1) {
        need(text(value, "storeUuid", 36).isEmpty());
        // The native receipt column is NOT NULL. QString{} compares equal to
        // empty text but binds SQL NULL; preserve the reviewed JSON text value.
        result.store_uuid = QStringLiteral("");
    } else result.store_uuid = uuid(value, "storeUuid");
    return result;
}
lmti::ProjectCopyPreview copy_preview(const QJsonObject &value) {
    fields(value, {"mode", "seedsInternalSites", "source", "targetRevision", "targetContentDigest", "targetRegistryDigest"});
    lmti::ProjectCopyPreview result;
    result.mode = mode(value); result.seeds_internal_sites = boolean(value, "seedsInternalSites");
    result.source = copy_token(object(value, "source"));
    result.target_revision = integer(value, "targetRevision", 2, safe_integer - 1);
    result.target_content_digest = digest(value, "targetContentDigest");
    result.target_registry_digest = digest(value, "targetRegistryDigest");
    const bool migration = result.mode == lmti::ProjectCopyMode::MigrateV1;
    need(result.seeds_internal_sites == migration && result.source.schema == (migration ? 1 : 2) &&
         result.target_revision == result.source.revision + 1);
    return result;
}
lmti::LibraryFormatPreview format_preview(const QJsonObject &value) {
    fields(value, {"source", "fullSnapshotDigest"});
    lmti::LibraryFormatPreview result{library_token(object(value, "source")), digest(value, "fullSnapshotDigest")};
    need(result.source.schema == 2); return result;
}
lmti::LibraryActivationPreview activation_preview(const QJsonObject &value) {
    fields(value, {"library", "projectId", "copyParent", "copyOperationId", "mode", "seedsInternalSites", "source", "target"});
    lmti::LibraryActivationPreview result;
    result.library = library_token(object(value, "library")); need(result.library.schema == 3);
    result.project_id = id(value, "projectId"); result.copy_parent = identity_path(value, "copyParent");
    result.copy_operation_id = uuid(value, "copyOperationId"); result.mode = mode(value);
    result.seeds_internal_sites = boolean(value, "seedsInternalSites");
    result.source = copy_token(object(value, "source")); result.target = copy_token(object(value, "target"));
    const bool migration = result.mode == lmti::ProjectCopyMode::MigrateV1;
    need(result.seeds_internal_sites == migration && result.source.schema == (migration ? 1 : 2) &&
        result.target.schema == 2 && result.source.project_id == result.project_id &&
        result.target.project_id == result.project_id && result.target.revision == result.source.revision + 1 &&
        result.target.store_uuid != result.source.store_uuid && result.source.canonical_path != result.target.canonical_path &&
        result.target.canonical_path == key(QDir(result.copy_parent).filePath(result.copy_operation_id + "/project.sqlite")));
    return result;
}
lmti::LibraryActivationToken activation_token(const QJsonObject &value) {
    fields(value, {"libraryUuid", "operationId", "receiptDigest", "revision"});
    return {uuid(value, "libraryUuid"), uuid(value, "operationId"), digest(value, "receiptDigest"),
        integer(value, "revision", 1, 2)};
}
Action action(const QJsonObject &request) {
    const auto name = text(request, "action", 32);
    for (std::size_t i = 0; i < action_names.size(); ++i)
        if (name == QLatin1String(action_names[i])) return static_cast<Action>(i);
    throw Refused{Code::InvalidInput};
}
struct Request {
    Action action;
    QString library, copy_parent, backup_parent, project_id;
    lmti::LibraryToken library_expected;
    lmti::ProjectCopyPreview copy_expected;
    lmti::LibraryFormatPreview format_expected;
    lmti::LibraryActivationPreview activation_expected;
    lmti::LibraryActivationToken receipt_expected;
};
Request parse(const QStringList &args, const QJsonObject &value, Action selected) {
    need(args.size() == 8 && args[1] == "--project-operation-write" &&
         args[2] == "--library" && args[4] == "--copy-parent" && args[6] == "--backup-parent");
    Request result{selected};
    result.library = lexical(args[3]); result.copy_parent = lexical(args[5]); result.backup_parent = lexical(args[7]);
    if (selected == Action::Copy) {
        fields(value, {"action", "projectId", "expected"}); result.project_id = id(value, "projectId");
        const auto expected = object(value, "expected"); fields(expected, {"libraryIdentity", "preview"});
        result.library_expected = library_token(object(expected, "libraryIdentity"));
        result.copy_expected = copy_preview(object(expected, "preview"));
        need(result.copy_expected.source.project_id == result.project_id);
    } else if (selected == Action::UpgradeV1) {
        fields(value, {"action", "expected"}); result.library_expected = library_token(object(value, "expected"));
        need(result.library_expected.schema == 1);
    } else if (selected == Action::UpgradeV2) {
        fields(value, {"action", "expected"}); result.format_expected = format_preview(object(value, "expected"));
    } else if (selected == Action::Prepare) {
        fields(value, {"action", "expected"}); result.activation_expected = activation_preview(object(value, "expected"));
        need(result.activation_expected.copy_parent == key(result.copy_parent));
    } else {
        fields(value, {"action", "projectId", "expected"}); result.project_id = id(value, "projectId");
        result.receipt_expected = activation_token(object(value, "expected"));
    }
    return result;
}
QByteArray read_request() {
#ifdef Q_OS_WIN
    const auto descriptor = _fileno(stdin);
    need(descriptor >= 0 && _setmode(descriptor, _O_BINARY) != -1);
#endif
    QByteArray bytes(request_cap + 1, Qt::Uninitialized);
    const auto count = std::fread(bytes.data(), 1, static_cast<size_t>(bytes.size()), stdin);
    need(std::ferror(stdin) == 0 && count <= static_cast<size_t>(request_cap) && std::feof(stdin) != 0);
    bytes.resize(static_cast<qsizetype>(count)); return bytes;
}
QJsonObject envelope(Action selected, const char *outcome, Code code_value,
                     const QString &operation = {}, const QJsonValue &details = QJsonValue(QJsonValue::Null)) {
    return {{"schema", "lmti.project.operation.write.v1"},
        {"action", QLatin1String(action_names[static_cast<std::size_t>(selected)])}, {"outcome", outcome},
        {"code", QLatin1String(code_names[static_cast<std::size_t>(code_value)])},
        {"operationId", operation.isEmpty() ? QJsonValue(QJsonValue::Null) : QJsonValue(operation)},
        {"details", details}, {"detailsAvailable", !details.isNull()}};
}
QByteArray frame(const QJsonObject &value) { return QJsonDocument(value).toJson(QJsonDocument::Compact) + '\n'; }
struct Frames {
    std::array<QByteArray, static_cast<std::size_t>(Code::Count)> refused, unknown;
    QByteArray confirmed;
    explicit Frames(Action selected) {
        for (std::size_t i = 1; i < refused.size(); ++i) {
            refused[i] = frame(envelope(selected, "refused", static_cast<Code>(i)));
            unknown[i] = frame(envelope(selected, "unknown", static_cast<Code>(i)));
        }
        confirmed = frame(envelope(selected, "confirmed", Code::None));
    }
    const QByteArray &fallback(Phase phase, Code value) const noexcept {
        if (phase == Phase::Confirmed) return confirmed;
        const auto index = static_cast<std::size_t>(value == Code::None ? Code::OwnerUnavailable : value);
        return phase == Phase::BeforeOwner ? refused[index] : unknown[index];
    }
};
// No test environment is read in the shipped executable.
enum class TestFault { None, EnteredThrow, AfterOwnerReturn, SerializationFallback, Oversize };
TestFault test_fault() {
#ifdef LMTI_PROJECT_OPERATION_WRITE_TESTING
    const auto value = qgetenv("LMTI_PROJECT_OPERATION_WRITE_TEST_FAULT");
    if (value == "entered_throw") return TestFault::EnteredThrow;
    if (value == "after_owner_return") return TestFault::AfterOwnerReturn;
    if (value == "serialization_fallback") return TestFault::SerializationFallback;
    if (value == "oversize") return TestFault::Oversize;
#ifdef LMTI_LIBRARY_CORE_TEST_HOOKS
    using Fault = lmti::LibraryTestFault;
    if (value == "after_upgrade_commit") lmti::set_library_test_fault(Fault::AfterUpgradeCommit);
    else if (value == "after_format_commit") lmti::set_library_test_fault(Fault::AfterFormatCommit);
    else if (value == "after_preparation_commit") lmti::set_library_test_fault(Fault::AfterPreparationCommit);
    else if (value == "after_activation_commit") lmti::set_library_test_fault(Fault::AfterActivationCommit);
    else if (value == "after_abandon_commit") lmti::set_library_test_fault(Fault::AfterAbandonCommit);
#endif
#ifdef LMTI_COPY_OWNER_TEST_HOOKS
    if (value == "copy_before_independent_verification")
        lmti::detail::set_copy_test_fault(lmti::detail::CopyTestFault::BeforeIndependentVerification);
#endif
#endif
    return TestFault::None;
}
void enter(Phase &phase, TestFault fault) {
    phase = Phase::EnteredOwner;
    if (fault == TestFault::EnteredThrow) throw Refused{Code::OwnerUnavailable};
}
void after_owner(TestFault fault) {
    if (fault == TestFault::AfterOwnerReturn) throw Refused{Code::OwnerUnavailable};
}
QByteArray result_frame(Action selected, Phase phase, Code code_value, const QString &operation,
                       const QJsonValue &details, TestFault fault, const Frames &frames) {
    if (fault == TestFault::SerializationFallback) throw Refused{Code::OwnerUnavailable};
    auto result = frame(envelope(selected, phase == Phase::Confirmed ? "confirmed" : "unknown",
        phase == Phase::Confirmed ? Code::None : code_value, operation, details));
    if (fault == TestFault::Oversize) result.resize(response_cap + 1);
    if (result.size() > response_cap) return frames.fallback(phase, code_value);
    return result;
}
QString checked_parent(const QString &path) {
    const auto canonical = lmti::checked_project_folder(path);
    need(!QDir(canonical).isRoot()); return canonical;
}
lmti::LibraryInspection library_view(const QString &path) { return lmti::inspect_project_library(path); }
lmti::LibraryEntry selected_entry(const lmti::LibraryInspection &view, const QString &project) {
    const auto found = std::find_if(view.entries.begin(), view.entries.end(),
        [&](const auto &entry) { return entry.id == project; });
    need(found != view.entries.end(), Code::ScopeDenied); return *found;
}
void recheck(const QString &path, const lmti::LibraryToken &expected, const lmti::LibraryEntry *selected = nullptr) {
    const auto now = library_view(path); need(now.token == expected, Code::ConfigChanged);
    if (selected) {
        const auto entry = selected_entry(now, selected->id);
        need(entry.path == selected->path && entry.folder == selected->folder, Code::ConfigChanged);
    }
}
QJsonValue upgrade_details(const lmti::LibraryUpgradeStatus &status) {
    const auto null = QJsonValue(QJsonValue::Null);
    return QJsonObject{{"state", status.state == lmti::LibraryUpgradeState::Upgraded ? "upgraded" : "recovery_required"},
        {"operationId", status.operation_id.isEmpty() ? null : QJsonValue(status.operation_id)},
        {"backupPath", status.backup_path.isEmpty() ? null : QJsonValue(status.backup_path)},
        {"libraryIdentity", status.library.schema >= 1 && status.library.schema <= 3 ?
            QJsonValue(json::library_json(status.library)) : null}};
}
void latch(bool confirmed, Code returned, Phase &phase, Code &outcome_code) noexcept {
    phase = confirmed ? Phase::Confirmed : Phase::EnteredOwner;
    outcome_code = confirmed ? Code::None : (returned == Code::None ? Code::OwnerUnavailable : returned);
}
QByteArray execute(const Request &request, Phase &phase, Code &outcome_code, TestFault fault, const Frames &frames) {
    if (request.action == Action::Copy) {
        const auto before = library_view(request.library);
        need(before.token == request.library_expected, Code::ConfigChanged);
        const auto entry = selected_entry(before, request.project_id);
        need(key(entry.path) == request.copy_expected.source.canonical_path, Code::ConfigChanged);
        (void)checked_parent(request.copy_parent);
        const auto preview = lmti::inspect_project_copy(entry.path, request.copy_expected.mode);
        need(preview == request.copy_expected, Code::SourceChanged);
        recheck(request.library, before.token, &entry);
        enter(phase, fault);
        const auto result = lmti::prepare_project_copy(entry.path, request.copy_parent, request.copy_expected);
        latch(result.state == lmti::ProjectCopyState::Prepared && result.code == lmti::ProjectCopyCode::None,
            code(result.code), phase, outcome_code);
        after_owner(fault);
        return result_frame(request.action, phase, outcome_code, result.operation_id,
            json::status_json(result), fault, frames);
    }
    if (request.action == Action::UpgradeV1 || request.action == Action::UpgradeV2) {
        (void)checked_parent(request.backup_parent);
        if (request.action == Action::UpgradeV1)
            need(library_view(request.library).token == request.library_expected, Code::ConfigChanged);
        else need(lmti::inspect_library_activation_upgrade(request.library) == request.format_expected, Code::ConfigChanged);
        enter(phase, fault);
        const auto result = request.action == Action::UpgradeV1 ?
            lmti::upgrade_project_library(request.library, request.backup_parent, request.library_expected) :
            lmti::upgrade_library_activation_format(request.library, request.backup_parent, request.format_expected);
        latch(result.state == lmti::LibraryUpgradeState::Upgraded && result.code == lmti::LibraryCode::None,
            code(result.code), phase, outcome_code);
        after_owner(fault);
        return result_frame(request.action, phase, outcome_code, result.operation_id, upgrade_details(result), fault, frames);
    }
    if (request.action == Action::Prepare) {
        const auto &expected = request.activation_expected;
        const auto current = lmti::inspect_library_activation_candidate(request.library,
            expected.project_id, request.copy_parent, expected.copy_operation_id);
        need(current == expected, Code::ConfigChanged);
        recheck(request.library, expected.library);
        enter(phase, fault);
        const auto result = lmti::prepare_library_activation(request.library, request.copy_parent, expected);
        latch(result.code == lmti::LibraryCode::None && result.receipt &&
            result.receipt->state == lmti::LibraryActivationState::Prepared, code(result.code), phase, outcome_code);
        after_owner(fault);
        const QJsonValue details = result.receipt ?
            QJsonValue(QJsonObject{{"receipt", json::activation_receipt_json(*result.receipt)}}) : QJsonValue(QJsonValue::Null);
        return result_frame(request.action, phase, outcome_code, result.operation_id, details, fault, frames);
    }
    const auto &expected = request.receipt_expected;
    if (request.action == Action::Activate) {
        const auto current = lmti::inspect_library_activation(request.library, request.copy_parent,
            expected.library_uuid, expected.operation_id);
        need(current.receipt.prepared.project_id == request.project_id, Code::ScopeDenied);
        need(current.receipt.token == expected && current.receipt.state == lmti::LibraryActivationState::Prepared,
            Code::ConfigChanged);
        need(current.condition == lmti::LibraryActivationCondition::PreparedCurrent &&
            current.code == lmti::LibraryCode::None,
            current.code == lmti::LibraryCode::None ? Code::ConfigChanged : code(current.code));
        recheck(request.library, current.library);
    } else {
        // Abandon is library-only, including when all old project/copy paths are offline.
        const auto before = library_view(request.library);
        need(before.token.schema == 3, Code::UnsupportedFormat);
        need(before.token.library_uuid == expected.library_uuid, Code::ConfigChanged);
        const auto summaries = lmti::list_library_activations(request.library);
        const auto found = std::find_if(summaries.begin(), summaries.end(),
            [&](const auto &entry) { return entry.operation_id == expected.operation_id; });
        need(found != summaries.end(), Code::ConfigChanged);
        need(found->project_id == request.project_id, Code::ScopeDenied);
        need(found->state == lmti::LibraryActivationState::Prepared && found->revision == expected.revision, Code::ConfigChanged);
        recheck(request.library, before.token);
    }
    enter(phase, fault);
    const auto result = request.action == Action::Activate ?
        lmti::activate_library_copy(request.library, request.copy_parent, expected) :
        lmti::abandon_library_activation(request.library, expected);
    const auto target_state = request.action == Action::Activate ?
        lmti::LibraryActivationState::Activated : lmti::LibraryActivationState::Abandoned;
    latch(result.code == lmti::LibraryCode::None && result.receipt && result.receipt->state == target_state,
        code(result.code), phase, outcome_code);
    after_owner(fault);
    const QJsonValue details = result.receipt ?
        QJsonValue(QJsonObject{{"receipt", json::activation_receipt_json(*result.receipt)}}) : QJsonValue(QJsonValue::Null);
    return result_frame(request.action, phase, outcome_code, result.operation_id, details, fault, frames);
}
} // namespace

int project_operation_writes_main(const QStringList &arguments) {
#ifdef Q_OS_WIN
    const auto descriptor = _fileno(stdout);
    if (descriptor < 0 || _setmode(descriptor, _O_BINARY) == -1) return 1;
#endif
    QFile output;
    if (!output.open(stdout, QIODevice::WriteOnly)) return 1;
    // Fixed fallback for input which never establishes a recognized action.
    const QByteArray invalid = QByteArrayLiteral(
        "{\"schema\":\"lmti.project.operation.write.v1\",\"action\":null,\"outcome\":\"refused\","
        "\"code\":\"INVALID_INPUT\",\"operationId\":null,\"details\":null,\"detailsAvailable\":false}\n");
    std::optional<Frames> frames;
    Phase phase = Phase::BeforeOwner;
    Code outcome_code = Code::OwnerUnavailable;
    QByteArray bytes;
    try {
        QJsonObject value;
        try { value = lmti::detail::strict_json_object(read_request(), request_cap); }
        catch (const std::exception &) { throw Refused{Code::InvalidInput}; }
        const auto selected = action(value);
        // Allocation failure is a transport failure before any owner effect,
        // not invalid input or a null-action reply for an action already parsed.
        try { frames.emplace(selected); }
        catch (const std::exception &) { return 1; }
        const auto request = parse(arguments, value, selected);
        const auto fault = test_fault();
        bytes = execute(request, phase, outcome_code, fault, *frames);
    } catch (const Refused &error) {
        if (phase != Phase::Confirmed) outcome_code = error.code;
    } catch (const lmti::ProjectCopyError &error) {
        if (phase != Phase::Confirmed) outcome_code = code(error.code);
    } catch (const lmti::LibraryError &error) {
        if (phase != Phase::Confirmed) outcome_code = code(error.code);
    } catch (const std::exception &) {
        if (phase != Phase::Confirmed) outcome_code = Code::OwnerUnavailable;
    }
    // No JSON allocation, owner readback, retries or second frame after failure.
    const auto &response = !bytes.isEmpty() ? bytes : frames ? frames->fallback(phase, outcome_code) : invalid;
    return output.write(response) == response.size() && output.flush() ? 0 : 1;
}
