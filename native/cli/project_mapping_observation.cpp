#include "project_mapping_observation.hpp"
#include "lmti/project_mapping_observation.hpp"
#include "../common/strict_json.hpp"
#include <QFile>
#include <QJsonArray>
#include <QJsonDocument>
#include <QSet>
#include <QUuid>
#include <algorithm>
#include <cstdio>
#include <exception>
#include <string_view>
#ifdef Q_OS_WIN
#include <fcntl.h>
#include <io.h>
#endif

namespace {
using Code = lmti::MappingObservationCode;
using Kind = lmti::MappingObservationKind;
using IdentityState = lmti::MappingObservationIdentityState;
constexpr qsizetype byte_cap = static_cast<qsizetype>(lmti::max_mapping_observation_bytes);
struct Refused { Code code; };
void need(bool condition, Code code = Code::InvalidInput) {
    if (!condition) throw Refused{code};
}
void fields(const QJsonObject &object, const QSet<QString> &keys) {
    need(object.size() == keys.size());
    for (auto it = object.begin(); it != object.end(); ++it) need(keys.contains(it.key()));
}
QString text(const QJsonValue &value, qsizetype cap) {
    need(value.isString());
    const auto result = value.toString();
    need(result.isValidUtf16() && result.toUtf8().size() <= cap);
    for (const auto c : result) need(c.unicode() >= 32 && c.unicode() != 127);
    return result;
}
std::string identifier(const QString &value) {
    need(value.isValidUtf16() && value.toUtf8().size() <= 64);
    const auto result = value.toStdString();
    try { lmti::validate_id(result); }
    catch (const lmti::Error &) { throw Refused{Code::InvalidInput}; }
    return result;
}
std::string uuid(const QString &value) {
    need(value.isValidUtf16() && value.size() == 36);
    const QUuid parsed(value);
    need(!parsed.isNull() && parsed.toString(QUuid::WithoutBraces) == value);
    return value.toStdString();
}
QString fixed_path(const QString &value) {
    // Pure Windows lexical checks only. Keep the original I/O spelling; no
    // canonical-path resolution or filesystem probing belongs in the CLI.
    need(!value.isEmpty() && value.size() <= 1024 && value.isValidUtf16());
    for (const auto c : value)
        need(c.unicode() >= 32 && c.unicode() != 127 &&
             !QStringLiteral("<>\"|?*").contains(c));
    auto normalized = value;
    normalized.replace('\\', '/');
    need(normalized.size() > 3 &&
         ((normalized[0] >= 'A' && normalized[0] <= 'Z') ||
          (normalized[0] >= 'a' && normalized[0] <= 'z')) &&
         normalized[1] == ':' && normalized[2] == '/');
    const auto tail = normalized.mid(3);
    need(!tail.contains(':'));
    const auto parts = tail.split('/');
    need(parts.size() + 1 <= 64, Code::BudgetExceeded);
    for (const auto &part : parts) {
        need(!part.isEmpty() && part != "." && part != ".." &&
             !part.endsWith('.') && !part.endsWith(' '));
        const auto device = part.section('.', 0, 0).toLower();
        need(device != "con" && device != "prn" && device != "aux" && device != "nul" &&
             !(device.size() == 4 && (device.startsWith("com") || device.startsWith("lpt")) &&
               device[3] >= '1' && device[3] <= '9'));
    }
    return value;
}
const char *kind_name(Kind kind) {
    switch (kind) {
    case Kind::Component: return "component";
    case Kind::Asset: return "asset";
    case Kind::Subsystem: return "subsystem";
    case Kind::Site: return "site";
    case Kind::Area: return "area";
    case Kind::Environment: return "environment";
    case Kind::Repository: return "repository";
    case Kind::Knowledge: return "knowledge";
    }
    throw Refused{Code::OwnerUnavailable};
}
Kind kind(const QString &value) {
    if (value == "component") return Kind::Component;
    if (value == "asset") return Kind::Asset;
    if (value == "subsystem") return Kind::Subsystem;
    if (value == "site") return Kind::Site;
    if (value == "area") return Kind::Area;
    if (value == "environment") return Kind::Environment;
    if (value == "repository") return Kind::Repository;
    if (value == "knowledge") return Kind::Knowledge;
    throw Refused{Code::InvalidInput};
}
struct Launch {
    QString database;
    lmti::MappingObservationScope scope;
    int storage_schema = 0;
};
Launch launch(const QStringList &arguments) {
    need(arguments.size() == 8 && (arguments[1] == "mapping-observation" ||
                                  arguments[1] == "mapping-observation-v2"));
    need(arguments[7] == "local" || arguments[7] == "external");
    Launch result;
    result.storage_schema = arguments[1] == "mapping-observation" ? 2 : 3;
    result.database = fixed_path(arguments[2]);
    result.scope = {identifier(arguments[3]), uuid(arguments[4]),
        identifier(arguments[5]), identifier(arguments[6]), arguments[7] == "local"};
    return result;
}
QByteArray input_bytes() {
#ifdef Q_OS_WIN
    const auto descriptor = _fileno(stdin);
    need(descriptor >= 0 && _setmode(descriptor, _O_BINARY) != -1, Code::OwnerUnavailable);
#endif
    QByteArray bytes(byte_cap + 1, Qt::Uninitialized);
    const auto count = std::fread(bytes.data(), 1, static_cast<std::size_t>(bytes.size()), stdin);
    need(std::ferror(stdin) == 0, Code::OwnerUnavailable);
    need(count <= static_cast<std::size_t>(byte_cap), Code::BudgetExceeded);
    need(std::feof(stdin) != 0, Code::OwnerUnavailable);
    bytes.resize(static_cast<qsizetype>(count));
    return bytes;
}
std::vector<lmti::MappingObservationTarget> request(const lmti::MappingObservationScope &scope) {
    QJsonObject root;
    const auto bytes = input_bytes();
    try { root = lmti::detail::strict_json_object(bytes, byte_cap); }
    catch (const lmti::Error &) { throw Refused{Code::InvalidInput}; }
    fields(root, {"targets"});
    need(root.value("targets").isArray());
    const auto array = root.value("targets").toArray();
    need(array.size() <= static_cast<qsizetype>(lmti::max_mapping_observation_targets),
         Code::BudgetExceeded);
    std::vector<lmti::MappingObservationTarget> targets;
    targets.reserve(static_cast<std::size_t>(array.size()));
    for (const auto &item : array) {
        need(item.isObject());
        const auto row = item.toObject();
        fields(row, {"kind", "id"});
        targets.push_back({kind(text(row.value("kind"), 11)),
            identifier(text(row.value("id"), 64))});
    }
    // The typed pure validator also rejects duplicate tuples before any owner
    // namespace acquisition. Identical IDs in different kinds remain distinct.
    lmti::validate_mapping_observation_request(scope, targets);
    std::sort(targets.begin(), targets.end(), [](const auto &a, const auto &b) {
        const auto ak = std::string_view(kind_name(a.kind)), bk = std::string_view(kind_name(b.kind));
        return ak == bk ? a.id < b.id : ak < bk;
    });
    return targets;
}
QString fingerprint(const std::string &value) {
    need(value.size() == 64 && std::all_of(value.begin(), value.end(), [](char c) {
        return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f');
    }), Code::OwnerUnavailable);
    return QString::fromStdString(value);
}
QByteArray response(const Launch &fixed,
                    const std::vector<lmti::MappingObservationTarget> &requested,
                    const lmti::ProjectMappingObservation &value) {
    need(value.storage_schema == fixed.storage_schema &&
         value.project_id == fixed.scope.project_id && value.store_uuid == fixed.scope.store_uuid &&
         value.revision >= 1 && value.revision <= 9007199254740990LL &&
         value.targets.size() == requested.size(), Code::OwnerUnavailable);
    const auto project = QString::fromStdString(value.project_id);
    const auto store = QString::fromStdString(value.store_uuid);
    QJsonArray targets;
    for (std::size_t i = 0; i < value.targets.size(); ++i) {
        const auto &row = value.targets[i];
        need(row.target == requested[i], Code::OwnerUnavailable);
        need(row.effective_classification == lmti::Privacy::Public ||
             row.effective_classification == lmti::Privacy::Internal, Code::OwnerUnavailable);
        need(fixed.scope.allow_internal || row.effective_classification == lmti::Privacy::Public,
             Code::OwnerUnavailable);
        const bool reference = row.target.kind == Kind::Repository || row.target.kind == Kind::Knowledge;
        need(row.identity_state == (reference ? IdentityState::PresentReference : IdentityState::Active) &&
             row.reference_fingerprint.has_value() == reference, Code::OwnerUnavailable);
        const QJsonObject target{{"projectId", project}, {"storeUuid", store},
            {"kind", kind_name(row.target.kind)}, {"id", QString::fromStdString(row.target.id)}};
        targets.append(QJsonObject{{"target", target},
            {"effectiveClassification", row.effective_classification == lmti::Privacy::Public ? "public" : "internal"},
            {"ancestryFingerprint", fingerprint(row.ancestry_fingerprint)},
            {"referenceFingerprint", reference ? QJsonValue(fingerprint(*row.reference_fingerprint)) :
                QJsonValue(QJsonValue::Null)},
            {"identityState", reference ? "present_reference" : "active"}});
    }
    QJsonObject result{{"ok", true}, {"schema", fixed.storage_schema == 2 ?
        "lmti.project.mapping-observation.v1" : "lmti.project.mapping-observation.v2"},
        {"projectId", project}, {"storeUuid", store},
        {"revision", static_cast<qint64>(value.revision)}, {"targets", targets}};
    if (fixed.storage_schema == 3) result.insert("storageSchema", value.storage_schema);
    auto bytes = QJsonDocument(result).toJson(QJsonDocument::Compact);
    bytes.append('\n');
    need(bytes.size() <= byte_cap, Code::BudgetExceeded);
    return bytes;
}
QByteArray error_frame(Code code) {
    switch (code) {
    case Code::InvalidInput: return QByteArrayLiteral("{\"ok\":false,\"code\":\"INVALID_INPUT\"}\n");
    case Code::NativeUnavailable: return QByteArrayLiteral("{\"ok\":false,\"code\":\"NATIVE_UNAVAILABLE\"}\n");
    case Code::ConfigChanged: return QByteArrayLiteral("{\"ok\":false,\"code\":\"CONFIG_CHANGED\"}\n");
    case Code::OwnerUnavailable: return QByteArrayLiteral("{\"ok\":false,\"code\":\"OWNER_UNAVAILABLE\"}\n");
    case Code::NotSupported: return QByteArrayLiteral("{\"ok\":false,\"code\":\"NOT_SUPPORTED\"}\n");
    case Code::BudgetExceeded: return QByteArrayLiteral("{\"ok\":false,\"code\":\"BUDGET_EXCEEDED\"}\n");
    }
    return QByteArrayLiteral("{\"ok\":false,\"code\":\"OWNER_UNAVAILABLE\"}\n");
}
} // namespace

int project_mapping_observation_main(const QStringList &arguments) {
#ifdef Q_OS_WIN
    const auto descriptor = _fileno(stdout);
    if (descriptor < 0 || _setmode(descriptor, _O_BINARY) == -1) return 1;
#endif
    QFile output;
    if (!output.open(stdout, QIODevice::WriteOnly)) return 1;
    QByteArray bytes;
    bool success = false;
    try {
        const auto fixed = launch(arguments);
        const auto targets = request(fixed.scope);
        const auto observed = fixed.storage_schema == 2 ?
            lmti::read_project_mapping_observation(fixed.database, fixed.scope, targets) :
            lmti::read_project_mapping_observation_v2(fixed.database, fixed.scope, targets);
        bytes = response(fixed, targets, observed);
        success = true;
    } catch (const Refused &error) { bytes = error_frame(error.code); }
      catch (const lmti::MappingObservationError &error) { bytes = error_frame(error.code); }
      catch (const std::exception &) { bytes = error_frame(Code::OwnerUnavailable); }
    if (output.write(bytes) != bytes.size() || !output.flush()) return 1;
    return success ? 0 : 1;
}
