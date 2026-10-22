#include "original_binding_read.hpp"
#include "lmti/mcp_original_read.hpp"
#include "../common/local_owner_path.hpp"
#include "../common/strict_json.hpp"
#include <QFile>
#include <QJsonArray>
#include <QJsonDocument>
#include <QSet>
#include <QUuid>
#include <cmath>
#include <cstdio>
#include <exception>
#ifdef Q_OS_WIN
#include <fcntl.h>
#include <io.h>
#endif

namespace {
using Code = lmti::OriginalReadCode;
constexpr qsizetype request_cap = 64 * 1024, response_cap = 128 * 1024;
struct Refused { Code code; };
void need(bool condition, Code code = Code::InvalidInput) {
    if (!condition) throw Refused{code};
}
void fields(const QJsonObject &value, const QSet<QString> &keys) {
    need(value.size() == keys.size());
    for (auto it = value.begin(); it != value.end(); ++it) need(keys.contains(it.key()));
}
QJsonObject object(const QJsonValue &value) {
    need(value.isObject()); return value.toObject();
}
QJsonObject object(const QJsonObject &value, const char *field) {
    return object(value.value(field));
}
QString text(const QJsonObject &value, const char *field, qsizetype cap) {
    need(value.value(field).isString());
    const auto result = value.value(field).toString();
    need(result.toUtf8().size() <= cap);
    for (qsizetype i = 0; i < result.size(); ++i) {
        const auto c = result[i];
        need(c.unicode() >= 32 && c.unicode() != 127);
        if (c.isHighSurrogate()) {
            need(i + 1 < result.size() && result[i + 1].isLowSurrogate()); ++i;
        } else need(!c.isLowSurrogate());
    }
    return result;
}
int integer(const QJsonObject &value, const char *field, int low, int high) {
    need(value.value(field).isDouble());
    const auto number = value.value(field).toDouble();
    need(std::isfinite(number) && std::floor(number) == number && number >= low && number <= high);
    return static_cast<int>(number);
}
bool boolean(const QJsonObject &value, const char *field) {
    need(value.value(field).isBool()); return value.value(field).toBool();
}
QString path_text(const QJsonObject &value, const char *field, bool optional = false) {
    // The native local-path limit is 1,024 QString code units. Preserve spelling;
    // physical paths are never replaced by the opaque Qt canonical identity key.
    const auto result = text(value, field, 4096);
    if (optional && result.isEmpty()) return result;
    for (const auto c : result) need(!QStringLiteral("<>\"|?*").contains(c));
    try { (void)lmti::detail::local_owner_path_lexical(result); }
    catch (const std::exception &) { throw Refused{Code::InvalidInput}; }
    return result;
}
QString decimal(const QJsonObject &value, const char *field, bool positive) {
    const auto result = text(value, field, 40);
    need(!result.isEmpty() && (result.size() == 1 || result[0] != QChar('0')));
    for (const auto c : result) need(c >= QChar('0') && c <= QChar('9'));
    need(!positive || result != QStringLiteral("0"));
    // Exact range and Windows FILETIME conversion are checked by the owner.
    return result;
}
QString nullable_uuid(const QJsonObject &value, const char *field, bool absent) {
    if (absent) {
        need(value.value(field).isNull()); return QStringLiteral("");
    }
    const auto result = text(value, field, 36);
    const QUuid parsed(result);
    need(result.size() == 36 && !parsed.isNull() &&
        parsed.toString(QUuid::WithoutBraces) == result);
    return result;
}
lmti::OriginalPhysicalTarget physical(const QJsonObject &value) {
    fields(value, {"version", "path", "kind", "state", "chain"});
    need(integer(value, "version", 1, 1) == 1 && text(value, "kind", 9) == "file");
    lmti::OriginalPhysicalTarget result;
    result.path = path_text(value, "path");
    const auto state = text(value, "state", 11);
    need(state == "present" || state == "missing" || state == "unsupported");
    need(value.value("chain").isArray());
    const auto chain = value.value("chain").toArray();
    need(chain.size() <= 64, Code::LimitExceeded);
    bool unavailable = state == "unsupported";
    result.chain.reserve(static_cast<std::size_t>(chain.size()));
    for (const auto &item : chain) {
        if (item.isNull()) { unavailable = true; continue; }
        const auto identity = object(item);
        fields(identity, {"dev", "ino", "birthtimeNs"});
        result.chain.push_back({decimal(identity, "dev", false),
            decimal(identity, "ino", true), decimal(identity, "birthtimeNs", true)});
    }
    need(!unavailable, Code::RecoveryRequired);
    result.state = state == "missing" ? lmti::OriginalPhysicalState::Missing :
        lmti::OriginalPhysicalState::Present;
    return result;
}
lmti::OriginalBindingExpected expected(const QJsonObject &value) {
    fields(value, {"version", "projectId", "library", "project", "profiles", "linkedRoot"});
    need(integer(value, "version", 1, 1) == 1);
    lmti::OriginalBindingExpected result;
    const auto project_id = text(value, "projectId", 64);
    try { lmti::validate_id(project_id.toStdString()); }
    catch (const std::exception &) { throw Refused{Code::InvalidInput}; }
    result.project_id = project_id.toStdString();
    const auto library = object(value, "library");
    fields(library, {"schema", "canonicalPath", "uuid", "physical"});
    result.library.schema = integer(library, "schema", 1, 3);
    result.library.canonical_path = path_text(library, "canonicalPath");
    result.library.uuid = nullable_uuid(library, "uuid", result.library.schema == 1);
    result.library.physical = physical(object(library, "physical"));
    const auto project = object(value, "project");
    fields(project, {"schema", "storeUuid", "physical"});
    result.project.schema = integer(project, "schema", 1, 2);
    result.project.store_uuid = nullable_uuid(project, "storeUuid", result.project.schema == 1);
    result.project.physical = physical(object(project, "physical"));
    result.profiles = physical(object(value, "profiles"));
    result.linked_root = path_text(value, "linkedRoot", true);
    return result;
}
QByteArray read_request() {
#ifdef Q_OS_WIN
    const auto descriptor = _fileno(stdin);
    need(descriptor >= 0 && _setmode(descriptor, _O_BINARY) != -1, Code::OwnerUnavailable);
#endif
    QByteArray bytes(request_cap + 1, Qt::Uninitialized);
    const auto count = std::fread(bytes.data(), 1, static_cast<std::size_t>(bytes.size()), stdin);
    need(std::ferror(stdin) == 0, Code::OwnerUnavailable);
    need(count <= static_cast<std::size_t>(request_cap), Code::LimitExceeded);
    need(std::feof(stdin) != 0, Code::OwnerUnavailable);
    bytes.resize(static_cast<qsizetype>(count));
    return bytes;
}
QJsonObject library_json(const lmti::LibraryToken &value) {
    return {{"schema", value.schema}, {"canonicalPath", value.canonical_path},
        {"uuid", value.schema == 1 ? QJsonValue(QJsonValue::Null) : QJsonValue(value.library_uuid)},
        {"generation", value.schema == 1 ? QJsonValue(QJsonValue::Null) : QJsonValue(value.generation)},
        {"digest", value.digest}};
}
QJsonObject binding_json(const lmti::OriginalBindingRead &value) {
    const auto &document = value.document;
    const auto &lineage = document.storage_lineage;
    const QJsonObject identity{{"schema", lineage ? lineage->schema_version : 1},
        {"storeUuid", lineage ? QJsonValue(QString::fromStdString(lineage->store_uuid)) :
            QJsonValue(QJsonValue::Null)},
        {"revision", document.topology.revision}};
    return {{"id", value.entry.id}, {"name", QString::fromStdString(document.project.label)},
        {"database", value.entry.path}, {"root", value.entry.folder},
        {"projectRevision", document.topology.revision},
        {"libraryIdentity", library_json(value.library)}, {"projectIdentity", identity}};
}
QJsonObject profile_json(const lmti::McpProfile &value) {
    QJsonArray servers;
    for (const auto &server : value.servers) {
        QJsonObject row{{"id", QString::fromStdString(server.id)},
            {"label", QString::fromStdString(server.label)}, {"enabled", server.enabled}};
        switch (server.transport) {
        case lmti::McpTransport::LmtiLocal:
            need(server.auth == lmti::McpAuth::None, Code::OwnerUnavailable);
            row["transport"] = "lmti_local"; row["auth"] = "none";
            row["site"] = QString::fromStdString(server.site);
            break;
        case lmti::McpTransport::RemoteHttps:
            need(server.auth == lmti::McpAuth::ClientOAuth, Code::OwnerUnavailable);
            row["transport"] = "remote_https"; row["auth"] = "client_oauth";
            row["endpoint"] = QString::fromStdString(server.endpoint);
            row["privateEndpoint"] = server.private_endpoint;
            break;
        default: throw Refused{Code::OwnerUnavailable};
        }
        servers.append(row);
    }
    return {{"projectId", QString::fromStdString(value.project_id)},
        {"revision", value.revision}, {"servers", servers}};
}
QByteArray error_frame(Code code) {
    switch (code) {
    case Code::InvalidInput: return QByteArrayLiteral("{\"ok\":false,\"code\":\"INVALID_INPUT\"}\n");
    case Code::ScopeDenied: return QByteArrayLiteral("{\"ok\":false,\"code\":\"SCOPE_DENIED\"}\n");
    case Code::ConfigChanged: return QByteArrayLiteral("{\"ok\":false,\"code\":\"CONFIG_CHANGED\"}\n");
    case Code::OwnerUnavailable: return QByteArrayLiteral("{\"ok\":false,\"code\":\"OWNER_UNAVAILABLE\"}\n");
    case Code::NotSupported: return QByteArrayLiteral("{\"ok\":false,\"code\":\"NOT_SUPPORTED\"}\n");
    case Code::LimitExceeded: return QByteArrayLiteral("{\"ok\":false,\"code\":\"LIMIT_EXCEEDED\"}\n");
    case Code::RecoveryRequired: return QByteArrayLiteral("{\"ok\":false,\"code\":\"RECOVERY_REQUIRED\"}\n");
    }
    return QByteArrayLiteral("{\"ok\":false,\"code\":\"OWNER_UNAVAILABLE\"}\n");
}
QByteArray execute(const QStringList &arguments) {
    need(arguments.size() == 6 && arguments[1] == "--original-binding-read" &&
        arguments[2] == "--library" && arguments[4] == "--profiles");
    const auto bytes = read_request();
    QJsonObject request;
    try { request = lmti::detail::strict_json_object(bytes, request_cap); }
    catch (const std::exception &) { throw Refused{Code::InvalidInput}; }
    fields(request, {"action", "allowMissingProfile", "expected"});
    need(text(request, "action", 32) == "read-original");
    const auto policy = boolean(request, "allowMissingProfile") ?
        lmti::MissingProfilePolicy::AllowStillAbsent : lmti::MissingProfilePolicy::PresentOnly;
    const auto pin = expected(object(request, "expected"));
    // All filesystem/SQLite work is owned by this one conditional read. In
    // particular, do not resolve a fresh library row or probe expected paths here.
    const auto result = lmti::read_original_mcp_state(arguments[3], arguments[5], pin, policy);
    const QJsonObject response{{"ok", true}, {"schema", "lmti.mcp.original-read.v1"},
        {"action", "read-original"}, {"binding", binding_json(result)},
        {"profile", profile_json(result.profile)}};
    auto frame = QJsonDocument(response).toJson(QJsonDocument::Compact) + '\n';
    need(frame.size() <= response_cap, Code::LimitExceeded);
    return frame;
}
} // namespace

int original_binding_read_main(const QStringList &arguments) {
#ifdef Q_OS_WIN
    const auto descriptor = _fileno(stdout);
    if (descriptor < 0 || _setmode(descriptor, _O_BINARY) == -1) return 1;
#endif
    QFile output;
    if (!output.open(stdout, QIODevice::WriteOnly)) return 1;
    QByteArray bytes;
    try { bytes = execute(arguments); }
    catch (const Refused &error) { bytes = error_frame(error.code); }
    catch (const lmti::OriginalReadError &error) { bytes = error_frame(error.code); }
    catch (...) { bytes = error_frame(Code::OwnerUnavailable); }
    return output.write(bytes) == bytes.size() && output.flush() ? 0 : 1;
}
