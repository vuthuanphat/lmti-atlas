#include "lmti/project_library.hpp"
#include "../common/strict_json.hpp"
#include <QCoreApplication>
#include <QDir>
#include <QFile>
#include <QFileInfo>
#include <QJsonArray>
#include <QJsonDocument>
#include <QJsonObject>
#include <QMap>
#include <QProcess>
#include <QProcessEnvironment>
#include <QSet>
#include <QSqlDatabase>
#include <QSqlQuery>
#include <QSqlRecord>
#include <QTemporaryDir>
#include <QUuid>
#include <QVariant>
#include <algorithm>
#include <iostream>
#include <optional>
#include <vector>

namespace {
int failures=0, skipped=0;
void check(bool ok,const char *message) { if(!ok) { ++failures; std::cerr<<message<<'\n'; } }
void require(bool ok,const char *message) { if(!ok) throw lmti::Error(message); }
QString at(const QString &parent,const QString &name) { return QDir(parent).filePath(name); }
QString uuid() { return QUuid::createUuid().toString(QUuid::WithoutBraces); }
QString mkdir(const QString &parent,const QString &name) {
    require(QDir(parent).mkdir(name),"Cannot create private fixture directory."); return at(parent,name);
}
QByteArray bytes(const QString &path) {
    QFile file(path); require(file.open(QIODevice::ReadOnly),"Cannot read private fixture."); return file.readAll();
}
using Tree=QMap<QString,QByteArray>;
void tree(const QString &root,const QString &relative,Tree &out) {
    for(const auto &entry:QDir(relative.isEmpty()?root:at(root,relative)).entryInfoList(
            QDir::AllEntries|QDir::NoDotAndDotDot|QDir::Hidden|QDir::System,QDir::Name)) {
        const auto name=relative.isEmpty()?entry.fileName():relative+'/'+entry.fileName();
        require(!entry.isSymLink() && !entry.isJunction(),"Unexpected link in private fixture.");
        if(entry.isDir()) { out.insert(name,"directory"); tree(root,name,out); }
        else out.insert(name,"file:"+bytes(entry.filePath()));
    }
}
Tree snapshot(const QString &root) { Tree result; tree(root,{},result); return result; }
void fields(const QJsonObject &value,const QSet<QString> &expected,const char *message) {
    QSet<QString> actual; for(auto i=value.begin();i!=value.end();++i) actual.insert(i.key());
    check(actual==expected,message);
}
// SQL is used only to construct/read precise nullable fixture rows in QTemporaryDir.
class Sql {
    QString name_=uuid();
  public:
    QSqlDatabase db;
    explicit Sql(const QString &path) {
        db=QSqlDatabase::addDatabase("QSQLITE",name_); db.setDatabaseName(path);
        require(db.open(),"Cannot open private fixture SQL.");
    }
    ~Sql() { db.close(); db={}; QSqlDatabase::removeDatabase(name_); }
    void exec(const QString &statement,const QVariantList &values={}) {
        QSqlQuery q(db); require(q.prepare(statement),"Fixture SQL prepare failed.");
        for(const auto &v:values) q.addBindValue(v);
        require(q.exec(),"Fixture SQL write failed.");
    }
};
using Rows=std::vector<QVariantList>;
Rows rows(const QString &path,const QString &table) {
    Sql sql(path); QSqlQuery q(sql.db);
    require(q.exec("SELECT id,label,path,folder,pinned,opened,folder_key FROM "+table+" ORDER BY id"),
            "Fixture row inspection failed.");
    Rows result;
    while(q.next()) { QVariantList row; for(int i=0;i<q.record().count();++i) row.push_back(q.value(i)); result.push_back(row); }
    return result;
}
bool exact_rows(const Rows &a,const Rows &b) {
    if(a.size()!=b.size()) return false;
    for(std::size_t i=0;i<a.size();++i) {
        if(a[i].size()!=b[i].size()) return false;
        for(qsizetype j=0;j<a[i].size();++j)
            if(a[i][j].isNull()!=b[i][j].isNull() || (!a[i][j].isNull() &&
                (a[i][j].metaType()!=b[i][j].metaType() || a[i][j]!=b[i][j]))) return false;
    }
    return true;
}
QJsonValue optional(const std::optional<QString> &value) {
    return value?QJsonValue(*value):QJsonValue(QJsonValue::Null);
}
QJsonObject identity(const lmti::LibraryToken &t) {
    return {{"schema",t.schema},{"canonicalPath",t.canonical_path},
            {"uuid",t.schema==1?QJsonValue(QJsonValue::Null):QJsonValue(t.library_uuid)},
            {"generation",t.schema==1?QJsonValue(QJsonValue::Null):QJsonValue(t.generation)},{"digest",t.digest}};
}
QJsonObject copy_token(const lmti::ProjectCopyToken &t) {
    return {{"schemaVersion",t.schema},{"projectId",t.project_id},{"canonicalPath",t.canonical_path},
            {"storeUuid",t.store_uuid},{"revision",qint64(t.revision)},{"contentDigest",t.content_digest},
            {"registryDigest",t.registry_digest}};
}
QString mode(lmti::ProjectCopyMode value) { return value==lmti::ProjectCopyMode::MigrateV1?"migrate_v1":"clone_v2"; }
QString state(lmti::LibraryActivationState value) {
    return value==lmti::LibraryActivationState::Prepared?"prepared":
        value==lmti::LibraryActivationState::Activated?"activated":"abandoned";
}
QJsonObject activation_token(const lmti::LibraryActivationToken &t) {
    return {{"libraryUuid",t.library_uuid},{"operationId",t.operation_id},{"receiptDigest",t.receipt_digest},{"revision",t.revision}};
}
QJsonObject activation_preview(const lmti::LibraryActivationPreview &p) {
    return {{"library",identity(p.library)},{"projectId",p.project_id},{"copyParent",p.copy_parent},
            {"copyOperationId",p.copy_operation_id},{"mode",mode(p.mode)},{"seedsInternalSites",p.seeds_internal_sites},
            {"source",copy_token(p.source)},{"target",copy_token(p.target)}};
}
QJsonObject receipt(const lmti::LibraryActivationReceipt &r) {
    return {{"token",activation_token(r.token)},{"state",state(r.state)},{"prepared",activation_preview(r.prepared)},
            {"sourceFolder",optional(r.source_folder)},{"sourceFolderKey",optional(r.source_folder_key)},
            {"activatedGeneration",r.activated_generation}};
}
struct Fixture {
    QTemporaryDir temp;
    QString library,parent,backups,root,source,other_source,other_root;
    QString id="selected-project",other_id="other-project";
    explicit Fixture(int version=3,bool structured=false,bool nullable=false) {
        require(temp.isValid(),"Cannot reserve private fixture.");
        library=temp.filePath("library.sqlite"); parent=mkdir(temp.path(),"copies");
        backups=mkdir(temp.path(),"backups"); root=mkdir(temp.path(),"selected-root");
        other_root=mkdir(temp.path(),"other-root"); source=temp.filePath("selected.sqlite"); other_source=temp.filePath("other.sqlite");
        for(const bool other:{false,true}) {
            lmti::ProjectDocument d; d.project={(other?other_id:id).toStdString(),"Controlled write fixture","Local process checks",lmti::Privacy::Internal};
            if(structured) {
                d.structure.emplace();
                if(!other) d.components.push_back({"retired-unit","Retired unit","",lmti::ComponentKind::Library,lmti::Privacy::Internal});
            }
            d.topology.revision=lmti::save_project(other?other_source:source,d);
            if(structured && !other) {
                d.components.clear(); d.topology.revision=lmti::save_project(source,d);
            }
            lmti::remember_library_project(library,{other?other_id:id,"Fixture cosmetics",other?other_source:source,other?other_root:root,true,17});
        }
        if(nullable) {
            Sql sql(library);
            sql.exec("UPDATE library SET folder=NULL,folder_key='',label='Nullable fixture cosmetic',opened=23 WHERE id=?",{id});
            sql.exec("UPDATE library SET folder='',folder_key=NULL WHERE id=?",{other_id});
        }
        if(version>=2) require(lmti::upgrade_project_library(library,backups,lmti::inspect_project_library(library).token).state==
                              lmti::LibraryUpgradeState::Upgraded,"Fixture v2 upgrade failed.");
        if(version==3) require(lmti::upgrade_library_activation_format(library,backups,lmti::inspect_library_activation_upgrade(library)).state==
                             lmti::LibraryUpgradeState::Upgraded,"Fixture v3 upgrade failed.");
    }
    lmti::ProjectCopyStatus copy() const {
        const auto m=lmti::load_project(source).structure?lmti::ProjectCopyMode::CloneV2:lmti::ProjectCopyMode::MigrateV1;
        const auto result=lmti::prepare_project_copy(source,parent,lmti::inspect_project_copy(source,m));
        require(result.state==lmti::ProjectCopyState::Prepared,"Fixture copy failed."); return result;
    }
    lmti::LibraryActivationReceipt prepare(const lmti::ProjectCopyStatus &copy) const {
        const auto p=lmti::inspect_library_activation_candidate(library,id,parent,copy.operation_id);
        const auto result=lmti::prepare_library_activation(library,parent,p);
        require(result.code==lmti::LibraryCode::None && result.receipt.has_value(),"Fixture preparation failed.");
        return *result.receipt;
    }
};
class Facade {
    QString real_,test_;
  public:
    Facade(QString real,QString test):real_(std::move(real)),test_(std::move(test)) {}
    bool hooks() const { return !test_.isEmpty(); }
    QStringList args(const Fixture &f,bool write=true) const {
        QStringList result{write?"--project-operation-write":"--project-operations","--library",f.library,"--copy-parent",f.parent};
        if(write) result<<"--backup-parent"<<f.backups;
        return result;
    }
    QJsonObject raw(const Fixture &f,const QByteArray &input,bool write,const QStringList &arguments,
                    const QString &fault={},bool no_write=false,bool production_with_fault=false) const {
        const auto before=no_write?snapshot(f.temp.path()):Tree{};
        QProcess process; process.setProgram(fault.isEmpty() || production_with_fault?real_:test_); process.setArguments(arguments);
        auto env=QProcessEnvironment::systemEnvironment(); env.remove("LMTI_PROJECT_OPERATION_WRITE_TEST_FAULT");
        if(!fault.isEmpty()) env.insert("LMTI_PROJECT_OPERATION_WRITE_TEST_FAULT",fault);
        process.setProcessEnvironment(env); process.setProcessChannelMode(QProcess::SeparateChannels);
        QByteArray output,errors; bool overflow=false;
        const auto drain=[&] {
            const auto part=process.readAllStandardOutput();
            if(output.size()+part.size()>512*1024) overflow=true;
            else if(!overflow) output+=part;
            const auto error=process.readAllStandardError();
            if(errors.size()+error.size()>4096) overflow=true;
            else errors+=error;
        };
        QObject::connect(&process,&QProcess::readyReadStandardOutput,&process,drain);
        QObject::connect(&process,&QProcess::readyReadStandardError,&process,drain);
        process.start(); require(process.waitForStarted(5000),"Private facade did not start.");
        require(process.write(input)==input.size(),"Private facade input incomplete."); process.closeWriteChannel();
        // A write child is never killed by this harness. The outer CTest deadline
        // bounds this controlled fixture; drain and retain the child until close.
        if(!process.waitForFinished(20000)) {
            check(false,"Private facade exceeded the controlled 20-second deadline");
            process.waitForFinished(-1);
        }
        drain();
        if(no_write) check(snapshot(f.temp.path())==before,"Refused/read-only request changed private fixture bytes");
        require(!overflow && output.size()<=512*1024 && errors.isEmpty() &&
                process.exitStatus()==QProcess::NormalExit && process.exitCode()==0,"Private facade transport contract failed.");
        require(output.endsWith('\n'),"Private facade output lacks newline.");
        const auto result=lmti::detail::strict_json_object(output,512*1024);
        if(!write) check(result.contains("ok"),"Read mode returned a write acknowledgment");
        return result;
    }
    QJsonObject call(const Fixture &f,const QJsonObject &request,bool write=true,const QString &fault={},bool no_write=false) const {
        return raw(f,QJsonDocument(request).toJson(QJsonDocument::Compact),write,args(f,write),fault,no_write||!write);
    }
    QJsonObject read(const Fixture &f,const QJsonObject &request) const { return call(f,request,false); }
};
void read_ok(const QJsonObject &r,const char *action,const QSet<QString> &extra) {
    auto keys=extra; keys.unite({"ok","schema","action"}); fields(r,keys,"Read response shape differs");
    require(r["ok"]==true && r["schema"]=="lmti.project.operations.v1" && r["action"]==QString::fromLatin1(action),"Read preflight failed.");
}
void envelope(const QJsonObject &r,const QJsonValue &action,const char *outcome,bool details) {
    fields(r,{"schema","action","outcome","code","operationId","details","detailsAvailable"},"Write response shape differs");
    check(r["schema"]=="lmti.project.operation.write.v1" && r["action"]==action && r["outcome"]==QString::fromLatin1(outcome),
          "Write action/outcome contract differs");
    check(r["detailsAvailable"]==details && (details?r["details"].isObject():r["details"].isNull()),
          "Write detail availability disagrees with payload");
    if(QString::fromLatin1(outcome)=="confirmed") check(r["code"]=="NONE","Confirmed write has a non-NONE code");
    else check(r["code"].isString() && r["code"]!="NONE","Non-confirmed write claims NONE");
}
void refused(const QJsonObject &r,const QJsonValue &action,const char *code="INVALID_INPUT") {
    envelope(r,action,"refused",false);
    check(r["code"]==QString::fromLatin1(code) && r["operationId"].isNull(),"Refusal has wrong code or invented operation");
}
QJsonObject copy_request(const Facade &api,const Fixture &f) {
    const auto m=lmti::load_project(f.source).structure?"clone_v2":"migrate_v1";
    const auto p=api.read(f,{{"action","copy-preview"},{"projectId",f.id},{"mode",m}});
    read_ok(p,"copy-preview",{"libraryIdentity","projectId","preview"});
    return {{"action","copy-prepare"},{"projectId",f.id},{"expected",QJsonObject{{"libraryIdentity",p["libraryIdentity"]},{"preview",p["preview"]}}}};
}
QJsonObject format_request(const Facade &api,const Fixture &f,int schema) {
    const auto p=api.read(f,{{"action","library-format-preview"},{"fromSchema",schema}});
    read_ok(p,"library-format-preview",{"fromSchema","toSchema","expected"});
    check(p["fromSchema"]==schema && p["toSchema"]==schema+1,"Format preview skipped a schema");
    return {{"action",schema==1?"library-upgrade-v1":"library-upgrade-v2"},{"expected",p["expected"]}};
}
QJsonObject preparation_request(const Facade &api,const Fixture &f,const QString &copy) {
    const auto p=api.read(f,{{"action","activation-candidate"},{"projectId",f.id},{"copyOperationId",copy}});
    read_ok(p,"activation-candidate",{"preview"});
    return {{"action","activation-prepare"},{"expected",p["preview"]}};
}
QJsonObject decision(const Fixture &f,const char *action,const QJsonValue &token) {
    return {{"action",action},{"projectId",f.id},{"expected",token}};
}
QJsonObject inspect_activation(const Facade &api,const Fixture &f,const lmti::LibraryActivationToken &token) {
    const auto r=api.read(f,{{"action","activation-inspect"},{"libraryUuid",token.library_uuid},{"operationId",token.operation_id}});
    read_ok(r,"activation-inspect",{"libraryIdentity","receipt","condition","code"}); return r;
}
void confirmed_receipt(const QJsonObject &r,const char *action,const lmti::LibraryActivationReceipt &actual) {
    envelope(r,action,"confirmed",true);
    fields(r["details"].toObject(),{"receipt"},"Activation detail shape differs");
    check(r["operationId"]==actual.token.operation_id && r["details"].toObject()["receipt"]==receipt(actual),
          "Acknowledged receipt differs from independently persisted owner receipt");
}

void malformed_and_separate_modes(const Facade &api) {
    Fixture f;
    for(const auto &input:std::vector<QByteArray>{"","[]","null","{","{\"action\":\"surprise\"}",
            "{\"action\":\"copy-prepare\",\"action\":\"copy-prepare\"}",QByteArray(32769,' '),
            QByteArray("{\"action\":\"")+QByteArray::fromHex("ff")+"\"}"}) {
        const auto r=api.raw(f,input,true,api.args(f),{},true);
        refused(r,QJsonValue::Null);
    }
    const auto valid=copy_request(api,f);
    auto json=QJsonDocument(valid).toJson(QJsonDocument::Compact);
    for(const auto &suffix:std::vector<QByteArray>{QByteArray(1,'\x1a')+"garbage",QByteArray(1,'\0')})
        refused(api.raw(f,json+suffix,true,api.args(f),{},true),QJsonValue::Null);
    // Preserve every field from the actual copy preview; only insert invalid
    // escaped UTF-16 inside the recognized library token's canonical path.
    // The parser must refuse before establishing a trusted action or owner entry.
    const auto path_array=QJsonDocument(QJsonArray{valid["expected"].toObject()["libraryIdentity"].toObject()["canonicalPath"]})
                              .toJson(QJsonDocument::Compact);
    const auto path_literal=path_array.mid(1,path_array.size()-2);
    const auto path_member=QByteArray("\"canonicalPath\":")+path_literal;
    require(json.count(path_member)==1,"Unicode fixture must select exactly the reviewed library path.");
    for(const QByteArray surrogate:{QByteArray("\\ud800"),QByteArray("\\udc00"),QByteArray("\\udc00\\ud800")}) {
        auto invalid_path=path_literal;
        invalid_path.insert(invalid_path.size()-1,surrogate);
        auto raw=json;
        raw.replace(path_member,QByteArray("\"canonicalPath\":")+invalid_path);
        refused(api.raw(f,raw,true,api.args(f),{},true),QJsonValue::Null,"INVALID_INPUT");
    }
    for(const auto *name:{"root","source","target","library","backupParent","command"}) {
        auto bad=valid; bad[name]="untrusted";
        refused(api.call(f,bad,true,{},true),"copy-prepare");
    }
    for(const auto &value:QJsonArray{QJsonValue::Null,true,1,"../selected-project",QString(65,'a')}) {
        auto bad=valid; bad["projectId"]=value; refused(api.call(f,bad,true,{},true),"copy-prepare");
    }
    auto args=api.args(f); args<<"extra";
    refused(api.raw(f,json,true,args,{},true),"copy-prepare");
    args=api.args(f); args[5]="--unexpected-parent";
    refused(api.raw(f,json,true,args,{},true),"copy-prepare");
    for(const int index:{2,4,6}) {
        args=api.args(f); args[index]="relative";
        refused(api.raw(f,json,true,args,{},true),"copy-prepare");
        args=api.args(f); args[index]=f.library+":stream";
        refused(api.raw(f,json,true,args,{},true),"copy-prepare");
    }
    // Fixed read mode still refuses every write and extra backup-parent argv.
    for(const auto *action:{"copy-prepare","library-upgrade-v1","library-upgrade-v2","activation-prepare","activation-activate","activation-abandon"}) {
        const auto r=api.read(f,{{"action",action}});
        fields(r,{"ok","code"},"Read mode write refusal leaked metadata"); check(r["ok"]==false && r["code"]=="INVALID_INPUT","Read mode accepted a writer");
    }
    args=api.args(f,false); args<<"--backup-parent"<<f.backups;
    const auto r=api.raw(f,"{\"action\":\"library-format-status\"}",false,args,{},true);
    check(r==QJsonObject{{"ok",false},{"code","INVALID_INPUT"}},"Read mode accepted backup argv");
    for(const auto &v:QJsonArray{QJsonValue::Null,true,0,3,1.5}) {
        const auto bad=api.read(f,{{"action","library-format-preview"},{"fromSchema",v}});
        check(bad==QJsonObject{{"ok",false},{"code","INVALID_INPUT"}},"Format read accepted malformed schema");
    }
}

void copy_happy_paths_and_stale_preflight(const Facade &api) {
    for(const bool structured:{false,true}) {
        Fixture f(3,structured);
        const auto request=copy_request(api,f);
        const auto before_library=lmti::inspect_project_library(f.library);
        const auto source_bytes=bytes(f.source),other_bytes=bytes(f.other_source),library_bytes=bytes(f.library);
        auto args=api.args(f); args[6]=f.temp.filePath("unavailable-backup-parent");
        const auto r=api.raw(f,QJsonDocument(request).toJson(QJsonDocument::Compact),true,args);
        envelope(r,"copy-prepare","confirmed",true);
        const auto id=r["operationId"].toString(); require(!QUuid(id).isNull(),"Copy reply omitted operation.");
        const auto actual=lmti::inspect_project_copy_operation(f.parent,id);
        require(actual.state==lmti::ProjectCopyState::Prepared,"Copy reply did not name a prepared copy.");
        const auto detail=r["details"].toObject();
        fields(detail,{"operationId","state","code","mode","seedsInternalSites","verifiedReceipt","source","target"},"Copy detail shape differs");
        check(detail["operationId"]==id && detail["state"]=="prepared" && detail["code"]=="NONE" &&
              detail["mode"]==mode(actual.mode) && detail["seedsInternalSites"]==actual.seeds_internal_sites &&
              detail["verifiedReceipt"]==actual.verified_receipt && detail["source"]==copy_token(actual.source) &&
              detail["target"]==copy_token(actual.target),"Copy acknowledgment differs from current independent inspection");
        check(actual.target.revision==actual.source.revision+1 && actual.target.project_id==f.id &&
              actual.target.schema==2 && !actual.target.store_uuid.isEmpty(),"Copy lost native identity/revision");
        if(structured) check(actual.source.registry_digest==actual.target.registry_digest &&
                             actual.source.store_uuid!=actual.target.store_uuid,"Clone lost tombstones or reused store UUID");
        check(bytes(f.source)==source_bytes && bytes(f.other_source)==other_bytes && bytes(f.library)==library_bytes &&
              lmti::inspect_project_library(f.library).token==before_library.token,"Copy mutated source, other project or library");
        check(!QFileInfo::exists(args[6]),"Copy created unrelated backup parent");
    }
    Fixture f(3,true);
    auto request=copy_request(api,f);
    const auto original=lmti::inspect_project_library(f.library).token;
    const auto aba=mkdir(f.temp.path(),"unassigned-aba-root");
    const auto changed=lmti::link_library_folder_cas(f.library,f.id,aba,original);
    const auto restored=lmti::link_library_folder_cas(f.library,f.id,f.root,changed);
    check(restored.generation==original.generation+2 && restored.digest==original.digest,"Root ABA fixture failed");
    refused(api.call(f,request,true,{},true),"copy-prepare","CONFIG_CHANGED");
    request=copy_request(api,f);
    auto wrong=request; wrong["projectId"]=f.other_id;
    const auto denied=api.call(f,wrong,true,{},true);
    envelope(denied,"copy-prepare","refused",false); check(denied["operationId"].isNull(),"Wrong project generated an operation");
    auto expected=request["expected"].toObject(),p=expected["preview"].toObject(),s=p["source"].toObject();
    s["canonicalPath"]=f.other_source; p["source"]=s; expected["preview"]=p; wrong=request; wrong["expected"]=expected;
    envelope(api.call(f,wrong,true,{},true),"copy-prepare","refused",false);
    auto document=lmti::load_project(f.source); document.project.goal="Changed controlled source";
    document.topology.revision=lmti::save_project(f.source,document);
    refused(api.call(f,request,true,{},true),"copy-prepare","SOURCE_CHANGED");
}

void separate_format_upgrades_and_typed_backup(const Facade &api) {
    Fixture f(1,false,true);
    const auto initial=rows(f.library,"library");
    const auto source_bytes=bytes(f.source),other_bytes=bytes(f.other_source);
    auto status=api.read(f,{{"action","library-format-status"}});
    read_ok(status,"library-format-status",{"libraryIdentity","upgradeOperationId","legacyDigest","activationFormatOperationId","activationFormatBackupDigest"});
    check(status["upgradeOperationId"].isNull() && status["legacyDigest"].isNull() &&
          status["activationFormatOperationId"].isNull() && status["activationFormatBackupDigest"].isNull(),"V1 status invented durable upgrade metadata");
    for(const int schema:{1,2}) {
        const auto request=format_request(api,f,schema);
        const auto current_rows=rows(f.library,schema==1?"library":"library_entries");
        auto args=api.args(f); args[4]=f.temp.filePath("unused-copy-parent");
        const auto r=api.raw(f,QJsonDocument(request).toJson(QJsonDocument::Compact),true,args);
        envelope(r,schema==1?"library-upgrade-v1":"library-upgrade-v2","confirmed",true);
        const auto detail=r["details"].toObject();
        fields(detail,{"state","operationId","backupPath","libraryIdentity"},"Format upgrade detail shape differs");
        const auto inspected=lmti::inspect_project_library(f.library);
        check(detail["state"]=="upgraded" && detail["operationId"]==r["operationId"] &&
              detail["libraryIdentity"]==identity(inspected.token) && inspected.token.schema==schema+1,"Format acknowledgment differs from current owner");
        check(exact_rows(current_rows,rows(detail["backupPath"].toString(),schema==1?"library":"library_entries")) &&
              exact_rows(initial,rows(f.library,"library_entries")),"Typed backup or upgrade changed null/empty/cosmetic values");
        check(bytes(f.source)==source_bytes && bytes(f.other_source)==other_bytes && !QFileInfo::exists(args[4]),"Library upgrade touched projects or unused copy parent");
        status=api.read(f,{{"action","library-format-status"}});
        check(status["libraryIdentity"]==identity(inspected.token) && status["upgradeOperationId"]==inspected.upgrade_operation_id &&
              status["legacyDigest"]==inspected.legacy_digest,"Format recovery metadata differs from persisted owner");
        if(schema==2) check(status["activationFormatOperationId"]==r["operationId"] &&
                           status["activationFormatBackupDigest"]==request["expected"].toObject()["fullSnapshotDigest"],
                           "V3 status lost reviewed full snapshot identity");
        envelope(api.call(f,request,true,{},true),schema==1?"library-upgrade-v1":"library-upgrade-v2","refused",false);
    }
    Fixture stale(1);
    const auto request=format_request(api,stale,1);
    lmti::pin_library_project(stale.library,stale.id,false);
    refused(api.call(stale,request,true,{},true),"library-upgrade-v1","CONFIG_CHANGED");
    Fixture cosmetic(2);
    const auto full_preview=format_request(api,cosmetic,2);
    const auto authority=lmti::inspect_project_library(cosmetic.library).token;
    lmti::pin_library_project(cosmetic.library,cosmetic.id,false);
    check(lmti::inspect_project_library(cosmetic.library).token==authority,"Cosmetic fixture changed binding authority");
    refused(api.call(cosmetic,full_preview,true,{},true),"library-upgrade-v2","CONFIG_CHANGED");
}

void activation_lifecycle_and_offline_terminal_recovery(const Facade &api) {
    for(const bool structured:{false,true}) for(const bool nullable:{false,true}) {
        Fixture f(3,structured,nullable); const auto copy=f.copy();
        const auto library_before=lmti::inspect_project_library(f.library).token;
        const auto source_before=bytes(f.source),other_before=bytes(f.other_source);
        const auto candidate=preparation_request(api,f,copy.operation_id);
        const auto prepared_reply=api.call(f,candidate);
        envelope(prepared_reply,"activation-prepare","confirmed",true);
        const auto prepared_id=prepared_reply["operationId"].toString();
        auto inspected=lmti::inspect_library_activation(f.library,f.parent,library_before.library_uuid,prepared_id);
        const auto prepared=inspected.receipt;
        confirmed_receipt(prepared_reply,"activation-prepare",prepared);
        check(prepared.token.revision==1 && prepared.state==lmti::LibraryActivationState::Prepared &&
              lmti::inspect_project_library(f.library).token==library_before,"Preparation changed binding generation");
        check(nullable?!prepared.source_folder && prepared.source_folder_key==QString{}:
                       prepared.source_folder==f.root && prepared.source_folder_key.has_value(),"Receipt lost independent null/empty root semantics");
        const auto read=inspect_activation(api,f,prepared.token);
        check(read["condition"]=="prepared_current" && read["receipt"]==receipt(prepared),"Prepared recovery read differs");
        auto bad=decision(f,"activation-activate",activation_token(prepared.token)); bad["projectId"]=f.other_id;
        envelope(api.call(f,bad,true,{},true),"activation-activate","refused",false);
        bad=decision(f,"activation-activate",activation_token(prepared.token));
        auto bad_token=bad["expected"].toObject(); bad_token["receiptDigest"]=QString(64,'0'); bad["expected"]=bad_token;
        envelope(api.call(f,bad,true,{},true),"activation-activate","refused",false);
        const auto activated_reply=api.call(f,decision(f,"activation-activate",activation_token(prepared.token)));
        inspected=lmti::inspect_library_activation(f.library,f.parent,library_before.library_uuid,prepared_id);
        confirmed_receipt(activated_reply,"activation-activate",inspected.receipt);
        check(inspected.receipt.token.revision==2 && inspected.receipt.state==lmti::LibraryActivationState::Activated &&
              inspected.receipt.prepared==prepared.prepared && inspected.receipt.source_folder==prepared.source_folder &&
              inspected.receipt.source_folder_key==prepared.source_folder_key &&
              lmti::inspect_project_library(f.library).token.generation==library_before.generation+1,
              "Activation changed immutable receipt/root or advanced generation incorrectly");
        check(bytes(f.source)==source_before && bytes(f.other_source)==other_before,"Activation changed retained source or other project");
        envelope(api.call(f,decision(f,"activation-activate",activation_token(prepared.token)),true,{},true),"activation-activate","refused",false);
        require(QFile::rename(f.source,f.temp.filePath("retained-source.sqlite")),"Cannot hide retained source.");
        require(QDir().rename(f.parent,f.temp.filePath("retained-copies")),"Cannot hide copy parent.");
        const auto terminal=inspect_activation(api,f,prepared.token);
        check(terminal["condition"]=="activated_current" && terminal["receipt"]==receipt(inspected.receipt),"Terminal inspection probed unavailable source/target/copy parent");
        const auto token_now=lmti::inspect_project_library(f.library).token;
        lmti::forget_library_project_cas(f.library,f.id,token_now);
        check(inspect_activation(api,f,prepared.token)["condition"]=="activated_superseded","Superseded activation was mistaken for current or unreadable history");
        const auto history=api.read(f,{{"action","activation-history"},{"projectId",f.id},{"offset",0},{"limit",50},{"snapshot",QJsonValue::Null}});
        check(history["items"].toArray().size()==1 && history["items"].toArray().at(0).toObject()["state"]=="activated",
              "Terminal history required current project registration or readable paths");
    }
    Fixture f(3,true,true); const auto copy=f.copy(); const auto prepared=f.prepare(copy);
    const auto library_before=lmti::inspect_project_library(f.library).token;
    require(QFile::rename(f.source,f.temp.filePath("retained-source.sqlite")),"Cannot hide abandon source.");
    require(QDir().rename(f.parent,f.temp.filePath("retained-copies")),"Cannot hide abandon copy parent.");
    auto args=api.args(f); args[6]=f.temp.filePath("unavailable-backup-parent");
    const auto request=decision(f,"activation-abandon",activation_token(prepared.token));
    auto wrong=request; wrong["projectId"]=f.other_id;
    envelope(api.call(f,wrong,true,{},true),"activation-abandon","refused",false);
    wrong=request; auto wrong_token=wrong["expected"].toObject(); wrong_token["receiptDigest"]=QString(64,'0'); wrong["expected"]=wrong_token;
    // Summary-only preflight cannot validate this digest without probing offline
    // stores. The unchanged full token reaches owner CAS: conservative unknown.
    envelope(api.call(f,wrong,true,{},true),"activation-abandon","unknown",false);
    const auto result=api.raw(f,QJsonDocument(request).toJson(QJsonDocument::Compact),true,args);
    const auto actual=lmti::inspect_library_activation(f.library,f.parent,prepared.token.library_uuid,prepared.token.operation_id);
    confirmed_receipt(result,"activation-abandon",actual.receipt);
    check(actual.receipt.token.revision==2 && actual.receipt.state==lmti::LibraryActivationState::Abandoned &&
          actual.receipt.prepared==prepared.prepared && lmti::inspect_project_library(f.library).token==library_before,
          "Abandon changed binding or immutable prepared identity");
    check(inspect_activation(api,f,prepared.token)["condition"]=="abandoned" && !QFileInfo::exists(args[6]),
          "Abandon recovery needs unrelated paths");
}

void stale_activation_reviews_and_path_tokens(const Facade &api) {
    Fixture f(3,true); const auto copy=f.copy();
    const auto candidate=preparation_request(api,f,copy.operation_id);
    auto bad=candidate,p=bad["expected"].toObject(); p["copyParent"]=f.other_root; bad["expected"]=p;
    refused(api.call(f,bad,true,{},true),"activation-prepare");
    const auto original=lmti::inspect_project_library(f.library).token;
    const auto alternate=mkdir(f.temp.path(),"fresh-activation-root");
    const auto changed=lmti::link_library_folder_cas(f.library,f.id,alternate,original);
    lmti::link_library_folder_cas(f.library,f.id,f.root,changed);
    refused(api.call(f,candidate,true,{},true),"activation-prepare","CONFIG_CHANGED");
    // A new review is deliberately obtained only after the old request is refused.
    const auto fresh=preparation_request(api,f,copy.operation_id);
    const auto reply=api.call(f,fresh);
    const auto token=reply["details"].toObject()["receipt"].toObject()["token"].toObject();
    envelope(reply,"activation-prepare","confirmed",true);
    auto document=lmti::load_project(copy.target.canonical_path);
    document.project.goal="Controlled edited target";
    document.topology.revision=lmti::save_project(copy.target.canonical_path,document);
    const auto rejected=api.call(f,decision(f,"activation-activate",token),true,{},true);
    envelope(rejected,"activation-activate","refused",false);
    const auto inspected=api.read(f,{{"action","activation-inspect"},{"libraryUuid",token["libraryUuid"]},{"operationId",token["operationId"]}});
    check(inspected["condition"]=="prepared_stale" && inspected["receipt"].toObject()["state"]=="prepared",
          "Target drift granted activation or mutated prepared history");
}

void token_shape_refusals(const Facade &api) {
    Fixture f(3,true); const auto copy=f.copy(); const auto prepared=f.prepare(copy);
    const auto valid=decision(f,"activation-abandon",activation_token(prepared.token));
    for(const auto *key:{"libraryUuid","operationId","receiptDigest","revision"}) {
        auto bad=valid,t=bad["expected"].toObject(); t.remove(key); bad["expected"]=t;
        refused(api.call(f,bad,true,{},true),"activation-abandon");
    }
    for(const auto &value:QJsonArray{QJsonValue::Null,true,0,-1,3,1.5,9007199254740992.0}) {
        auto bad=valid,t=bad["expected"].toObject(); t["revision"]=value; bad["expected"]=t;
        refused(api.call(f,bad,true,{},true),"activation-abandon");
    }
    for(const auto *key:{"libraryUuid","operationId","receiptDigest"}) {
        auto bad=valid,t=bad["expected"].toObject(); t[key]="not-canonical"; bad["expected"]=t;
        refused(api.call(f,bad,true,{},true),"activation-abandon");
    }
    auto bad=valid,t=bad["expected"].toObject(); t["extra"]="rejected"; bad["expected"]=t;
    refused(api.call(f,bad,true,{},true),"activation-abandon");
    // Duplicates inside authority objects must fail before the action can be trusted.
    auto raw=QJsonDocument(valid).toJson(QJsonDocument::Compact);
    raw.replace("\"revision\":1","\"revision\":1,\"revision\":1");
    refused(api.raw(f,raw,true,api.args(f),{},true),QJsonValue::Null);
    const auto copy_valid=copy_request(api,f);
    for(const auto &value:QJsonArray{QJsonValue::Null,0,1,"true"}) {
        auto b=copy_valid,e=b["expected"].toObject(),p=e["preview"].toObject(); p["seedsInternalSites"]=value;
        e["preview"]=p; b["expected"]=e; refused(api.call(f,b,true,{},true),"copy-prepare");
    }
    Fixture v1(1);
    const auto upgrade=format_request(api,v1,1);
    for(const auto *key:{"uuid","generation"}) {
        auto b=upgrade,e=b["expected"].toObject(); e[key]=QString::fromLatin1(key)=="uuid"?QJsonValue(uuid()):QJsonValue(1);
        b["expected"]=e; refused(api.call(v1,b,true,{},true),"library-upgrade-v1");
    }
}

void fallback_and_uncertain_owner_results(const Facade &api) {
    if(!api.hooks()) { ++skipped; std::cout<<"SKIP: isolated write test-admin not supplied.\n"; return; }
    for(const auto *fault:{"after_owner_return","serialization_fallback","oversize"}) {
        Fixture f(3,true); const auto request=copy_request(api,f); const auto before=bytes(f.source);
        const auto r=api.call(f,request,true,QString::fromLatin1(fault));
        envelope(r,"copy-prepare","confirmed",false);
        check(r["operationId"].isNull(),"Prebuilt fallback invented a receipt identifier");
        const auto found=lmti::discover_project_copies(f.parent);
        require(found.complete && found.candidates.size()==1,"Confirmed fallback did not leave one discoverable copy.");
        check(lmti::inspect_project_copy_operation(f.parent,found.candidates.front().operation_id).state==lmti::ProjectCopyState::Prepared &&
              bytes(f.source)==before,"Confirmed fallback lost actual copy or changed source");
    }
    {
        Fixture f; const auto request=copy_request(api,f);
        const auto r=api.call(f,request,true,"entered_throw",true);
        envelope(r,"copy-prepare","unknown",false); check(r["operationId"].isNull(),"Entered exception invented identity");
    }
    // The same test selector has no effect in the shipped executable.
    {
        Fixture f; const auto request=copy_request(api,f);
        const auto r=api.raw(f,QJsonDocument(request).toJson(QJsonDocument::Compact),true,api.args(f),"entered_throw",false,true);
        envelope(r,"copy-prepare","confirmed",true);
    }
    {
        Fixture f; const auto source_before=bytes(f.source);
        const auto r=api.call(f,copy_request(api,f),true,"copy_before_independent_verification");
        envelope(r,"copy-prepare","unknown",true);
        const auto found=lmti::discover_project_copies(f.parent);
        require(found.complete && found.candidates.size()==1,"Actual post-COMMIT copy fault lost reservation.");
        const auto actual=lmti::inspect_project_copy_operation(f.parent,found.candidates.front().operation_id);
        check(actual.state==lmti::ProjectCopyState::Prepared && !actual.verified_receipt && bytes(f.source)==source_before,
              "Independent inspection did not reconcile actual committed copy without final receipt");
    }
    for(const int schema:{1,2}) {
        Fixture f(schema,false,true); const auto request=format_request(api,f,schema);
        const auto r=api.call(f,request,true,schema==1?"after_upgrade_commit":"after_format_commit");
        envelope(r,schema==1?"library-upgrade-v1":"library-upgrade-v2","unknown",true);
        const auto actual=lmti::inspect_project_library(f.library);
        const auto status=api.read(f,{{"action","library-format-status"}});
        check(actual.token.schema==schema+1 && status["libraryIdentity"]==identity(actual.token) &&
              (schema==1?status["upgradeOperationId"]:status["activationFormatOperationId"])==r["operationId"],
              "Actual committed format fault was not independently reconciled");
    }
    for(const auto *fault:{"after_preparation_commit","after_activation_commit","after_abandon_commit"}) {
        Fixture f(3,true); const auto copy=f.copy();
        const auto before=lmti::inspect_project_library(f.library).token;
        QJsonObject request; QString operation;
        if(QString::fromLatin1(fault)=="after_preparation_commit") request=preparation_request(api,f,copy.operation_id);
        else {
            const auto prepared=f.prepare(copy); operation=prepared.token.operation_id;
            request=decision(f,QString::fromLatin1(fault)=="after_activation_commit"?"activation-activate":"activation-abandon",activation_token(prepared.token));
        }
        const auto r=api.call(f,request,true,QString::fromLatin1(fault));
        envelope(r,request["action"],"unknown",true);
        if(operation.isEmpty()) operation=r["operationId"].toString();
        require(!QUuid(operation).isNull(),"Committed activation fault lost recovery identity.");
        const auto actual=lmti::inspect_library_activation(f.library,f.parent,before.library_uuid,operation);
        const auto expected_state=QString::fromLatin1(fault)=="after_preparation_commit"?lmti::LibraryActivationState::Prepared:
            QString::fromLatin1(fault)=="after_activation_commit"?lmti::LibraryActivationState::Activated:lmti::LibraryActivationState::Abandoned;
        check(actual.receipt.state==expected_state && r["details"].toObject()["receipt"]==receipt(actual.receipt),
              "Actual committed activation fault was not independently reconciled");
        check(lmti::inspect_project_library(f.library).token.generation==before.generation+
              (expected_state==lmti::LibraryActivationState::Activated?1:0),"Uncertain operation duplicated a binding generation");
        check(inspect_activation(api,f,actual.receipt.token)["receipt"]==receipt(actual.receipt),"Recovery read lost committed receipt");
    }
}
}

int main(int argc,char **argv) {
    QCoreApplication app(argc,argv);
    try {
        require(app.arguments().size()==2 || app.arguments().size()==3,"Provide real admin and optional isolated test admin.");
        Facade api(app.arguments().at(1),app.arguments().size()==3?app.arguments().at(2):QString{});
        malformed_and_separate_modes(api); copy_happy_paths_and_stale_preflight(api);
        separate_format_upgrades_and_typed_backup(api); activation_lifecycle_and_offline_terminal_recovery(api);
        stale_activation_reviews_and_path_tokens(api); token_shape_refusals(api); fallback_and_uncertain_owner_results(api);
    } catch(const std::exception &error) {
        std::cerr<<"Unexpected private write fixture failure: "<<error.what()<<'\n'; return 1;
    }
    std::cout<<"Project-operation writes: "<<failures<<" failures, "<<skipped
             <<" conditional skips; real owner state independently inspected, no transport retry.\n";
    return failures?1:0;
}
