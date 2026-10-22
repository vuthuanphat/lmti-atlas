#include "lmti/project_library.hpp"
#include "../common/strict_json.hpp"
#include <QCoreApplication>
#include <QCryptographicHash>
#include <QDir>
#include <QFile>
#include <QFileInfo>
#include <QJsonArray>
#include <QJsonDocument>
#include <QJsonObject>
#include <QMap>
#include <QProcess>
#include <QSet>
#include <QSqlDatabase>
#include <QSqlQuery>
#include <QTemporaryDir>
#include <QUuid>
#include <QVariant>
#include <algorithm>
#include <iostream>

namespace {
int failures=0;
void check(bool value,const char *message) { if(!value) { ++failures; std::cerr<<message<<'\n'; } }
void require(bool value,const char *message) { if(!value) throw lmti::Error(message); }
QString at(const QString &parent,const QString &name) { return QDir(parent).filePath(name); }
QString uuid() { return QUuid::createUuid().toString(QUuid::WithoutBraces); }
QString mkdir(const QString &parent,const QString &name) {
    require(QDir(parent).mkdir(name),"Fixture directory creation failed."); return at(parent,name);
}
QByteArray bytes(const QString &path) {
    QFile file(path); require(file.open(QIODevice::ReadOnly),"Fixture read failed."); return file.readAll();
}
void put(const QString &path,const QByteArray &value) {
    QFile file(path); require(file.open(QIODevice::WriteOnly|QIODevice::Truncate),"Fixture write failed.");
    require(file.write(value)==value.size(),"Fixture write incomplete.");
}
using Tree=QMap<QString,QByteArray>;
void tree(const QString &root,const QString &relative,Tree &out) {
    for(const auto &entry:QDir(relative.isEmpty()?root:at(root,relative)).entryInfoList(
            QDir::AllEntries|QDir::NoDotAndDotDot|QDir::Hidden|QDir::System,QDir::Name)) {
        const auto name=relative.isEmpty()?entry.fileName():relative+'/'+entry.fileName();
        require(!entry.isSymLink() && !entry.isJunction(),"Unexpected link in private process fixture.");
        if(entry.isDir()) { out.insert(name,"directory"); tree(root,name,out); }
        else out.insert(name,"file:"+bytes(entry.filePath()));
    }
}
Tree snapshot(const QString &root) { Tree result; tree(root,{},result); return result; }
QString digest(const QJsonObject &object) {
    return QString::fromLatin1(QCryptographicHash::hash(
        QJsonDocument(object).toJson(QJsonDocument::Compact),QCryptographicHash::Sha256).toHex());
}
void fields(const QJsonObject &object,const QSet<QString> &expected,const char *message) {
    QSet<QString> actual; for(auto it=object.begin();it!=object.end();++it) actual.insert(it.key());
    check(actual==expected,message);
}
struct Fixture {
    QTemporaryDir temp;
    QString library,parent,backups,root,source,other_source,other_root;
    QString id="selected-project",other_id="other-project";
    int schema;
    explicit Fixture(int version=3,bool structured=false):schema(version) {
        require(temp.isValid(),"Temporary fixture unavailable.");
        library=temp.filePath("library.sqlite"); parent=mkdir(temp.path(),"copies");
        backups=mkdir(temp.path(),"backups"); root=mkdir(temp.path(),"selected-root");
        other_root=mkdir(temp.path(),"other-root"); source=temp.filePath("selected.sqlite"); other_source=temp.filePath("other.sqlite");
        for(const bool other:{false,true}) {
            lmti::ProjectDocument d; d.project={(other?other_id:id).toStdString(),"Controlled operations","Read-only process fixture",lmti::Privacy::Internal};
            if(structured) d.structure.emplace();
            d.topology.revision=lmti::save_project(other?other_source:source,d);
            lmti::remember_library_project(library,{other?other_id:id,"Private fixture",other?other_source:source,other?other_root:root});
        }
        if(version>=2) require(lmti::upgrade_project_library(library,backups,lmti::inspect_project_library(library).token).state==
                               lmti::LibraryUpgradeState::Upgraded,"Fixture v2 upgrade failed.");
        if(version==3) require(lmti::upgrade_library_activation_format(library,backups,lmti::inspect_library_activation_upgrade(library)).state==
                              lmti::LibraryUpgradeState::Upgraded,"Fixture v3 upgrade failed.");
    }
    lmti::ProjectCopyStatus copy(bool other=false) const {
        const auto selected=other?other_source:source;
        const auto d=lmti::load_project(selected);
        const auto mode=d.structure?lmti::ProjectCopyMode::CloneV2:lmti::ProjectCopyMode::MigrateV1;
        const auto result=lmti::prepare_project_copy(selected,parent,lmti::inspect_project_copy(selected,mode));
        require(result.state==lmti::ProjectCopyState::Prepared && result.verified_receipt,"Native copy fixture failed.");
        return result;
    }
    lmti::LibraryActivationReceipt prepare_activation(const lmti::ProjectCopyStatus &copy,bool other=false) const {
        const auto preview=lmti::inspect_library_activation_candidate(library,other?other_id:id,parent,copy.operation_id);
        const auto result=lmti::prepare_library_activation(library,parent,preview);
        require(result.code==lmti::LibraryCode::None && result.receipt.has_value(),"Native activation preparation failed.");
        return *result.receipt;
    }
};
class Facade {
    QString binary_;
  public:
    explicit Facade(QString binary):binary_(std::move(binary)) {}
    QStringList arguments(const Fixture &f) const {
        return {"--project-operations","--library",f.library,"--copy-parent",f.parent};
    }
    QJsonObject raw(const Fixture &f,const QByteArray &input,const QStringList &args) const {
        const auto before=snapshot(f.temp.path());
        QProcess process; process.setProgram(binary_); process.setArguments(args);
        process.setProcessChannelMode(QProcess::SeparateChannels);
        QByteArray output,errors; bool overflow=false;
        const auto drain=[&] {
            while(process.bytesAvailable()) {
                const auto part=process.read(4096);
                if(part.isEmpty()) break;
                if(output.size()+part.size()>512*1024) { overflow=true; process.kill(); }
                else output+=part;
            }
        };
        QObject::connect(&process,&QProcess::readyReadStandardOutput,&process,drain);
        QObject::connect(&process,&QProcess::readyReadStandardError,&process,[&] {
            const auto part=process.readAllStandardError();
            if(errors.size()+part.size()>4096) { overflow=true; process.kill(); }
            else errors+=part;
        });
        process.start();
        require(process.waitForStarted(5000),"Read-only facade did not start.");
        require(process.write(input)==input.size(),"Read-only facade input incomplete.");
        process.closeWriteChannel();
        if(!process.waitForFinished(15000)) {
            process.kill(); process.waitForFinished(3000);
            throw lmti::Error("Read-only facade exceeded fixture deadline.");
        }
        drain(); errors+=process.readAllStandardError();
        check(snapshot(f.temp.path())==before,"Read-only facade changed a fixture file or entry");
        require(!overflow && output.size()<=512*1024 && errors.isEmpty() &&
                process.exitStatus()==QProcess::NormalExit && process.exitCode()==0,
                "Facade output/exit contract failed.");
        require(output.endsWith('\n'),"Facade response lacks newline.");
        return lmti::detail::strict_json_object(output,512*1024);
    }
    QJsonObject raw(const Fixture &f,const QByteArray &input) const { return raw(f,input,arguments(f)); }
    QJsonObject call(const Fixture &f,const QJsonObject &request) const {
        return raw(f,QJsonDocument(request).toJson(QJsonDocument::Compact));
    }
};
void success(const QJsonObject &result,const char *action,const QSet<QString> &extra) {
    auto expected=extra; expected.unite({"ok","schema","action"});
    fields(result,expected,"Facade success response fields differ from protocol");
    check(result["ok"]==true && result["schema"]=="lmti.project.operations.v1" && result["action"]==QString::fromLatin1(action),
          "Facade success envelope differs from protocol");
}
void refusal(const QJsonObject &result,const char *code="INVALID_INPUT") {
    fields(result,{"ok","code"},"Facade refusal leaked fields outside code/ok");
    check(result["ok"]==false && result["code"]==QString::fromLatin1(code),"Facade refusal code differs from protocol");
}
void identity(const QJsonObject &value,int schema) {
    fields(value,{"schema","canonicalPath","uuid","generation","digest"},"Library identity shape changed");
    check(value["schema"].toInt()==schema && !value["canonicalPath"].toString().isEmpty() &&
          value["digest"].toString().size()==64,"Library identity metadata missing");
    check(schema==1 ? value["uuid"].isNull() && value["generation"].isNull()
                    : !value["uuid"].toString().isEmpty() && value["generation"].toDouble()>=1,
          "Library identity invented or lost durable identity");
}
void token(const QJsonObject &value,const lmti::ProjectCopyToken &expected) {
    fields(value,{"schemaVersion","projectId","canonicalPath","storeUuid","revision","contentDigest","registryDigest"},
           "Copy token shape changed");
    check(value["schemaVersion"].toInt()==expected.schema && value["projectId"]==expected.project_id &&
          value["canonicalPath"]==expected.canonical_path && value["storeUuid"]==expected.store_uuid &&
          value["revision"].toInteger()==expected.revision && value["contentDigest"]==expected.content_digest &&
          value["registryDigest"]==expected.registry_digest,"Copy token differs from actual owner metadata");
}
QJsonObject page(const char *action,int offset=0,int limit=50,const QJsonValue &hash=QJsonValue::Null) {
    return {{"action",action},{"offset",offset},{"limit",limit},{"snapshot",hash}};
}
QJsonObject history_request(const Fixture &f,int offset=0,int limit=50,const QJsonValue &hash=QJsonValue::Null) {
    auto result=page("activation-history",offset,limit,hash); result["projectId"]=f.id; return result;
}
const QJsonObject find_item(const QJsonArray &items,const QString &id) {
    for(const auto &item:items) if(item.toObject()["operationId"]==id) return item.toObject();
    throw lmti::Error("Expected private operation missing from result.");
}
void inspect_and_preview(const Facade &api) {
    for(const int schema:{1,2,3}) {
        Fixture f(schema,schema!=1);
        require(QDir().rmdir(f.root),"Offline linked-root fixture failed.");
        const auto result=api.call(f,{{"action","inspect"},{"projectId",f.id}});
        success(result,"inspect",{"libraryIdentity","project"}); identity(result["libraryIdentity"].toObject(),schema);
        const auto project=result["project"].toObject();
        fields(project,{"projectId","name","database","root","schemaVersion","storeUuid","revision"},"Selected project shape differs");
        check(project["projectId"]==f.id && project["database"]==f.source && project["root"]==f.root &&
              project["schemaVersion"].toInt()==(schema==1?1:2) && project["revision"].toInteger()==1,
              "Selected owner state or offline linked root changed");
        check(schema==1 ? project["storeUuid"]=="" : !project["storeUuid"].toString().isEmpty(),"Native UUID null semantics changed");
        auto args=api.arguments(f); args[4]=f.temp.filePath("missing-copy-parent");
        const auto without_parent=api.raw(f,QJsonDocument(QJsonObject{{"action","inspect"},{"projectId",f.id}}).toJson(QJsonDocument::Compact),args);
        check(without_parent==result,"Inspect unnecessarily depends on copy-parent existence");
        const auto mode=schema==1?"migrate_v1":"clone_v2";
        const QJsonObject request{{"action","copy-preview"},{"projectId",f.id},{"mode",mode}};
        const auto preview=api.raw(f,QJsonDocument(request).toJson(QJsonDocument::Compact),args);
        success(preview,"copy-preview",{"libraryIdentity","projectId","preview"});
        const auto actual=lmti::inspect_project_copy(f.source,schema==1?lmti::ProjectCopyMode::MigrateV1:lmti::ProjectCopyMode::CloneV2);
        const auto value=preview["preview"].toObject();
        fields(value,{"mode","seedsInternalSites","source","targetRevision","targetContentDigest","targetRegistryDigest"},
               "Preview shape differs");
        token(value["source"].toObject(),actual.source);
        check(preview["projectId"]==f.id && value["mode"]==mode && value["seedsInternalSites"]==actual.seeds_internal_sites &&
              value["targetRevision"].toInteger()==actual.target_revision &&
              value["targetContentDigest"]==actual.target_content_digest && value["targetRegistryDigest"]==actual.target_registry_digest,
              "Copy preview lost owner policy or target metadata");
        refusal(api.call(f,{{"action","copy-preview"},{"projectId",f.id},{"mode",schema==1?"clone_v2":"migrate_v1"}}),"UNSUPPORTED_SCHEMA");
        refusal(api.call(f,{{"action","inspect"},{"projectId","absent-project"}}),"SCOPE_DENIED");
        if(schema<3) refusal(api.call(f,history_request(f)),"UNSUPPORTED_FORMAT");
    }
}
void inspection_does_not_apply_copy_revision_budget(const Facade &api) {
    Fixture f;
    // Fixed test-only SQL inside this new QTemporaryDir reaches the domain's
    // last valid revision without trillions of synthetic saves. The façade
    // itself exposes no SQL or revision mutation.
    const auto name=uuid();
    {
        auto database=QSqlDatabase::addDatabase("QSQLITE",name); database.setDatabaseName(f.source);
        require(database.open(),"Revision fixture open failed.");
        {
            QSqlQuery query(database);
            require(query.prepare("UPDATE project SET revision=?"),"Revision fixture prepare failed.");
            query.addBindValue(QVariant::fromValue<qint64>(9007199254740990LL));
            require(query.exec(),"Revision fixture update failed.");
        }
        database.close(); database={};
    }
    QSqlDatabase::removeDatabase(name);
    const auto inspected=api.call(f,{{"action","inspect"},{"projectId",f.id}});
    success(inspected,"inspect",{"libraryIdentity","project"});
    check(inspected["project"].toObject()["revision"].toInteger()==9007199254740990LL,
          "Read-only inspect incorrectly applies copy N+1 exhaustion");
    refusal(api.call(f,{{"action","copy-preview"},{"projectId",f.id},{"mode","migrate_v1"}}),"BUDGET_EXCEEDED");
}
void malformed_requests_and_mode(const Facade &api) {
    Fixture f;
    const std::vector<QByteArray> invalid{
        "", "[]", "null", "{", "{\"action\":\"inspect\",\"action\":\"inspect\",\"projectId\":\"selected-project\"}",
        "{\"action\":\"inspect\",\"projectId\":\"selected-project\",\"projectId\":\"selected-project\"}",
        "{\"action\":\"inspect\",\"projectId\":\"selected-project\",\"source\":\"untrusted\"}",
        "{\"action\":\"inspect\",\"projectId\":\"../selected-project\"}",
        "{\"action\":\"copy-preview\",\"projectId\":\"selected-project\",\"mode\":\"auto\"}",
        "{\"action\":\"copy-inspect\",\"operationId\":\"../target\"}",
        "{\"action\":\"copy-inspect\",\"operationId\":\"AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA\"}",
        "{\"action\":\"inspect\",\"projectId\":null}",
        QByteArray("{\"action\":\"inspect\",\"projectId\":\"")+QByteArray::fromHex("ff")+"\"}",
        QByteArray(32769,' ')
    };
    for(const auto &request:invalid) refusal(api.raw(f,request));
    for(const auto *action:{"copy-prepare","copy-write","upgrade","prepare-activation","activate","abandon","save","generate"}) {
        refusal(api.call(f,{{"action",action},{"projectId",f.id}}));
    }
    for(const auto *key:{"source","target","root","library","expected","profile"}) {
        QJsonObject request{{"action","inspect"},{"projectId",f.id}}; request[key]="caller-supplied";
        refusal(api.call(f,request));
    }
    const auto valid=QJsonDocument(QJsonObject{{"action","inspect"},{"projectId",f.id}}).toJson(QJsonDocument::Compact);
    // Binary stdin must preserve Ctrl+Z and NUL suffixes instead of accepting the JSON prefix.
    refusal(api.raw(f,valid+QByteArray(1,'\x1a')+"garbage"),"INVALID_INPUT");
    refusal(api.raw(f,valid+QByteArray(1,'\0')),"INVALID_INPUT");
    auto args=api.arguments(f); args<<"extra"; refusal(api.raw(f,valid,args));
    args=api.arguments(f); args[3]="--backup-parent"; refusal(api.raw(f,valid,args));
    args=api.arguments(f); args[2]=f.library+":stream"; refusal(api.raw(f,valid,args));
    args=api.arguments(f); args[4]="relative-copy-parent"; refusal(api.raw(f,valid,args));
    for(const auto *action:{"copy-discover","activation-history"}) {
        auto base=page(action); if(QString::fromLatin1(action)=="activation-history") base["projectId"]=f.id;
        std::vector<QJsonObject> bad;
        for(const auto &value:QJsonArray{-1,1001,0.5,true}) { auto r=base; r["offset"]=value; bad.push_back(r); }
        for(const auto &value:QJsonArray{0,51,0.5,true}) { auto r=base; r["limit"]=value; bad.push_back(r); }
        { auto r=base; r["snapshot"]=QString(64,'a'); bad.push_back(r); }
        for(const auto &value:QJsonArray{QJsonValue::Null,QString(64,'A'),QString(63,'a')}) {
            auto r=base; r["offset"]=1; r["snapshot"]=value; bad.push_back(r);
        }
        { auto r=base; r["cursor"]="not-a-protocol-field"; bad.push_back(r); }
        for(const auto &request:bad) refusal(api.call(f,request));
    }
}
void copy_discovery_paging_and_status(const Facade &api) {
    Fixture f;
    const auto first=f.copy(),second=f.copy();
    const auto one=api.call(f,page("copy-discover",0,1));
    success(one,"copy-discover",{"complete","code","examinedEntries","unattributedEntries","snapshot","offset","nextOffset","items"});
    check(one["complete"]==true && one["code"]=="NONE" && one["examinedEntries"]==2 && one["unattributedEntries"]==0 &&
          one["offset"]==0 && one["nextOffset"]==1 && one["items"].toArray().size()==1,"Initial discovery page differs");
    const auto two=api.call(f,page("copy-discover",1,1,one["snapshot"]));
    check(two["snapshot"]==one["snapshot"] && two["offset"]==1 && two["nextOffset"].isNull() && two["items"].toArray().size()==1,
          "Discovery pagination did not keep one unchanged snapshot");
    QJsonArray items=one["items"].toArray(); items.append(two["items"].toArray().at(0));
    check(items.at(0).toObject()["operationId"].toString()<items.at(1).toObject()["operationId"].toString(),"Discovery ordering is unstable");
    const auto expected_hash=digest({{"complete",true},{"code","NONE"},{"examinedEntries",2},{"unattributedEntries",0},{"items",items}});
    check(one["snapshot"]==expected_hash,"Discovery digest omits full scan metadata or sorted candidate contents");
    for(const auto &copy:{first,second}) {
        const auto row=find_item(items,copy.operation_id);
        fields(row,{"operationId","state","intent"},"Discovery row shape differs");
        check(row["state"]=="uninspected" && row["intent"].isObject(),"Discovery falsely verified or lost real copy intent");
        const auto intent=row["intent"].toObject();
        fields(intent,{"mode","seedsInternalSites","source","target"},"Intent shape differs");
        token(intent["source"].toObject(),copy.source); token(intent["target"].toObject(),copy.target);
        const auto inspected=api.call(f,{{"action","copy-inspect"},{"operationId",copy.operation_id}});
        success(inspected,"copy-inspect",{"status"}); const auto status=inspected["status"].toObject();
        fields(status,{"operationId","state","code","mode","seedsInternalSites","verifiedReceipt","source","target"},"Copy status shape differs");
        check(status["operationId"]==copy.operation_id && status["state"]=="prepared" && status["code"]=="NONE" &&
              status["verifiedReceipt"]==true,"Independent real copy inspection failed");
        token(status["source"].toObject(),copy.source); token(status["target"].toObject(),copy.target);
    }
    const auto terminal=api.call(f,page("copy-discover",2,1,one["snapshot"]));
    check(terminal["ok"]==true && terminal["items"].toArray().isEmpty() && terminal["nextOffset"].isNull(),"Terminal empty page refused");
    refusal(api.call(f,page("copy-discover",3,1,one["snapshot"])));
    refusal(api.call(f,page("copy-discover",1,1,QString(64,'0'))),"CONFIG_CHANGED");
    require(QFile::rename(f.source,f.temp.filePath("retained-source.sqlite")),"Source removal fixture failed.");
    const auto gone=api.call(f,page("copy-discover",0,1));
    check(gone==one,"Discovery read source or included source availability in intent-only snapshot");
    auto no_library=api.arguments(f); no_library[2]=f.temp.filePath("never-created-library.sqlite");
    check(api.raw(f,QJsonDocument(page("copy-discover",0,1)).toJson(QJsonDocument::Compact),no_library)==one,
          "Copy discovery unnecessarily opens or requires the library");
    const QJsonObject inspect_request{{"action","copy-inspect"},{"operationId",first.operation_id}};
    check(api.raw(f,QJsonDocument(inspect_request).toJson(QJsonDocument::Compact),no_library)==api.call(f,inspect_request),
          "Copy inspection unnecessarily opens or requires the library");
    const auto empty=uuid(),invalid=uuid();
    mkdir(f.parent,empty);
    refusal(api.call(f,page("copy-discover",1,1,one["snapshot"])),"CONFIG_CHANGED");
    put(at(mkdir(f.parent,invalid),"intent.json"),"{");
    const auto current=api.call(f,page("copy-discover"));
    check(current["complete"]==true && current["examinedEntries"]==4 && current["unattributedEntries"]==2,
          "Stable empty/malformed reservations were omitted or hid completeness");
    for(const auto &id:{empty,invalid}) {
        const auto row=find_item(current["items"].toArray(),id);
        check(row["state"]==(id==empty?"incomplete":"invalid") && row["intent"].isNull(),"Invalid intent gained attribution");
        const auto inspected=api.call(f,{{"action","copy-inspect"},{"operationId",id}})["status"].toObject();
        check(inspected["state"]=="recovery_required" && inspected["code"]!="NONE" && inspected["mode"].isNull() &&
              inspected["seedsInternalSites"].isNull() && inspected["source"].isNull() && inspected["target"].isNull(),
              "Incomplete inspection presented default initialization as observed copy metadata");
    }
    const auto verified=at(at(f.parent,first.operation_id),"verified.json");
    require(QFile::rename(verified,f.temp.filePath("retained-verified.json")),"Final receipt removal fixture failed.");
    const auto reconciled=api.call(f,{{"action","copy-inspect"},{"operationId",first.operation_id}})["status"].toObject();
    check(reconciled["state"]=="prepared" && reconciled["verifiedReceipt"]==false,
          "Independent inspection fabricated a missing verified receipt");
    put(at(at(f.parent,second.operation_id),"project.sqlite"),"Controlled invalid target bytes");
    const auto failed_target=api.call(f,{{"action","copy-inspect"},{"operationId",second.operation_id}})["status"].toObject();
    check(failed_target["state"]=="recovery_required" && failed_target["code"]!="NONE" &&
          failed_target["mode"]=="migrate_v1" && failed_target["seedsInternalSites"]==true,
          "Target failure discarded valid intent metadata or falsely reported a prepared copy");
    token(failed_target["source"].toObject(),second.source); token(failed_target["target"].toObject(),second.target);
}
void history_pages_follow_receipts_not_source_readability(const Facade &api) {
    Fixture f(3,true);
    const auto copy=f.copy(),foreign_copy=f.copy(true);
    const auto a=f.prepare_activation(copy),b=f.prepare_activation(copy),c=f.prepare_activation(copy);
    const auto foreign=f.prepare_activation(foreign_copy,true);
    (void)foreign;
    const auto initial=api.call(f,history_request(f,0,1));
    success(initial,"activation-history",{"libraryIdentity","projectId","snapshot","offset","nextOffset","items"});
    check(initial["projectId"]==f.id && initial["items"].toArray().size()==1 && initial["nextOffset"]==1,
          "Initial history page did not filter/paginate selected project");
    const auto library_before=lmti::inspect_project_library(f.library).token;
    const auto abandoned=lmti::abandon_library_activation(f.library,b.token);
    require(abandoned.code==lmti::LibraryCode::None,"Native abandon fixture failed.");
    check(lmti::inspect_project_library(f.library).token==library_before,"Receipt-only fixture unexpectedly changed binding authority");
    refusal(api.call(f,history_request(f,1,1,initial["snapshot"])),"CONFIG_CHANGED");
    const auto activated=lmti::activate_library_copy(f.library,f.parent,c.token);
    require(activated.code==lmti::LibraryCode::None,"Native activation fixture failed.");
    const auto all=api.call(f,history_request(f));
    identity(all["libraryIdentity"].toObject(),3);
    const auto rows=all["items"].toArray();
    check(rows.size()==3 && all["nextOffset"].isNull(),"Foreign receipt leaked into project history or rows lost");
    QMap<QString,QString> expected{{a.token.operation_id,"prepared"},{b.token.operation_id,"abandoned"},{c.token.operation_id,"activated"}};
    QString previous;
    for(const auto &value:rows) {
        const auto row=value.toObject(); const auto id=row["operationId"].toString();
        fields(row,{"operationId","projectId","copyOperationId","state","revision"},"History row shape differs");
        check(expected.contains(id) && expected.value(id)==row["state"].toString() && row["projectId"]==f.id &&
              row["copyOperationId"]==copy.operation_id && row["revision"].toInteger()==(id==a.token.operation_id?1:2),
              "History did not preserve actual prepared/abandoned/activated owner receipts");
        check(previous.isEmpty() || previous<id,"History ordering unstable"); previous=id;
    }
    check(all["snapshot"]==digest({{"libraryIdentity",all["libraryIdentity"]},{"projectId",f.id},{"items",rows}}),
          "History snapshot omits receipt states or selected library identity");
    const auto first=api.call(f,history_request(f,0,1));
    const auto second=api.call(f,history_request(f,1,1,first["snapshot"]));
    check(first["snapshot"]==second["snapshot"] && second["nextOffset"]==2,"Stable history continuation failed");
    const auto terminal=api.call(f,history_request(f,3,1,first["snapshot"]));
    check(terminal["ok"]==true && terminal["items"].toArray().isEmpty() && terminal["nextOffset"].isNull(),"History terminal page failed");
    refusal(api.call(f,history_request(f,4,1,first["snapshot"])));
    require(QFile::rename(f.source,f.temp.filePath("retained-original.sqlite")),"Original source removal fixture failed.");
    require(QFile::rename(copy.target.canonical_path,f.temp.filePath("retained-active-target.sqlite")),"Active target removal fixture failed.");
    check(api.call(f,history_request(f))==all,"History required source or active project readability");
    refusal(api.call(f,{{"action","inspect"},{"projectId",f.id}}),"OWNER_UNAVAILABLE");
    const auto absent=lmti::forget_library_project_cas(f.library,f.id,lmti::inspect_project_library(f.library).token);
    (void)absent;
    const auto forgotten=api.call(f,history_request(f));
    check(forgotten["ok"]==true && forgotten["items"]==all["items"],"History required current project registration");
}
void missing_library_is_not_created(const Facade &api) {
    Fixture f;
    require(QFile::rename(f.library,f.temp.filePath("retained-library.sqlite")),"Missing library fixture failed.");
    refusal(api.call(f,{{"action","inspect"},{"projectId",f.id}}),"OWNER_UNAVAILABLE");
    refusal(api.call(f,history_request(f)),"OWNER_UNAVAILABLE");
    const auto discovery=api.call(f,page("copy-discover"));
    check(discovery["ok"]==true && discovery["complete"]==true && discovery["items"].toArray().isEmpty(),
          "Empty copy discovery requires unrelated library existence");
    check(!QFileInfo::exists(f.library),"Read-only action created a missing library");
}
}
int main(int argc,char **argv) {
    QCoreApplication app(argc,argv);
    try {
        require(app.arguments().size()==2,"Provide the current native admin executable.");
        Facade api(app.arguments().at(1));
        inspect_and_preview(api); inspection_does_not_apply_copy_revision_budget(api); malformed_requests_and_mode(api);
        copy_discovery_paging_and_status(api); history_pages_follow_receipts_not_source_readability(api);
        missing_library_is_not_created(api);
    } catch(const std::exception &error) {
        std::cerr<<"Unexpected project-operations fixture failure: "<<error.what()<<'\n'; return 1;
    }
    std::cout<<"Project-operations process checks: "<<failures<<" failures; all requests read-only.\n";
    return failures?1:0;
}
