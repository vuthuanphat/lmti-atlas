#include "physical_hierarchy.hpp"
#include "project_operation_json.hpp"
#include "../common/local_owner_path.hpp"
#include "../common/strict_json.hpp"
#include "lmti/project_physical_hierarchy.hpp"
#include "lmti/project_store.hpp"
#include "lmti/project_original_read.hpp"
#include <QFile>
#include <QFileInfo>
#include <QJsonArray>
#include <QJsonDocument>
#include <QRegularExpression>
#include <QSet>
#include <QUuid>
#include <algorithm>
#include <array>
#include <cmath>
#include <cstdio>
#include <filesystem>
#include <optional>
#include <type_traits>
#ifdef Q_OS_WIN
#include <fcntl.h>
#include <io.h>
#endif

namespace {
namespace json = lmti::cli::project_operation_json;
constexpr qsizetype request_cap = 64 * 1024, response_cap = 512 * 1024;
constexpr qint64 safe_integer = 9007199254740991LL;
constexpr auto owner_schema = "lmti.physical-hierarchy.owner.v1";
constexpr auto token_schema = "lmti.physical-hierarchy.review.v1";
constexpr auto commit_action = "physical-hierarchy-commit";
enum class Code { None, InvalidInput, ScopeDenied, UnsupportedSchema, UnsupportedFormat,
    ConfigChanged, BudgetExceeded, OwnerUnavailable, RecoveryRequired, Count };
constexpr std::array code_names{"NONE", "INVALID_INPUT", "SCOPE_DENIED", "UNSUPPORTED_SCHEMA",
    "UNSUPPORTED_FORMAT", "CONFIG_CHANGED", "BUDGET_EXCEEDED", "OWNER_UNAVAILABLE", "RECOVERY_REQUIRED"};
enum class Phase { BeforeOwner, EnteredOwner, Confirmed };
struct Refused { Code code; };
void need(bool condition, Code code = Code::InvalidInput) { if (!condition) throw Refused{code}; }
Code code(lmti::PhysicalHierarchyCode value) noexcept {
    switch (value) {
    case lmti::PhysicalHierarchyCode::InvalidArgument: return Code::InvalidInput;
    case lmti::PhysicalHierarchyCode::ScopeDenied: return Code::ScopeDenied;
    case lmti::PhysicalHierarchyCode::Conflict: return Code::ConfigChanged;
    case lmti::PhysicalHierarchyCode::Unsupported: return Code::UnsupportedSchema;
    case lmti::PhysicalHierarchyCode::BudgetExceeded: return Code::BudgetExceeded;
    case lmti::PhysicalHierarchyCode::OwnerUnavailable: return Code::OwnerUnavailable;
    }
    return Code::OwnerUnavailable;
}
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
Code code(lmti::OriginalReadCode value) noexcept {
    switch (value) {
    case lmti::OriginalReadCode::InvalidInput: return Code::InvalidInput;
    case lmti::OriginalReadCode::ScopeDenied: return Code::ScopeDenied;
    case lmti::OriginalReadCode::ConfigChanged: return Code::ConfigChanged;
    case lmti::OriginalReadCode::OwnerUnavailable: return Code::OwnerUnavailable;
    case lmti::OriginalReadCode::NotSupported: return Code::UnsupportedSchema;
    case lmti::OriginalReadCode::LimitExceeded: return Code::BudgetExceeded;
    case lmti::OriginalReadCode::RecoveryRequired: return Code::RecoveryRequired;
    }
    return Code::OwnerUnavailable;
}
QString name(Code value) { return QString::fromLatin1(code_names[static_cast<std::size_t>(value)]); }
QString s(const std::string &value) { return QString::fromStdString(value); }
void fields(const QJsonObject &value, const QSet<QString> &expected) {
    need(value.size() == expected.size());
    for (auto it = value.begin(); it != value.end(); ++it) need(expected.contains(it.key()));
}
QJsonObject object(const QJsonValue &value) {
    need(value.isObject()); return value.toObject();
}
QJsonObject object(const QJsonObject &value, const char *field) { return object(value.value(field)); }
QString text(const QJsonObject &value, const char *field, qsizetype cap) {
    need(value.value(field).isString());
    const auto result = value.value(field).toString();
    need(result.isValidUtf16());
    need(result.toUtf8().size() <= cap);
    for (auto c : result) need(c.unicode() >= 32 && c.unicode() != 127);
    return result;
}
qint64 integer(const QJsonObject &value, const char *field, qint64 low, qint64 high) {
    need(value.value(field).isDouble());
    const auto number = value.value(field).toDouble();
    need(std::isfinite(number) && std::floor(number) == number && number >= low && number <= high);
    return static_cast<qint64>(number);
}
bool boolean(const QJsonObject &value, const char *field) {
    need(value.value(field).isBool()); return value.value(field).toBool();
}
QString checked_id(const QString &value, bool optional = false) {
    if (optional && value.isEmpty()) return value;
    try { lmti::validate_id(value.toStdString()); }
    catch (const std::exception &) { throw Refused{Code::InvalidInput}; }
    return value;
}
std::string id(const QJsonObject &value, const char *field, bool optional = false) {
    return checked_id(text(value, field, 64), optional).toStdString();
}
QString uuid(const QJsonObject &value, const char *field) {
    const auto result = text(value, field, 36); const QUuid parsed(result);
    need(!parsed.isNull() && parsed.toString(QUuid::WithoutBraces) == result); return result;
}
QString digest(const QJsonObject &value, const char *field) {
    const auto result = text(value, field, 64);
    need(QRegularExpression("^[0-9a-f]{64}$").match(result).hasMatch()); return result;
}
QString lexical(const QString &value) {
    // These characters are unsupported in local Windows owner components.
    for (auto c : value) need(!QStringLiteral("<>\"|?*").contains(c));
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
QString identity_path(const QJsonObject &value, const char *field) {
    // The owner limit is 1,024 QString code units, not UTF-8 bytes.
    const auto result = text(value, field, 4096);
    need(key(result) == result); return result;
}
lmti::Privacy privacy(const QJsonObject &value) {
    const auto result = text(value, "privacy", 8);
    need(result == "public" || result == "internal");
    return result == "public" ? lmti::Privacy::Public : lmti::Privacy::Internal;
}
QString privacy_json(lmti::Privacy value) {
    switch (value) {
    case lmti::Privacy::Public: return "public";
    case lmti::Privacy::Internal: return "internal";
    }
    throw Refused{Code::OwnerUnavailable};
}
lmti::Site site(const QJsonObject &v) {
    fields(v,{"id","label","privacy"});
    return {id(v,"id"),text(v,"label",120).toStdString(),privacy(v)};
}
lmti::Area area(const QJsonObject &v) {
    fields(v,{"id","label","siteId","parentAreaId","privacy"});
    return {id(v,"id"),text(v,"label",120).toStdString(),id(v,"siteId"),id(v,"parentAreaId",true),privacy(v)};
}
lmti::Environment environment(const QJsonObject &v) {
    fields(v,{"id","label","privacy"});
    return {id(v,"id"),text(v,"label",120).toStdString(),privacy(v)};
}
lmti::PhysicalAssetAnchor anchor(const QJsonObject &v) {
    fields(v,{"id","label","site","kind","privacy"});
    lmti::Kind kind;
    const auto k=text(v,"kind",8);
    if(k=="machine") kind=lmti::Kind::Machine;
    else if(k=="gateway") kind=lmti::Kind::Gateway;
    else if(k=="broker") kind=lmti::Kind::Broker;
    else if(k=="service") kind=lmti::Kind::Service;
    else if(k=="sensor") kind=lmti::Kind::Sensor;
    else throw Refused{Code::InvalidInput};
    return {id(v,"id"),text(v,"label",120).toStdString(),id(v,"site"),kind,privacy(v)};
}
std::optional<lmti::AssetPlacement> placement(const QJsonValue &raw) {
    if(raw.isNull())return std::nullopt;
    const auto v=object(raw);
    fields(v,{"assetId","areaId","parentAssetId","environmentId","role"});
    std::optional<lmti::PhysicalRole> role;
    if(!v.value("role").isNull()) {
        const auto r=text(v,"role",7);
        if(r=="host")role=lmti::PhysicalRole::Host;
        else if(r=="gateway")role=lmti::PhysicalRole::Gateway;
        else if(r=="device")role=lmti::PhysicalRole::Device;
        else throw Refused{Code::InvalidInput};
    }
    return lmti::AssetPlacement{id(v,"assetId"),id(v,"areaId",true),id(v,"parentAssetId",true),
        id(v,"environmentId",true),role};
}
lmti::PhysicalHierarchyProposal proposal(const QJsonObject &v) {
    fields(v,{"projectId","expectedRevision","changes"});
    lmti::PhysicalHierarchyProposal result{id(v,"projectId"),integer(v,"expectedRevision",1,safe_integer-1),{}};
    need(v.value("changes").isArray());
    const auto changes=v.value("changes").toArray();
    need(!changes.isEmpty());
    need(changes.size()<=static_cast<qsizetype>(lmti::max_physical_hierarchy_changes),Code::BudgetExceeded);
    for(const auto &raw:changes) {
        const auto c=object(raw);const auto k=text(c,"kind",32);
        if(k=="add_site") {fields(c,{"kind","desired"});result.changes.emplace_back(lmti::AddSite{site(object(c,"desired"))});}
        else if(k=="rename_site") {fields(c,{"kind","expected","desiredLabel"});result.changes.emplace_back(
            lmti::RenameSite{site(object(c,"expected")),text(c,"desiredLabel",120).toStdString()});}
        else if(k=="retire_empty_site") {fields(c,{"kind","expected"});result.changes.emplace_back(lmti::RetireEmptySite{site(object(c,"expected"))});}
        else if(k=="add_area") {fields(c,{"kind","desired"});result.changes.emplace_back(lmti::AddArea{area(object(c,"desired"))});}
        else if(k=="rename_area") {fields(c,{"kind","expected","desiredLabel"});result.changes.emplace_back(
            lmti::RenameArea{area(object(c,"expected")),text(c,"desiredLabel",120).toStdString()});}
        else if(k=="reparent_area") {fields(c,{"kind","expected","desiredParentId"});result.changes.emplace_back(
            lmti::ReparentArea{area(object(c,"expected")),id(c,"desiredParentId",true)});}
        else if(k=="retire_empty_area") {fields(c,{"kind","expected"});result.changes.emplace_back(lmti::RetireEmptyArea{area(object(c,"expected"))});}
        else if(k=="add_environment") {fields(c,{"kind","desired"});result.changes.emplace_back(lmti::AddEnvironment{environment(object(c,"desired"))});}
        else if(k=="rename_environment") {fields(c,{"kind","expected","desiredLabel"});result.changes.emplace_back(
            lmti::RenameEnvironment{environment(object(c,"expected")),text(c,"desiredLabel",120).toStdString()});}
        else if(k=="retire_empty_environment") {fields(c,{"kind","expected"});result.changes.emplace_back(
            lmti::RetireEmptyEnvironment{environment(object(c,"expected"))});}
        else if(k=="set_asset_placement") {fields(c,{"kind","expectedAsset","expected","desired"});result.changes.emplace_back(
            lmti::SetAssetPlacement{anchor(object(c,"expectedAsset")),placement(c.value("expected")),placement(c.value("desired"))});}
        else throw Refused{Code::InvalidInput};
    }
    return result;
}
QJsonObject row_json(const lmti::Site &v) {
    return {{"id",s(v.id)},{"label",s(v.label)},{"privacy",privacy_json(v.privacy)}};
}
QJsonObject row_json(const lmti::Environment &v) {
    return {{"id",s(v.id)},{"label",s(v.label)},{"privacy",privacy_json(v.privacy)}};
}
QJsonObject row_json(const lmti::Area &v) {
    return {{"id",s(v.id)},{"label",s(v.label)},{"siteId",s(v.site_id)},
        {"parentAreaId",s(v.parent_area_id)},{"privacy",privacy_json(v.privacy)}};
}
QJsonObject row_json(const lmti::PhysicalAssetAnchor &v) {
    return {{"id",s(v.id)},{"label",s(v.label)},{"site",s(v.site)},
        {"kind",s(lmti::name(v.kind))},{"privacy",privacy_json(v.privacy)}};
}
QJsonObject row_json(const lmti::AssetPlacement &v) {
    return {{"assetId",s(v.asset_id)},{"areaId",s(v.area_id)},{"parentAssetId",s(v.parent_asset_id)},
        {"environmentId",s(v.environment_id)},{"role",v.role?QJsonValue(s(lmti::name(*v.role))):QJsonValue(QJsonValue::Null)}};
}
template<class T> QJsonValue nullable(const std::optional<T> &v) {
    return v?QJsonValue(row_json(*v)):QJsonValue(QJsonValue::Null);
}
QJsonValue nullable(const std::optional<lmti::Privacy> &v) {
    return v?QJsonValue(privacy_json(*v)):QJsonValue(QJsonValue::Null);
}
QJsonArray strings(const std::vector<std::string> &values) {
    QJsonArray result;for(const auto &v:values)result.append(s(v));return result;
}
QJsonObject path_json(const lmti::PhysicalHierarchyPath &v) {
    return {{"siteId",s(v.site_id)},{"areaAncestors",strings(v.area_ancestors)},
        {"assetAncestors",strings(v.asset_ancestors)},{"environmentId",s(v.environment_id)}};
}
QJsonObject proposal_json(const lmti::PhysicalHierarchyProposal &v) {
    QJsonArray changes;
    for(const auto &change:v.changes)changes.append(std::visit([](const auto &op)->QJsonObject {
        using T=std::decay_t<decltype(op)>;
        if constexpr(std::is_same_v<T,lmti::AddSite>)return {{"kind","add_site"},{"desired",row_json(op.desired)}};
        else if constexpr(std::is_same_v<T,lmti::RenameSite>)return {{"kind","rename_site"},{"expected",row_json(op.expected)},{"desiredLabel",s(op.desired_label)}};
        else if constexpr(std::is_same_v<T,lmti::RetireEmptySite>)return {{"kind","retire_empty_site"},{"expected",row_json(op.expected)}};
        else if constexpr(std::is_same_v<T,lmti::AddArea>)return {{"kind","add_area"},{"desired",row_json(op.desired)}};
        else if constexpr(std::is_same_v<T,lmti::RenameArea>)return {{"kind","rename_area"},{"expected",row_json(op.expected)},{"desiredLabel",s(op.desired_label)}};
        else if constexpr(std::is_same_v<T,lmti::ReparentArea>)return {{"kind","reparent_area"},{"expected",row_json(op.expected)},{"desiredParentId",s(op.desired_parent_id)}};
        else if constexpr(std::is_same_v<T,lmti::RetireEmptyArea>)return {{"kind","retire_empty_area"},{"expected",row_json(op.expected)}};
        else if constexpr(std::is_same_v<T,lmti::AddEnvironment>)return {{"kind","add_environment"},{"desired",row_json(op.desired)}};
        else if constexpr(std::is_same_v<T,lmti::RenameEnvironment>)return {{"kind","rename_environment"},{"expected",row_json(op.expected)},{"desiredLabel",s(op.desired_label)}};
        else if constexpr(std::is_same_v<T,lmti::RetireEmptyEnvironment>)return {{"kind","retire_empty_environment"},{"expected",row_json(op.expected)}};
        else return {{"kind","set_asset_placement"},{"expectedAsset",row_json(op.expected_asset)},
            {"expected",nullable(op.expected)},{"desired",nullable(op.desired)}};
    },change));
    return {{"projectId",s(v.project_id)},{"expectedRevision",v.expected_revision},{"changes",changes}};
}
template<class T> QJsonArray catalog_changes(const std::vector<T> &values) {
    QJsonArray result;for(const auto &v:values)result.append(QJsonObject{
        {"id",s(v.id)},{"before",nullable(v.before)},{"after",nullable(v.after)}});
    return result;
}
QJsonObject diff_json(const lmti::PhysicalHierarchyDiff &v) {
    QJsonArray placements,affected;
    for(const auto &r:v.placements)placements.append(QJsonObject{
        {"assetId",s(r.asset_id)},{"before",nullable(r.before)},{"after",nullable(r.after)}});
    for(const auto &r:v.affected) {
        QString kind;
        switch(r.kind) {
        case lmti::PhysicalHierarchyEntityKind::Site:kind="site";break;
        case lmti::PhysicalHierarchyEntityKind::Area:kind="area";break;
        case lmti::PhysicalHierarchyEntityKind::Environment:kind="environment";break;
        case lmti::PhysicalHierarchyEntityKind::Asset:kind="asset";break;
        default:throw Refused{Code::OwnerUnavailable};
        }
        affected.append(QJsonObject{{"kind",kind},{"id",s(r.id)},
            {"beforeClassification",nullable(r.before_classification)},{"afterClassification",nullable(r.after_classification)},
            {"beforePath",path_json(r.before_path)},{"afterPath",path_json(r.after_path)}});
    }
    return {{"sites",catalog_changes(v.sites)},{"areas",catalog_changes(v.areas)},
        {"environments",catalog_changes(v.environments)},{"placements",placements},{"affected",affected}};
}
QJsonObject projection_json(const lmti::PhysicalHierarchyProjection &v) {
    QJsonArray sites,areas,environments,assets;
    for(const auto &r:v.sites)sites.append(QJsonObject{{"value",row_json(r.value)},{"classification",privacy_json(r.classification)}});
    for(const auto &r:v.areas)areas.append(QJsonObject{{"value",row_json(r.value)},{"ancestors",strings(r.ancestors)},
        {"classification",privacy_json(r.classification)}});
    for(const auto &r:v.environments)environments.append(QJsonObject{{"value",row_json(r.value)},{"classification",privacy_json(r.classification)}});
    for(const auto &r:v.assets)assets.append(QJsonObject{{"value",row_json(r.value)},{"placement",nullable(r.placement)},
        {"path",path_json(r.path)},{"classification",privacy_json(r.classification)}});
    return {{"projectId",s(v.project_id)},{"revision",v.revision},{"sites",sites},{"areas",areas},
        {"environments",environments},{"assets",assets}};
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
lmti::PhysicalHierarchyReviewToken review_token(const QJsonObject &value, const lmti::PhysicalHierarchyScope &scope) {
    fields(value, {"schema", "schemaVersion", "projectId", "canonicalPath", "storeUuid", "revision",
        "contentDigest", "registryDigest", "scope", "proposal", "proposalDigest", "diffDigest"});
    need(text(value, "schema", 64) == QLatin1String(token_schema));
    lmti::PhysicalHierarchyReviewToken result;
    result.snapshot.schema = static_cast<int>(integer(value, "schemaVersion", 2, 2));
    result.snapshot.project_id = s(id(value, "projectId"));
    result.snapshot.canonical_path = identity_path(value, "canonicalPath");
    result.snapshot.store_uuid = uuid(value, "storeUuid");
    result.snapshot.revision = integer(value, "revision", 1, safe_integer - 2);
    result.snapshot.content_digest = digest(value, "contentDigest");
    result.snapshot.registry_digest = digest(value, "registryDigest");
    const auto supplied_scope = object(value, "scope");
    fields(supplied_scope, {"projectId", "allowPhysicalWrite", "allowInternal"});
    result.scope = {id(supplied_scope, "projectId"), boolean(supplied_scope, "allowPhysicalWrite"),
        boolean(supplied_scope, "allowInternal")};
    need(result.scope == scope && result.snapshot.project_id == s(scope.project_id), Code::ScopeDenied);
    result.proposal = proposal(object(value, "proposal"));
    need(result.proposal == lmti::normalize_physical_hierarchy_proposal(scope, result.proposal));
    need(result.proposal.project_id == scope.project_id &&
         result.proposal.expected_revision == result.snapshot.revision);
    result.proposal_digest = digest(value, "proposalDigest"); result.diff_digest = digest(value, "diffDigest");
    return result;
}
QJsonObject review_json(const lmti::PhysicalHierarchyReviewToken &value) {
    need(value.version == 1 && value.domain == QLatin1String(token_schema) && value.snapshot.schema == 2, Code::OwnerUnavailable);
    auto result = json::token_json(value.snapshot);
    result["schema"] = QLatin1String(token_schema);
    result["scope"] = QJsonObject{{"projectId", s(value.scope.project_id)}, {"allowPhysicalWrite", value.scope.allow_physical_write},
        {"allowInternal", value.scope.allow_internal}};
    result["proposal"] = proposal_json(value.proposal);
    result["proposalDigest"] = value.proposal_digest; result["diffDigest"] = value.diff_digest;
    return result;
}
struct Launch { QString library; lmti::PhysicalHierarchyScope scope; };
Launch launch(const QStringList &args, bool write) {
    need(args.size() == 8 && args[1] == (write ? "--physical-hierarchy-write" : "--physical-hierarchy-read") &&
        args[2] == "--library" && args[4] == "--project" && args[6] == "--visibility");
    need(args[7] == "public" || args[7] == "internal");
    return {lexical(args[3]), {checked_id(args[5]).toStdString(), true, args[7] == "internal"}};
}
QByteArray read_request() {
#ifdef Q_OS_WIN
    const auto descriptor = _fileno(stdin);
    need(descriptor >= 0 && _setmode(descriptor, _O_BINARY) != -1);
#endif
    QByteArray bytes(request_cap + 1, Qt::Uninitialized);
    const auto count = std::fread(bytes.data(), 1, static_cast<std::size_t>(bytes.size()), stdin);
    need(std::ferror(stdin) == 0 && count <= static_cast<std::size_t>(request_cap) && std::feof(stdin) != 0);
    bytes.resize(static_cast<qsizetype>(count)); return bytes;
}
QJsonObject request() {
    const auto bytes = read_request();
    try { return lmti::detail::strict_json_object(bytes, request_cap); }
    catch (const std::exception &) { throw Refused{Code::InvalidInput}; }
}
QByteArray frame(const QJsonObject &value) { return QJsonDocument(value).toJson(QJsonDocument::Compact) + '\n'; }
void single_link(const QString &path) {
    std::error_code error;
#ifdef Q_OS_WIN
    const auto native = std::filesystem::path(path.toStdWString());
#else
    const auto native = std::filesystem::path(path.toStdString());
#endif
    const auto count = std::filesystem::hard_link_count(native, error);
    need(!error && count == 1, Code::OwnerUnavailable);
}
lmti::LibraryInspection library_view(const QString &path) {
    // This boundary requires an unaliased selected library too. Keep the
    // general library owner unchanged; every fresh inspection/recheck here
    // validates main and existing sidecars before opening SQLite.
    try {
        const auto canonical = lmti::detail::local_owner_path(path);
        single_link(canonical);
        for (const auto *suffix : {"-wal", "-shm", "-journal"}) {
            const auto sidecar = lmti::detail::local_owner_path(
                canonical + QString::fromLatin1(suffix), false);
            if (QFileInfo::exists(sidecar)) single_link(sidecar);
        }
    }
    catch (const std::exception &) { throw Refused{Code::OwnerUnavailable}; }
    return lmti::inspect_project_library(path);
}
lmti::LibraryEntry selected_entry(const lmti::LibraryInspection &view, const std::string &project) {
    const auto found = std::find_if(view.entries.begin(), view.entries.end(),
        [&](const auto &row) { return row.id == s(project); });
    need(found != view.entries.end(), Code::ScopeDenied); return *found;
}
void recheck(const Launch &fixed, const lmti::LibraryInspection &before, const lmti::LibraryEntry &entry) {
    const auto current = library_view(fixed.library);
    need(current.token == before.token, Code::ConfigChanged);
    const auto found = std::find_if(current.entries.begin(), current.entries.end(),
        [&](const auto &row) { return row.id == entry.id; });
    need(found != current.entries.end() && found->path == entry.path && found->folder == entry.folder,
        Code::ConfigChanged);
}
QString original_decimal(const QJsonObject &value,const char *field,bool positive) {
    const auto result = text(value,field,40);
    need(!result.isEmpty() && (result.size() == 1 || result[0] != '0') && (!positive || result != "0"));
    for (const auto c : result) need(c >= '0' && c <= '9');
    return result; // Exact DWORD/uint64/FILETIME bounds are checked by the owner.
}
lmti::OriginalPhysicalTarget original_physical(const QJsonObject &value) {
    fields(value,{"version","path","kind","state","chain"});
    need(integer(value,"version",1,1) == 1 && text(value,"kind",9) == "file");
    const auto state = text(value,"state",11);
    need(state == "present" || state == "missing" || state == "unsupported");
    lmti::OriginalPhysicalTarget result;
    result.path = lexical(text(value,"path",4096));
    need(value.value("chain").isArray());
    const auto chain = value.value("chain").toArray();
    need(chain.size() <= 64,Code::BudgetExceeded);
    bool available = state == "present";
    for (const auto &item : chain) {
        if (item.isNull()) { available = false; continue; }
        const auto row = object(item);
        fields(row,{"dev","ino","birthtimeNs"});
        result.chain.push_back({original_decimal(row,"dev",false),original_decimal(row,"ino",true),
                               original_decimal(row,"birthtimeNs",true)});
    }
    need(available,Code::RecoveryRequired);
    return result;
}
lmti::OriginalPhysicalHierarchyExpected original_expected(const QJsonObject &value) {
    fields(value,{"version","projectId","library","project","linkedRoot"});
    need(integer(value,"version",1,1) == 1);
    lmti::OriginalPhysicalHierarchyExpected result;
    result.project_id = id(value,"projectId");
    const auto library = object(value,"library");
    fields(library,{"schema","canonicalPath","uuid","physical"});
    result.library.schema = static_cast<int>(integer(library,"schema",1,3));
    result.library.canonical_path = lexical(text(library,"canonicalPath",4096));
    if (result.library.schema == 1) need(library.value("uuid").isNull());
    else result.library.uuid = uuid(library,"uuid");
    result.library.physical = original_physical(object(library,"physical"));
    const auto project = object(value,"project");
    fields(project,{"schema","storeUuid","physical"});
    result.project.schema = static_cast<int>(integer(project,"schema",2,2));
    result.project.store_uuid = uuid(project,"storeUuid");
    result.project.physical = original_physical(object(project,"physical"));
    const auto root = text(value,"linkedRoot",4096);
    result.linked_root = root.isEmpty() ? root : lexical(root);
    return result;
}
QJsonObject execute_read(const Launch &fixed, const QJsonObject &value) {
    const auto action = text(value, "action", 48);
    if (action == "physical-hierarchy-locator") {
        fields(value,{"action"});
        const auto before = library_view(fixed.library);
        const auto entry = selected_entry(before,fixed.scope.project_id);
        // Selected-row metadata only. Do not probe the referenced project,
        // linked root or any profile store. The later conditional read closes
        // the interval between this catalog observation and physical capture.
        recheck(fixed,before,entry);
        return {{"ok",true},{"schema",QLatin1String(owner_schema)},{"action",action},
            {"libraryIdentity",json::library_json(before.token)},
            {"projectId",s(fixed.scope.project_id)},{"database",entry.path},{"linkedRoot",entry.folder}};
    }
    if (action == "physical-hierarchy-original-state") {
        fields(value,{"action","expected"});
        const auto expected = original_expected(object(value,"expected"));
        // No preliminary library/project open; the conditional owner checks the
        // original selected locator and physical pins before graph content.
        const auto result = lmti::read_original_physical_hierarchy_state(fixed.library,fixed.scope,expected);
        return {{"ok",true},{"schema",QLatin1String(owner_schema)},{"action",action},
            {"libraryIdentity",json::library_json(result.library)},
            {"projectIdentity",json::token_json(result.state.snapshot)},
            {"projection",projection_json(result.state.projection)}};
    }
    std::optional<lmti::PhysicalHierarchyProposal> desired;
    if (action == "physical-hierarchy-preview") {
        fields(value, {"action", "proposal"});
        desired = lmti::normalize_physical_hierarchy_proposal(fixed.scope, proposal(object(value, "proposal")));
    } else { need(action == "physical-hierarchy-state"); fields(value, {"action"}); }
    // Every request field is now validated. Only the selected library row is a
    // source of path authority; linked roots and token paths are never opened.
    const auto before = library_view(fixed.library);
    const auto entry = selected_entry(before, fixed.scope.project_id);
    QJsonObject result{{"ok", true}, {"schema", QLatin1String(owner_schema)}, {"action", action}};
    if (desired) {
        const auto review = lmti::preview_physical_hierarchy(entry.path, fixed.scope, *desired);
        const auto token = lmti::export_physical_hierarchy_review(review);
        const QJsonObject expected{{"libraryIdentity", json::library_json(before.token)}, {"reviewToken", review_json(token)}};
        // A full emitted review must be submit-able in the fixed write budget.
        need(frame(QJsonObject{{"action", QLatin1String(commit_action)}, {"expected", expected}}).size() <= request_cap,
            Code::BudgetExceeded);
        result["expected"] = expected; result["diff"] = diff_json(review.diff());
    } else {
        const auto state = lmti::inspect_physical_hierarchy(entry.path, fixed.scope);
        result["libraryIdentity"] = json::library_json(before.token);
        result["projectIdentity"] = json::token_json(state.snapshot);
        result["projection"] = projection_json(state.projection);
    }
    recheck(fixed, before, entry);
    return result;
}
QJsonObject envelope(const char *outcome, Code value,
                     const QJsonValue &details = QJsonValue(QJsonValue::Null)) {
    return {{"schema", "lmti.project.operation.write.v1"}, {"action", QLatin1String(commit_action)},
        {"outcome", outcome}, {"code", name(value)}, {"operationId", QJsonValue(QJsonValue::Null)},
        {"details", details}, {"detailsAvailable", !details.isNull()}};
}
struct Frames {
    std::array<QByteArray, static_cast<std::size_t>(Code::Count)> refused, unknown;
    QByteArray confirmed;
    Frames() {
        for (std::size_t i = 1; i < refused.size(); ++i) {
            refused[i] = frame(envelope("refused", static_cast<Code>(i)));
            unknown[i] = frame(envelope("unknown", static_cast<Code>(i)));
        }
        confirmed = frame(envelope("confirmed", Code::None));
    }
    const QByteArray &fallback(Phase phase, Code value) const noexcept {
        if (phase == Phase::Confirmed) return confirmed;
        const auto index = static_cast<std::size_t>(value == Code::None ? Code::OwnerUnavailable : value);
        return phase == Phase::BeforeOwner ? refused[index] : unknown[index];
    }
};
enum class Fault { None, BeforeOwner, EnteredOwner, AfterConfirmed };
Fault test_fault() {
#ifdef LMTI_PHYSICAL_HIERARCHY_FACADE_TESTING
    const auto value = qgetenv("LMTI_PHYSICAL_HIERARCHY_FACADE_FAULT");
#ifdef LMTI_PHYSICAL_HIERARCHY_OWNER_TEST_HOOKS
    if (value == "during_rewrite")
        lmti::set_physical_hierarchy_owner_test_hook(+[](lmti::PhysicalHierarchyOwnerTestPoint point) {
            if (point == lmti::PhysicalHierarchyOwnerTestPoint::DuringRowRewrite) throw lmti::Error("Isolated physical hierarchy fault.");
        });
    else if (value == "before_commit")
        lmti::set_physical_hierarchy_owner_test_hook(+[](lmti::PhysicalHierarchyOwnerTestPoint point) {
            if (point == lmti::PhysicalHierarchyOwnerTestPoint::BeforeCommit) throw lmti::Error("Isolated hierarchy fault.");
        });
    else if (value == "after_commit")
        lmti::set_physical_hierarchy_owner_test_hook(+[](lmti::PhysicalHierarchyOwnerTestPoint point) {
            if (point == lmti::PhysicalHierarchyOwnerTestPoint::AfterCommit) throw lmti::Error("Isolated hierarchy fault.");
        });
#endif
    if (value == "before_owner") return Fault::BeforeOwner;
    if (value == "entered_owner") return Fault::EnteredOwner;
    if (value == "after_confirmed") return Fault::AfterConfirmed;
#endif
    return Fault::None;
}
QByteArray execute_write(const Launch &fixed, const QJsonObject &value, Phase &phase) {
    fields(value, {"action", "expected"});
    const auto expected = object(value, "expected");
    fields(expected, {"libraryIdentity", "reviewToken"});
    const auto library = library_token(object(expected, "libraryIdentity"));
    const auto token = review_token(object(expected, "reviewToken"), fixed.scope);
    need(key(fixed.library) == library.canonical_path, Code::ConfigChanged);
    // Complete the success response before any owner effect. No post-commit
    // serialization, source reload or library recheck can demote known success.
    const auto confirmed = frame(envelope("confirmed", Code::None, QJsonObject{
        {"projectId", token.snapshot.project_id}, {"storeUuid", token.snapshot.store_uuid},
        {"previousRevision", token.snapshot.revision}, {"revision", token.snapshot.revision + 1},
        {"proposalDigest", token.proposal_digest}}));
    need(confirmed.size() <= response_cap, Code::BudgetExceeded);
    const auto before = library_view(fixed.library);
    need(before.token == library, Code::ConfigChanged);
    const auto entry = selected_entry(before, fixed.scope.project_id);
    need(key(entry.path) == token.snapshot.canonical_path, Code::ConfigChanged);
    auto review = lmti::restore_physical_hierarchy_review(entry.path, fixed.scope, token);
    recheck(fixed, before, entry);
    const auto fault = test_fault();
    if (fault == Fault::BeforeOwner) throw Refused{Code::OwnerUnavailable};
    phase = Phase::EnteredOwner;
    if (fault == Fault::EnteredOwner) throw Refused{Code::OwnerUnavailable};
    const auto result = lmti::commit_physical_hierarchy(entry.path, fixed.scope, review);
    if (result.state != lmti::PhysicalHierarchyCommitState::Committed) throw Refused{Code::RecoveryRequired};
    phase = Phase::Confirmed; // Latch immediately, before any fallible follow-up.
    if (fault == Fault::AfterConfirmed) throw Refused{Code::OwnerUnavailable};
    return confirmed;
}
} // namespace

int physical_hierarchy_main(const QStringList &arguments) {
#ifdef Q_OS_WIN
    const auto descriptor = _fileno(stdout);
    if (descriptor < 0 || _setmode(descriptor, _O_BINARY) == -1) return 1;
#endif
    QFile output;
    if (!output.open(stdout, QIODevice::WriteOnly)) return 1;
    const bool write = arguments.size() > 1 && arguments[1] == "--physical-hierarchy-write";
    if (!write) {
        QJsonObject result;
        try {
            const auto fixed = launch(arguments, false);
            result = execute_read(fixed, request());
        } catch (const Refused &error) { result = {{"ok", false}, {"code", name(error.code)}}; }
          catch (const lmti::OriginalReadError &error) { result = {{"ok", false}, {"code", name(code(error.code))}}; }
          catch (const lmti::PhysicalHierarchyError &error) { result = {{"ok", false}, {"code", name(code(error.code()))}}; }
          catch (const lmti::LibraryError &error) { result = {{"ok", false}, {"code", name(code(error.code))}}; }
          catch (const std::exception &) { result = {{"ok", false}, {"code", "OWNER_UNAVAILABLE"}}; }
        auto bytes = frame(result);
        if (bytes.size() > response_cap)
            bytes = QByteArrayLiteral("{\"ok\":false,\"code\":\"BUDGET_EXCEEDED\"}\n");
        return output.write(bytes) == bytes.size() && output.flush() ? 0 : 1;
    }
    const QByteArray invalid = QByteArrayLiteral(
        "{\"schema\":\"lmti.project.operation.write.v1\",\"action\":null,\"outcome\":\"refused\","
        "\"code\":\"INVALID_INPUT\",\"operationId\":null,\"details\":null,\"detailsAvailable\":false}\n");
    std::optional<Frames> frames;
    Phase phase = Phase::BeforeOwner;
    Code outcome = Code::OwnerUnavailable;
    QByteArray bytes;
    try {
        const auto value = request();
        need(text(value, "action", 48) == QLatin1String(commit_action));
        try { frames.emplace(); } catch (const std::exception &) { return 1; }
        const auto fixed = launch(arguments, true);
        bytes = execute_write(fixed, value, phase);
    } catch (const Refused &error) { if (phase != Phase::Confirmed) outcome = error.code; }
      catch (const lmti::PhysicalHierarchyError &error) { if (phase != Phase::Confirmed) outcome = code(error.code()); }
      catch (const lmti::LibraryError &error) { if (phase != Phase::Confirmed) outcome = code(error.code); }
      catch (const std::exception &) { if (phase != Phase::Confirmed) outcome = Code::OwnerUnavailable; }
    const auto &response = !bytes.isEmpty() ? bytes : frames ? frames->fallback(phase, outcome) : invalid;
    return output.write(response) == response.size() && output.flush() ? 0 : 1;
}
