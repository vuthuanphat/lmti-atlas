#include "project_upgrade_recovery.hpp"
#include "project_operation_json.hpp"
#include "../common/strict_json.hpp"
#include <QFile>
#include <QJsonArray>
#include <QJsonDocument>
#include <QRegularExpression>
#include <QSet>
#include <QUuid>
#include <cmath>
#include <cstdio>
#ifdef Q_OS_WIN
#include <fcntl.h>
#include <io.h>
#endif

namespace {
namespace json = lmti::cli::project_operation_json;
constexpr qsizetype request_cap = 32*1024, response_cap = 512*1024;
struct Refused {};
void need(bool value) { if (!value) throw Refused{}; }
void fields(const QJsonObject &object,const QSet<QString> &keys) {
    need(object.size() == keys.size());
    for (auto i=object.begin(); i!=object.end(); ++i) need(keys.contains(i.key()));
}
QJsonObject object(const QJsonObject &parent,const char *name) {
    need(parent.value(name).isObject()); return parent.value(name).toObject();
}
QString text(const QJsonObject &parent,const char *name,qsizetype cap) {
    need(parent.value(name).isString()); const auto value=parent.value(name).toString();
    need(value.toUtf8().size() <= cap);
    for (qsizetype i=0; i<value.size(); ++i) {
        const auto c=value[i];
        need(c.unicode() >= 32 && c.unicode() != 127);
        if (c.isHighSurrogate()) { need(i+1<value.size() && value[i+1].isLowSurrogate()); ++i; }
        else need(!c.isLowSurrogate());
    }
    return value;
}
qint64 integer(const QJsonObject &parent,const char *name,qint64 minimum,qint64 maximum) {
    need(parent.value(name).isDouble()); const auto value=parent.value(name).toDouble();
    need(std::isfinite(value) && std::floor(value)==value && value>=minimum && value<=maximum);
    return static_cast<qint64>(value);
}
QString digest(const QJsonObject &parent,const char *name) {
    const auto value=text(parent,name,64);
    need(QRegularExpression("^[0-9a-f]{64}$").match(value).hasMatch()); return value;
}
lmti::LibraryFormatPreview expected(const QJsonObject &request) {
    fields(request,{"action","expected"});
    need(text(request,"action",32) == "library-upgrade-recovery");
    const auto preview=object(request,"expected"); fields(preview,{"source","fullSnapshotDigest"});
    const auto source=object(preview,"source");
    fields(source,{"schema","canonicalPath","uuid","generation","digest"});
    lmti::LibraryFormatPreview result;
    result.source.schema=static_cast<int>(integer(source,"schema",1,2));
    result.source.canonical_path=text(source,"canonicalPath",4096);
    result.source.digest=digest(source,"digest");
    result.full_snapshot_digest=digest(preview,"fullSnapshotDigest");
    if (result.source.schema==1) {
        need(source.value("uuid").isNull() && source.value("generation").isNull());
        need(result.source.digest==result.full_snapshot_digest);
    } else {
        result.source.library_uuid=text(source,"uuid",36);
        const QUuid id(result.source.library_uuid);
        need(!id.isNull() && id.toString(QUuid::WithoutBraces)==result.source.library_uuid);
        result.source.generation=integer(source,"generation",1,9007199254740991LL);
    }
    return result;
}
QByteArray read_request() {
#ifdef Q_OS_WIN
    const auto descriptor=_fileno(stdin);
    need(descriptor>=0 && _setmode(descriptor,_O_BINARY)!=-1);
#endif
    QByteArray bytes(request_cap+1,Qt::Uninitialized);
    const auto count=std::fread(bytes.data(),1,static_cast<size_t>(bytes.size()),stdin);
    need(std::ferror(stdin)==0 && count<=static_cast<size_t>(request_cap) && std::feof(stdin)!=0);
    bytes.resize(static_cast<qsizetype>(count)); return bytes;
}
QString observation_state(lmti::LibraryBackupObservationState state) {
    switch (state) {
    case lmti::LibraryBackupObservationState::Verified: return "verified";
    case lmti::LibraryBackupObservationState::Incomplete: return "incomplete";
    case lmti::LibraryBackupObservationState::Invalid: return "invalid";
    case lmti::LibraryBackupObservationState::Foreign: return "foreign";
    case lmti::LibraryBackupObservationState::Unavailable: return "unavailable";
    }
    throw lmti::Error("Recovery state unavailable.");
}
QString receipt_match(lmti::LibraryBackupReceiptMatch match) {
    switch (match) {
    case lmti::LibraryBackupReceiptMatch::None: return "none";
    case lmti::LibraryBackupReceiptMatch::UpgradeV1: return "upgrade_v1";
    case lmti::LibraryBackupReceiptMatch::UpgradeV2: return "upgrade_v2";
    }
    throw lmti::Error("Recovery state unavailable.");
}
QString condition(lmti::LibraryUpgradeRecoveryCondition value) {
    switch (value) {
    case lmti::LibraryUpgradeRecoveryCondition::OriginalStateVerified: return "original_state_verified";
    case lmti::LibraryUpgradeRecoveryCondition::CommittedStateVerified: return "committed_state_verified";
    case lmti::LibraryUpgradeRecoveryCondition::Unresolved: return "unresolved";
    }
    throw lmti::Error("Recovery state unavailable.");
}
QJsonValue optional_text(const std::optional<QString> &value) {
    return value ? QJsonValue(*value) : QJsonValue(QJsonValue::Null);
}
QJsonValue digest_or_null(const QString &value) {
    return value.isEmpty() ? QJsonValue(QJsonValue::Null) : QJsonValue(value);
}
QJsonObject data(const lmti::LibraryUpgradeRecovery &value) {
    QJsonArray artifacts;
    for (const auto &row : value.artifacts) {
        artifacts.append(QJsonObject{{"artifactKey",row.artifact_key},
            {"operationId",optional_text(row.operation_id)},
            {"schema",row.schema ? QJsonValue(*row.schema) : QJsonValue(QJsonValue::Null)},
            {"fullSnapshotDigest",optional_text(row.full_snapshot_digest)},
            {"state",observation_state(row.state)},{"receiptMatch",receipt_match(row.receipt_match)},
            {"matchesExpected",row.matches_expected}});
    }
    return {{"condition",condition(value.condition)},{"code",json::library_code(value.code)},
        {"complete",value.complete},{"examinedEntries",static_cast<qint64>(value.examined_entries)},
        {"unresolvedEntries",static_cast<qint64>(value.unresolved_entries)},
        {"current",value.current ? QJsonValue(json::library_json(*value.current)) : QJsonValue(QJsonValue::Null)},
        {"currentSnapshotDigest",digest_or_null(value.current_snapshot_digest)},
        {"parentSnapshotDigest",digest_or_null(value.parent_snapshot_digest)},
        {"committedOperationId",optional_text(value.committed_operation_id)},{"artifacts",artifacts}};
}
QJsonObject execute(const QStringList &arguments,const QByteArray &bytes) {
    need(arguments.size()==6 && arguments[1]=="--project-operation-recovery" &&
         arguments[2]=="--library" && arguments[4]=="--backup-parent");
    QJsonObject request;
    try { request=lmti::detail::strict_json_object(bytes,request_cap); }
    catch (const std::exception &) { throw Refused{}; }
    const auto preview=expected(request);
    const auto result=lmti::inspect_library_upgrade_recovery(arguments[3],arguments[5],preview);
    return {{"ok",true},{"schema","lmti.project.upgrade-recovery.v1"},
        {"action","library-upgrade-recovery"},{"data",data(result)}};
}
} // namespace

int project_upgrade_recovery_main(const QStringList &arguments) {
#ifdef Q_OS_WIN
    const auto descriptor=_fileno(stdout);
    if (descriptor<0 || _setmode(descriptor,_O_BINARY)==-1) return 1;
#endif
    QFile output; if (!output.open(stdout,QIODevice::WriteOnly)) return 1;
    QJsonObject result;
    try { result=execute(arguments,read_request()); }
    catch (const Refused &) { result={{"ok",false},{"code","INVALID_INPUT"}}; }
    catch (const lmti::LibraryError &error) {
        result={{"ok",false},{"code",error.code==lmti::LibraryCode::None ?
            QString("OWNER_UNAVAILABLE") : json::library_code(error.code)}};
    } catch (const std::exception &) { result={{"ok",false},{"code","OWNER_UNAVAILABLE"}}; }
    auto bytes=QJsonDocument(result).toJson(QJsonDocument::Compact)+'\n';
    if (bytes.size()>response_cap)
        bytes=QByteArrayLiteral("{\"ok\":false,\"code\":\"BUDGET_EXCEEDED\"}\n");
    return output.write(bytes)==bytes.size() && output.flush() ? 0 : 1;
}
