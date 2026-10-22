#include "lmti/project_copy.hpp"
#include "project_copy_p.hpp"
#include "../common/local_owner_path.hpp"
#include "../common/strict_json.hpp"
#include <QCryptographicHash>
#include <QDir>
#include <QFile>
#include <QFileInfo>
#include <QJsonDocument>
#include <QRegularExpression>
#include <QUuid>
#include <algorithm>
#include <cmath>
#include <filesystem>
#ifdef Q_OS_WIN
#include <io.h>
#else
#include <unistd.h>
#endif

namespace lmti {
#ifdef LMTI_COPY_OWNER_TEST_HOOKS
namespace detail {
thread_local CopyTestFault copy_test_fault = CopyTestFault::None;
void set_copy_test_fault(CopyTestFault fault) { copy_test_fault = fault; }
void copy_test_fail(CopyTestFault phase) {
    if (copy_test_fault == phase) {
        copy_test_fault = CopyTestFault::None;
        throw ProjectCopyError(ProjectCopyCode::OwnerUnavailable);
    }
}
}
#endif
namespace {
constexpr qsizetype receipt_cap = 8192;
void need(bool value, ProjectCopyCode code = ProjectCopyCode::EvidenceInvalid) {
    if (!value) throw ProjectCopyError(code);
}
bool uuid(const QString &text) {
    const QUuid value(text);
    return !value.isNull() && value.toString(QUuid::WithoutBraces) == text;
}
QString normalized(const QString &path) {
    auto result = QDir::cleanPath(path);
#ifdef Q_OS_WIN
    result = result.toCaseFolded();
#endif
    return result;
}
QString parent_path(const QString &path) {
    QString parent;
    try { parent = detail::local_owner_path(path,true,true); }
    catch (const std::exception &) { throw ProjectCopyError(ProjectCopyCode::InvalidInput); }
    need(QDir(parent).isRoot() == false,ProjectCopyCode::InvalidInput);
    for (const auto &part : QDir::fromNativeSeparators(parent).split('/'))
        need(part.compare(".lmti",Qt::CaseInsensitive) != 0,ProjectCopyCode::InvalidInput);
    return parent;
}
QString operation_path(const QString &parent, const QString &id) {
    need(uuid(id),ProjectCopyCode::InvalidInput);
    return QDir(parent).filePath(id);
}
QString digest(const QByteArray &bytes) {
    return QString::fromLatin1(QCryptographicHash::hash(bytes,QCryptographicHash::Sha256).toHex());
}
void fields(const QJsonObject &object, const QSet<QString> &keys) {
    need(object.size() == keys.size());
    for (auto it = object.begin(); it != object.end(); ++it) need(keys.contains(it.key()));
}
QString text(const QJsonObject &object, const char *key, int cap) {
    need(object[key].isString());
    const auto value = object[key].toString();
    need(value.toUtf8().size() <= cap);
    for (const auto c : value) need(c.unicode() >= 32 && c.unicode() != 127);
    return value;
}
qint64 integer(const QJsonObject &object, const char *key, qint64 minimum = 1) {
    const auto value = object[key].toDouble(-1);
    need(object[key].isDouble() && std::isfinite(value) && std::floor(value) == value &&
         value >= minimum && value <= 9007199254740991.0);
    return object[key].toInteger();
}
QJsonObject token_json(const ProjectCopyToken &token) {
    return {{"schemaVersion",token.schema},{"projectId",token.project_id},{"canonicalPath",token.canonical_path},
            {"storeUuid",token.store_uuid},{"revision",token.revision},{"contentDigest",token.content_digest},
            {"registryDigest",token.registry_digest}};
}
ProjectCopyToken token(const QJsonValue &value) {
    need(value.isObject());
    const auto object = value.toObject();
    fields(object,{"schemaVersion","projectId","canonicalPath","storeUuid","revision","contentDigest","registryDigest"});
    ProjectCopyToken result;
    const auto version = integer(object,"schemaVersion");
    need(version == 1 || version == 2); result.schema = static_cast<int>(version);
    result.project_id = text(object,"projectId",64); validate_id(result.project_id.toStdString());
    result.canonical_path = text(object,"canonicalPath",1024);
    // Receipt paths are metadata only. Never probe a source path from JSON.
    need(QDir::isAbsolutePath(result.canonical_path) && QDir::cleanPath(result.canonical_path) == result.canonical_path);
    result.store_uuid = text(object,"storeUuid",36);
    need(result.schema == 1 ? result.store_uuid.isEmpty() : uuid(result.store_uuid));
    result.revision = integer(object,"revision");
    result.content_digest = text(object,"contentDigest",64);
    result.registry_digest = text(object,"registryDigest",64);
    const QRegularExpression hex("^[0-9a-f]{64}$");
    need(hex.match(result.content_digest).hasMatch() && hex.match(result.registry_digest).hasMatch());
    return result;
}
QByteArray read_receipt(const QString &path) {
    detail::local_owner_path(path);
    QFile file(path);
    need(file.open(QIODevice::ReadOnly));
    const auto bytes = file.read(receipt_cap+1);
    need(file.atEnd() && !bytes.isEmpty() && bytes.size() <= receipt_cap);
    return bytes;
}
void write_receipt(const QString &path, const QJsonObject &object) {
    detail::local_owner_path(path,false);
    const auto bytes = QJsonDocument(object).toJson(QJsonDocument::Compact);
    need(bytes.size() <= receipt_cap,ProjectCopyCode::BudgetExceeded);
    QFile file(path);
    need(file.open(QIODevice::WriteOnly | QIODevice::NewOnly),ProjectCopyCode::OwnerUnavailable);
    need(file.write(bytes) == bytes.size() && file.flush(),ProjectCopyCode::OwnerUnavailable);
#ifdef Q_OS_WIN
    need(_commit(file.handle()) == 0,ProjectCopyCode::OwnerUnavailable);
#else
    need(::fsync(file.handle()) == 0,ProjectCopyCode::OwnerUnavailable);
#endif
    file.close();
}
ProjectCopyPreview preview(const detail::CopySnapshot &source, const detail::CopySnapshot &target, ProjectCopyMode mode) {
    return {mode,source.token,target.token.revision,target.token.content_digest,target.token.registry_digest,
            mode == ProjectCopyMode::MigrateV1};
}
QJsonObject intent_json(const ProjectCopyStatus &status) {
    return {{"schema","lmti.project.copy.intent.v1"},{"operationId",status.operation_id},
            {"mode",status.mode == ProjectCopyMode::MigrateV1 ? "migrate_v1" : "clone_v2"},
            {"sitePolicy",status.seeds_internal_sites ? "internal_known_sites" : "unchanged"},
            {"source",token_json(status.source)},{"target",token_json(status.target)}};
}
QJsonObject verified_json(const ProjectCopyStatus &status, const QString &intent_digest) {
    return {{"schema","lmti.project.copy.verified.v1"},{"operationId",status.operation_id},
            {"intentDigest",intent_digest},{"target",token_json(status.target)}};
}
ProjectCopyStatus intent_status(const QByteArray &bytes, const QString &id, const QString &fixed_target) {
    const auto object = detail::strict_json_object(bytes,receipt_cap);
    fields(object,{"schema","operationId","mode","sitePolicy","source","target"});
    need(object["schema"] == "lmti.project.copy.intent.v1" && object["operationId"] == id);
    const auto mode = text(object,"mode",16), policy = text(object,"sitePolicy",32);
    need(mode == "migrate_v1" || mode == "clone_v2");
    ProjectCopyStatus status;
    status.operation_id = id;
    status.mode = mode == "migrate_v1" ? ProjectCopyMode::MigrateV1 : ProjectCopyMode::CloneV2;
    status.seeds_internal_sites = status.mode == ProjectCopyMode::MigrateV1;
    need(policy == (status.seeds_internal_sites ? "internal_known_sites" : "unchanged"));
    status.source = token(object["source"]); status.target = token(object["target"]);
    need(status.source.schema == (status.seeds_internal_sites ? 1 : 2) && status.target.schema == 2 &&
         status.source.project_id == status.target.project_id && status.source.revision < 9007199254740991LL &&
         status.target.revision == status.source.revision+1 && status.target.store_uuid != status.source.store_uuid &&
         status.target.canonical_path == normalized(fixed_target) &&
         status.source.canonical_path != status.target.canonical_path);
    return status;
}

std::filesystem::path discovery_path(const QString &path) {
#ifdef Q_OS_WIN
    return std::filesystem::path(path.toStdWString());
#else
    return std::filesystem::path(QFile::encodeName(path).constData());
#endif
}
QString discovery_name(const std::filesystem::path &path) {
#ifdef Q_OS_WIN
    return QString::fromStdWString(path.filename().native());
#else
    return QFile::decodeName(path.filename().native().c_str());
#endif
}
enum class IntentReadState { Missing, Bytes, Invalid, Unavailable };
struct IntentRead {
    IntentReadState state = IntentReadState::Unavailable;
    QByteArray bytes;
};
IntentRead discovery_intent(const QString &directory) {
    try {
        // Parent checks precede the fixed leaf probe. Neither iterator metadata
        // nor a receipt can authorize traversal through a linked directory.
        detail::local_owner_path(directory,true,true);
        const auto path = QDir(directory).filePath("intent.json");
        std::error_code error;
        const auto status = std::filesystem::symlink_status(discovery_path(path),error);
        if (status.type() == std::filesystem::file_type::not_found &&
            (!error || error == std::errc::no_such_file_or_directory))
            return {IntentReadState::Missing,{}};
        if (error || std::filesystem::is_symlink(status)) return {};
        const QFileInfo leaf(path);
        if (leaf.isSymLink() || leaf.isJunction()) return {};
        if (!std::filesystem::is_regular_file(status)) return {IntentReadState::Invalid,{}};
        detail::local_owner_path(path);
        QFile file(path);
        if (!file.open(QIODevice::ReadOnly)) return {};
        const auto bytes = file.read(receipt_cap+1);
        if (file.error() != QFileDevice::NoError) return {};
        if (bytes.size() > receipt_cap || !file.atEnd()) return {IntentReadState::Invalid,bytes};
        return {IntentReadState::Bytes,bytes};
    } catch (const std::exception &) { return {}; }
}
ProjectCopyCandidate discovery_candidate(const QString &parent,const QString &id) {
    ProjectCopyCandidate result; result.operation_id = id;
    // The caller checks raw names before joining paths; keep that invariant here.
    need(uuid(id),ProjectCopyCode::InvalidInput);
    const auto directory = operation_path(parent,id);
    try {
        detail::local_owner_path(parent,true,true);
        std::error_code error;
        const auto status = std::filesystem::symlink_status(discovery_path(directory),error);
        if (error || !std::filesystem::exists(status) || std::filesystem::is_symlink(status)) return result;
        // Windows junctions need not be reported as symlinks/directories by the
        // standard library. Classify reparse leaves before ordinary file types.
        const QFileInfo leaf(directory);
        if (leaf.isSymLink() || leaf.isJunction()) return result;
        if (!std::filesystem::is_directory(status)) {
            result.state = ProjectCopyCandidateState::Invalid;
            return result;
        }
        detail::local_owner_path(directory,true,true);
        const auto first = discovery_intent(directory);
        const auto second = discovery_intent(directory);
        detail::local_owner_path(directory,true,true);
        if (first.state == IntentReadState::Unavailable || second.state == IntentReadState::Unavailable ||
            first.state != second.state || first.bytes != second.bytes)
            return result;
        if (first.state == IntentReadState::Missing ||
            (first.state == IntentReadState::Bytes && first.bytes.isEmpty())) {
            result.state = ProjectCopyCandidateState::Incomplete;
            return result;
        }
        if (first.state == IntentReadState::Invalid) {
            result.state = ProjectCopyCandidateState::Invalid;
            return result;
        }
        try {
            // Shared exact-schema parser binds intent to this operation/fixed
            // target spelling. Receipt paths are metadata only, never I/O.
            const auto parsed = intent_status(first.bytes,id,QDir(directory).filePath("project.sqlite"));
            result.intent = ProjectCopyIntentMetadata{
                parsed.mode,parsed.seeds_internal_sites,parsed.source,parsed.target};
            result.state = ProjectCopyCandidateState::Uninspected;
        } catch (const std::exception &) { result.state = ProjectCopyCandidateState::Invalid; }
    } catch (const std::exception &) { /* Retain Unavailable with no intent. */ }
    return result;
}
}
ProjectCopyPreview inspect_project_copy(const QString &source, ProjectCopyMode mode) {
    need(mode == ProjectCopyMode::MigrateV1 || mode == ProjectCopyMode::CloneV2,ProjectCopyCode::InvalidInput);
    try {
        const auto captured = detail::capture_project_copy(source);
        const auto target = detail::transform_project_copy(captured,mode);
        return preview(captured,target,mode);
    } catch (const ProjectCopyError &) { throw; }
      catch (const std::exception &) { throw ProjectCopyError(ProjectCopyCode::OwnerUnavailable); }
}
ProjectCopyStatus prepare_project_copy(const QString &source, const QString &trusted_parent,
                                      const ProjectCopyPreview &expected) {
    need(expected.mode == ProjectCopyMode::MigrateV1 || expected.mode == ProjectCopyMode::CloneV2,ProjectCopyCode::InvalidInput);
    detail::CopySnapshot captured, target;
    QString parent;
    try {
        parent = parent_path(trusted_parent);
        captured = detail::capture_project_copy(source);
        target = detail::transform_project_copy(captured,expected.mode);
        need(preview(captured,target,expected.mode) == expected,ProjectCopyCode::SourceChanged);
    } catch (const ProjectCopyError &) { throw; }
      catch (const std::exception &) { throw ProjectCopyError(ProjectCopyCode::OwnerUnavailable); }
    ProjectCopyStatus result;
    result.operation_id = QUuid::createUuid().toString(QUuid::WithoutBraces);
    result.mode = expected.mode; result.seeds_internal_sites = expected.seeds_internal_sites;
    result.source = captured.token; result.target = target.token;
    const auto directory = operation_path(parent,result.operation_id);
    const auto target_path = QDir(directory).filePath("project.sqlite");
    result.target.canonical_path = normalized(target_path);
    result.target.store_uuid = QUuid::createUuid().toString(QUuid::WithoutBraces);
    // No retries or overwrite if an exclusive reservation fails.
    need(QDir(parent).mkdir(result.operation_id),ProjectCopyCode::OwnerUnavailable);
    try {
        detail::local_owner_path(directory,true,true);
        const auto intent_path = QDir(directory).filePath("intent.json");
        write_receipt(intent_path,intent_json(result));
        const auto intent_bytes = read_receipt(intent_path);
        const auto recorded = intent_status(intent_bytes,result.operation_id,target_path);
        need(recorded.source == result.source && recorded.target == result.target &&
             recorded.mode == result.mode && recorded.seeds_internal_sites == result.seeds_internal_sites);
        detail::initialize_project_copy(target_path,target,result.target.store_uuid);
#ifdef LMTI_COPY_OWNER_TEST_HOOKS
        detail::copy_test_fail(detail::CopyTestFault::BeforeIndependentVerification);
#endif
        // This is a new, independent full read; errors after COMMIT remain an
        // unknown/recovery-required outcome, never a reason to replay the write.
        need(detail::capture_project_copy(target_path).token == result.target,ProjectCopyCode::TargetChanged);
        need(read_receipt(intent_path) == intent_bytes);
#ifdef LMTI_COPY_OWNER_TEST_HOOKS
        detail::copy_test_fail(detail::CopyTestFault::BeforeVerifiedReceipt);
#endif
        write_receipt(QDir(directory).filePath("verified.json"),verified_json(result,digest(intent_bytes)));
        result.verified_receipt = true;
        result.state = ProjectCopyState::Prepared; result.code = ProjectCopyCode::None;
    } catch (const ProjectCopyError &error) { result.code = error.code; }
      catch (const std::exception &) { result.code = ProjectCopyCode::OwnerUnavailable; }
    return result;
}
ProjectCopyStatus inspect_project_copy_operation(const QString &trusted_parent, const QString &operation_id) {
    need(uuid(operation_id),ProjectCopyCode::InvalidInput); // Reject tokens before any path probe.
    ProjectCopyStatus result;
    result.operation_id = operation_id;
    const auto parent = parent_path(trusted_parent);
    const auto directory = operation_path(parent,operation_id);
    try {
        detail::local_owner_path(directory,true,true);
        const auto target_path = QDir(directory).filePath("project.sqlite");
        const auto intent_path = QDir(directory).filePath("intent.json");
        const auto intent_bytes = read_receipt(intent_path);
        result = intent_status(intent_bytes,operation_id,target_path);
        const auto verified_path = QDir(directory).filePath("verified.json");
        QByteArray verified_bytes;
        if (QFileInfo::exists(verified_path) || QFileInfo(verified_path).isSymLink()) {
            verified_bytes = read_receipt(verified_path);
            const auto verified = detail::strict_json_object(verified_bytes,receipt_cap);
            fields(verified,{"schema","operationId","intentDigest","target"});
            need(verified["schema"] == "lmti.project.copy.verified.v1" && verified["operationId"] == operation_id &&
                 verified["intentDigest"] == digest(intent_bytes) && token(verified["target"]) == result.target);
            result.verified_receipt = true;
        }
        need(detail::capture_project_copy(target_path).token == result.target,ProjectCopyCode::TargetChanged);
        need(read_receipt(intent_path) == intent_bytes);
        if (!verified_bytes.isEmpty()) need(read_receipt(verified_path) == verified_bytes);
        // A missing final receipt can follow a committed copy and interrupted
        // verification. Independent current validation can report Prepared, but
        // inspection remains read-only and does not manufacture that receipt.
        result.state = ProjectCopyState::Prepared; result.code = ProjectCopyCode::None;
    } catch (const ProjectCopyError &error) { result.code = error.code; }
      catch (const std::exception &) { result.code = ProjectCopyCode::EvidenceInvalid; }
    return result;
}
ProjectCopyDiscovery discover_project_copies(const QString &trusted_parent) {
    ProjectCopyDiscovery result;
    QString lexical;
    try {
        lexical = detail::local_owner_path_lexical(trusted_parent);
        need(!QDir(lexical).isRoot(),ProjectCopyCode::InvalidInput);
        for (const auto &part : lexical.split('/'))
            need(part.compare(".lmti",Qt::CaseInsensitive) != 0,ProjectCopyCode::InvalidInput);
    } catch (const std::exception &) { result.code = ProjectCopyCode::InvalidInput; return result; }
    try {
        const auto parent = detail::local_owner_path(lexical,true,true);
        const auto native_parent = discovery_path(parent);
        std::error_code error;
        const auto before = std::filesystem::last_write_time(native_parent,error);
        if (error) return result;
        // directory_iterator streams immediate entries and reports open/increment
        // errors. No skip_permission_denied, recursion, sorting or eager stat.
        std::filesystem::directory_iterator current(native_parent,std::filesystem::directory_options::none,error);
        const std::filesystem::directory_iterator end;
        if (error) return result;
        bool unavailable = false;
        while (current != end) {
            ++result.examined_entries;
            if (result.examined_entries > max_project_copy_discovery_entries) {
                result.code = ProjectCopyCode::BudgetExceeded;
                return result; // Do not even parse the sentinel's filename.
            }
            const auto id = discovery_name(current->path());
            if (!uuid(id)) {
                // Invalid names do not authorize a child probe or escape the cap.
                ++result.unattributed_entries;
            } else {
                auto candidate = discovery_candidate(parent,id);
                if (!candidate.intent) ++result.unattributed_entries;
                unavailable |= candidate.state == ProjectCopyCandidateState::Unavailable;
                result.candidates.push_back(std::move(candidate));
            }
            current.increment(error);
            if (error) return result;
        }
        const auto after = std::filesystem::last_write_time(native_parent,error);
        if (error || before != after ||
            normalized(detail::local_owner_path(lexical,true,true)) != normalized(parent))
            return result;
        // Sorting only the bounded collected candidates has no filesystem effect.
        std::sort(result.candidates.begin(),result.candidates.end(),[](const auto &a,const auto &b) {
            return a.operation_id < b.operation_id;
        });
        result.complete = !unavailable;
        result.code = unavailable ? ProjectCopyCode::OwnerUnavailable : ProjectCopyCode::None;
    } catch (const std::exception &) { /* Preserve partial discovery as unavailable. */ }
    return result;
}
} // namespace lmti
