#include "lmti/project_library.hpp"
#include "lmti/project_original_read.hpp"
#ifdef Q_OS_WIN
#define NOMINMAX
#include <windows.h>
#endif
#include <QCoreApplication>
#include <QDir>
#include <QFile>
#include <QFileInfo>
#include <QJsonArray>
#include <QJsonDocument>
#include <QProcess>
#include <QProcessEnvironment>
#include <QSet>
#include <QSqlDatabase>
#include <QSqlQuery>
#include <QTemporaryDir>
#include <QUuid>
#include <algorithm>
#include <filesystem>
#include <functional>
#include <iostream>
#include <iterator>
#include <map>
#include <optional>
#include <stdexcept>
#include <type_traits>

namespace {
using namespace lmti;
int checks = 0, failures = 0, skipped = 0;
constexpr qsizetype input_cap = 64 * 1024, output_cap = 512 * 1024;
void check(bool ok, const char *message, const char *context = nullptr) {
    ++checks;
    if (!ok) {
        ++failures;
        if (context) std::cerr << '[' << context << "] ";
        std::cerr << message << '\n';
    }
}
void require(bool ok, const char *message) { if (!ok) throw std::runtime_error(message); }
QString s(const std::string &v) { return QString::fromStdString(v); }
QByteArray bytes(const QString &path) {
    QFile f(path); require(f.open(QIODevice::ReadOnly), "Fixture read failed."); return f.readAll();
}
void fields(const QJsonObject &o, const QSet<QString> &wanted, const char *message, const char *context = nullptr) {
    QSet<QString> found; for (auto it=o.begin(); it!=o.end(); ++it) found.insert(it.key());
    check(found == wanted, message, context);
}
// Fixed SQL below only constructs controlled drift in fresh QTemporaryDir files.
class Sql {
    QString name_ = QUuid::createUuid().toString();
  public:
    QSqlDatabase db;
    explicit Sql(const QString &path) {
        require(QFileInfo::exists(path), "Fixture SQL path must exist.");
        db=QSqlDatabase::addDatabase("QSQLITE",name_); db.setDatabaseName(path);
        require(db.open(), "Fixture SQL open failed.");
    }
    ~Sql() { db.close(); db={}; QSqlDatabase::removeDatabase(name_); }
    void exec(const QString &statement) { QSqlQuery q(db); require(q.exec(statement), "Fixture SQL failed."); }
};

template<class T> const T &find(const std::vector<T> &rows,const std::string &id) {
    const auto it=std::find_if(rows.begin(),rows.end(),[&](const auto &r){return r.id==id;});
    require(it!=rows.end(),"Synthetic fixture row missing.");return *it;
}
QJsonObject encode(const Site &r) {return {{"id",s(r.id)},{"label",s(r.label)},{"privacy",s(name(r.privacy))}};}
QJsonObject encode(const Environment &r) {return {{"id",s(r.id)},{"label",s(r.label)},{"privacy",s(name(r.privacy))}};}
QJsonObject encode(const Area &r) {return {{"id",s(r.id)},{"label",s(r.label)},{"siteId",s(r.site_id)},
    {"parentAreaId",s(r.parent_area_id)},{"privacy",s(name(r.privacy))}};}
QJsonObject encode(const PhysicalAssetAnchor &r) {return {{"id",s(r.id)},{"label",s(r.label)},{"site",s(r.site)},
    {"kind",s(name(r.kind))},{"privacy",s(name(r.privacy))}};}
QJsonValue encode(const std::optional<AssetPlacement> &r) {
    if(!r)return QJsonValue(QJsonValue::Null);
    return QJsonObject{{"assetId",s(r->asset_id)},{"areaId",s(r->area_id)},{"parentAssetId",s(r->parent_asset_id)},
        {"environmentId",s(r->environment_id)},{"role",r->role?QJsonValue(s(name(*r->role))):QJsonValue(QJsonValue::Null)}};
}
PhysicalAssetAnchor anchor(const ProjectDocument &d,const std::string &id) {
    const auto &a=find(d.topology.assets,id);return {a.id,a.label,a.site,a.kind,a.privacy};
}
QJsonObject proposal_json(const PhysicalHierarchyProposal &p) {
    QJsonArray changes;
    for(const auto &change:p.changes)changes.append(std::visit([](const auto &r)->QJsonObject {
        using T=std::decay_t<decltype(r)>;
        if constexpr(std::is_same_v<T,AddSite>)return {{"kind","add_site"},{"desired",encode(r.desired)}};
        else if constexpr(std::is_same_v<T,RenameSite>)return {{"kind","rename_site"},{"expected",encode(r.expected)},{"desiredLabel",s(r.desired_label)}};
        else if constexpr(std::is_same_v<T,RetireEmptySite>)return {{"kind","retire_empty_site"},{"expected",encode(r.expected)}};
        else if constexpr(std::is_same_v<T,AddArea>)return {{"kind","add_area"},{"desired",encode(r.desired)}};
        else if constexpr(std::is_same_v<T,RenameArea>)return {{"kind","rename_area"},{"expected",encode(r.expected)},{"desiredLabel",s(r.desired_label)}};
        else if constexpr(std::is_same_v<T,ReparentArea>)return {{"kind","reparent_area"},{"expected",encode(r.expected)},{"desiredParentId",s(r.desired_parent_id)}};
        else if constexpr(std::is_same_v<T,RetireEmptyArea>)return {{"kind","retire_empty_area"},{"expected",encode(r.expected)}};
        else if constexpr(std::is_same_v<T,AddEnvironment>)return {{"kind","add_environment"},{"desired",encode(r.desired)}};
        else if constexpr(std::is_same_v<T,RenameEnvironment>)return {{"kind","rename_environment"},{"expected",encode(r.expected)},{"desiredLabel",s(r.desired_label)}};
        else if constexpr(std::is_same_v<T,RetireEmptyEnvironment>)return {{"kind","retire_empty_environment"},{"expected",encode(r.expected)}};
        else return {{"kind","set_asset_placement"},{"expectedAsset",encode(r.expected_asset)},
            {"expected",encode(r.expected)},{"desired",encode(r.desired)}};
    },change));
    return {{"projectId",s(p.project_id)},{"expectedRevision",qint64(p.expected_revision)},{"changes",changes}};
}
ProjectDocument document() {
    auto d=demo_project();d.structure.emplace();
    d.structure->sites={{"factory-demo","Factory",Privacy::Public},{"empty-site","Empty",Privacy::Public}};
    d.structure->areas={{"floor","Floor","factory-demo","",Privacy::Public},
        {"cell","Cell","factory-demo","floor",Privacy::Public},{"spare","Spare","factory-demo","",Privacy::Public},
        {"empty-area","Empty","factory-demo","",Privacy::Public}};
    d.structure->environments={{"env","Environment",Privacy::Public},{"empty-env","Empty",Privacy::Public}};
    d.structure->asset_placements={{"machine-a","cell","gateway-b","env",PhysicalRole::Device},
        {"gateway-b","cell","broker-c","env",PhysicalRole::Gateway},{"broker-c","cell","","env",PhysicalRole::Host}};
    d.topology.assets.push_back({"free","Unplaced","factory-demo",Kind::Sensor,Privacy::Public});
    d.structure->subsystems={{"software","Software","",Privacy::Public}};
    d.structure->component_memberships={{"sensor-firmware","software"}};
    d.releases.front().state=ReleaseState::Approved;d.topology.assets.front().poll_ms=2345;
    d.topology.assets.front().observed=Observation::Online;d.topology.assets.front().observed_at=23;
    d.knowledge={{"design","Design","sensor-firmware","synthetic-ref","synthetic-revision",Privacy::Internal}};
    validate(d);return d;
}
struct Fixture {
    QTemporaryDir temp;
    QString source,library,folder,backups;
    ProjectDocument d;
    explicit Fixture(ProjectDocument input=document(),int schema=2) {
        require(temp.isValid(),"Fixture directory unavailable.");
        source=temp.filePath(QString::fromUtf8("physical-Σ.sqlite"));library=temp.filePath("library.sqlite");
        folder=temp.filePath("linked-root");backups=temp.filePath("backups");
        require(QDir(temp.path()).mkdir("linked-root")&&QDir(temp.path()).mkdir("backups"),"Fixture parents failed.");
        input.topology.revision=save_project(source,input);d=load_project(source);
        remember_library_project(library,{s(d.project.id),"Physical fixture",source,folder,false,17});
        if(schema>=2)require(upgrade_project_library(library,backups,inspect_project_library(library).token).state==
            LibraryUpgradeState::Upgraded,"Fixture library upgrade failed.");
        if(schema==3)require(upgrade_library_activation_format(library,backups,
            inspect_library_activation_upgrade(library)).state==LibraryUpgradeState::Upgraded,"Fixture format upgrade failed.");
    }
    PhysicalHierarchyScope scope(bool internal=true)const{return {d.project.id,true,internal};}
};
PhysicalHierarchyProposal rename(const Fixture &f,const std::string &label="Reviewed physical site") {
    return {f.d.project.id,f.d.topology.revision,{RenameSite{find(f.d.structure->sites,"factory-demo"),label}}};
}
QJsonObject preview_request(const PhysicalHierarchyProposal &p) {
    return {{"action","physical-hierarchy-preview"},{"proposal",proposal_json(p)}};
}
QJsonObject commit_request(const QJsonObject &r) {return {{"action","physical-hierarchy-commit"},{"expected",r["expected"]}};}
QJsonObject library_json(const LibraryToken &t) {
    return {{"schema",t.schema},{"canonicalPath",t.canonical_path},
        {"uuid",t.schema==1?QJsonValue(QJsonValue::Null):QJsonValue(t.library_uuid)},
        {"generation",t.schema==1?QJsonValue(QJsonValue::Null):QJsonValue(t.generation)},{"digest",t.digest}};
}
QJsonObject physical_json(const QString &path) {
    QJsonArray chain;QStringList parts;QString cursor=QDir::cleanPath(path);
    while(true) {parts.prepend(cursor);const auto parent=QFileInfo(cursor).dir().absolutePath();if(parent==cursor)break;cursor=parent;}
#ifdef Q_OS_WIN
    for(qsizetype i=0;i<parts.size();++i) {
        const bool directory=i+1<parts.size();
        const auto handle=CreateFileW(reinterpret_cast<LPCWSTR>(parts[i].utf16()),FILE_READ_ATTRIBUTES,
            FILE_SHARE_READ|FILE_SHARE_WRITE|FILE_SHARE_DELETE,nullptr,OPEN_EXISTING,
            FILE_FLAG_OPEN_REPARSE_POINT|(directory?FILE_FLAG_BACKUP_SEMANTICS:0),nullptr);
        require(handle!=INVALID_HANDLE_VALUE,"Independent identity open failed.");
        BY_HANDLE_FILE_INFORMATION info{};
        const auto ok=GetFileInformationByHandle(handle,&info);const auto closed=CloseHandle(handle);
        require(ok&&closed&&!(info.dwFileAttributes&FILE_ATTRIBUTE_REPARSE_POINT)&&
            bool(info.dwFileAttributes&FILE_ATTRIBUTE_DIRECTORY)==directory&&(directory||info.nNumberOfLinks==1),
            "Independent identity fixture invalid.");
        const auto ticks=(quint64(info.ftCreationTime.dwHighDateTime)<<32)|info.ftCreationTime.dwLowDateTime;
        require(ticks>116444736000000000ULL,"Identity birth predates supported epoch.");
        chain.append(QJsonObject{{"dev",QString::number(info.dwVolumeSerialNumber)},
            {"ino",QString::number((quint64(info.nFileIndexHigh)<<32)|info.nFileIndexLow)},
            {"birthtimeNs",QString::number(ticks-116444736000000000ULL)+"00"}});
    }
#else
    (void)parts;
#endif
    return {{"version",1},{"path",QDir::cleanPath(path)},{"kind","file"},{"state","present"},{"chain",chain}};
}
QJsonObject original_request(const Fixture &f) {
    const auto library=inspect_project_library(f.library).token;
    const auto current=load_project(f.source);
    return {{"action","physical-hierarchy-original-state"},{"expected",QJsonObject{
        {"version",1},{"projectId",s(f.d.project.id)},{"library",QJsonObject{
            {"schema",library.schema},{"canonicalPath",library.canonical_path},
            {"uuid",library.schema==1?QJsonValue(QJsonValue::Null):QJsonValue(library.library_uuid)},
            {"physical",physical_json(f.library)}}},{"project",QJsonObject{{"schema",2},
                {"storeUuid",s(current.storage_lineage->store_uuid)},{"physical",physical_json(f.source)}}},
        {"linkedRoot",f.folder}}}};
}
struct Reply { QJsonObject json; qsizetype size; };
class Facade {
    QString real_,fault_;
  public:
    Facade(QString real,QString fault):real_(std::move(real)),fault_(std::move(fault)){}
    QStringList args(const Fixture &f,bool write=false,bool internal=true) const {
        return {write?"--physical-hierarchy-write":"--physical-hierarchy-read","--library",f.library,
                "--project",s(f.d.project.id),"--visibility",internal?"internal":"public"};
    }
    Reply raw(const Fixture &f,const QByteArray &input,bool write=false,bool internal=true,
              const QString &fault={},bool shipped=false,QStringList arguments={}) const {
        QProcess child; child.setProgram(fault.isEmpty()||shipped?real_:fault_);
        child.setArguments(arguments.isEmpty()?args(f,write,internal):arguments);
        auto env=QProcessEnvironment::systemEnvironment();
        env.remove("LMTI_PHYSICAL_HIERARCHY_FACADE_FAULT"); env.remove("LMTI_PROJECT_OPERATION_WRITE_TEST_FAULT");
        env.remove("LMTI_HIERARCHY_FACADE_FAULT");
        if(!fault.isEmpty()) env.insert("LMTI_PHYSICAL_HIERARCHY_FACADE_FAULT",fault);
        child.setProcessEnvironment(env); child.setProcessChannelMode(QProcess::SeparateChannels);
        QByteArray output,errors; bool overflow=false;
        const auto drain=[&]{
            const auto part=child.readAllStandardOutput(), err=child.readAllStandardError();
            if(output.size()+part.size()>output_cap) overflow=true; else if(!overflow) output+=part;
            if(errors.size()+err.size()>4096) overflow=true; else errors+=err;
        };
        QObject::connect(&child,&QProcess::readyReadStandardOutput,&child,drain);
        QObject::connect(&child,&QProcess::readyReadStandardError,&child,drain);
        child.start(); require(child.waitForStarted(5000),"Hierarchy child did not start.");
        require(child.write(input)==input.size(),"Hierarchy child input incomplete."); child.closeWriteChannel();
        // Never kill/retry a dispatched mutator. Outer CTest bounds this fixture.
        if(!child.waitForFinished(30000)) {
            check(false,"Hierarchy child exceeded controlled deadline"); child.waitForFinished(-1);
        }
        drain();
        require(!overflow && errors.isEmpty() && child.exitStatus()==QProcess::NormalExit &&
                    child.exitCode()==0,"Hierarchy child framing/exit contract failed.");
        require(output.endsWith('\n') && !output.endsWith("\r\n") && output.size()<=output_cap,
                "Hierarchy child violated binary LF frame/cap.");
        QJsonParseError error; const auto parsed=QJsonDocument::fromJson(output,&error);
        require(error.error==QJsonParseError::NoError && parsed.isObject(),"Hierarchy child JSON invalid.");
        return {parsed.object(),output.size()};
    }
    Reply call(const Fixture &f,const QJsonObject &request,bool write=false,bool internal=true,
               const QString &fault={},bool shipped=false) const {
        return raw(f,QJsonDocument(request).toJson(QJsonDocument::Compact),write,internal,fault,shipped);
    }
};
void read_error(const Reply &r,const char *code,const char *context=nullptr) {
    fields(r.json,{"ok","code"},"Read refusal returned partial material",context);
    check(r.json["ok"]==false && r.json["code"]==code,"Read refusal code differs",context);
}
void read_ok(const Reply &r,const char *action,const QSet<QString> &extra) {
    auto wanted=extra; wanted.unite({"ok","schema","action"}); fields(r.json,wanted,"Read success fields differ");
    require(r.json["ok"]==true && r.json["schema"]=="lmti.physical-hierarchy.owner.v1" &&
            r.json["action"]==action,"Read action did not succeed.");
}
void write_reply(const Reply &r,const char *outcome,bool details,const char *code=nullptr,bool null_action=false) {
    fields(r.json,{"schema","action","outcome","code","operationId","details","detailsAvailable"},"Write outcome shape differs");
    check(r.json["schema"]=="lmti.project.operation.write.v1" && r.json["outcome"]==outcome &&
              r.json["operationId"].isNull() && r.json["detailsAvailable"]==details,"Write outcome flags differ");
    check(null_action?r.json["action"].isNull():r.json["action"]=="physical-hierarchy-commit","Write action correlation differs");
    check(details?r.json["details"].isObject():r.json["details"].isNull(),"Write details null semantics differ");
    if(code) check(r.json["code"]==code,"Write error code differs");
}
Reply preview(const Facade &api,const Fixture &f,const PhysicalHierarchyProposal &p) {
    const auto r=api.call(f,preview_request(p));
    read_ok(r,"physical-hierarchy-preview",{"expected","diff"});
    fields(r.json["expected"].toObject(),{"libraryIdentity","reviewToken"},"Preview expected shape differs");
    return r;
}
void same_source(const Fixture &f,const QByteArray &source,const QByteArray &library,const char *message) {
    check(bytes(f.source)==source && bytes(f.library)==library,message);
}


QJsonObject projected(const QJsonArray &rows,const QString &id) {
    for(const auto &row:rows)if(row.toObject()["value"].toObject()["id"]==id)return row.toObject();
    return {};
}
QJsonObject affected(const QJsonArray &rows,const QString &kind,const QString &id) {
    for(const auto &row:rows) {
        const auto value=row.toObject();
        if(value["kind"]==kind && value["id"]==id)return value;
    }
    return {};
}
void normalize(ProjectDocument &d) {
    auto order=[](auto &rows){std::sort(rows.begin(),rows.end(),[](const auto &a,const auto &b){return a.id<b.id;});};
    if(!d.structure)return;
    order(d.structure->sites);order(d.structure->areas);order(d.structure->environments);
    std::sort(d.structure->asset_placements.begin(),d.structure->asset_placements.end(),
        [](const auto &a,const auto &b){return a.asset_id<b.asset_id;});
}
void all_eleven(const Facade &api) {
    Fixture f;const auto before=bytes(f.source),library=bytes(f.library);
    const PhysicalHierarchyProposal p{f.d.project.id,1,{
        AddArea{{"new-area","New area","new-site","",Privacy::Internal}},
        AddSite{{"new-site","New site",Privacy::Internal}},
        RenameSite{find(f.d.structure->sites,"factory-demo"),"Reviewed factory"},
        RetireEmptySite{find(f.d.structure->sites,"empty-site")},
        RenameArea{find(f.d.structure->areas,"floor"),"Reviewed floor"},
        ReparentArea{find(f.d.structure->areas,"cell"),"spare"},
        RetireEmptyArea{find(f.d.structure->areas,"empty-area")},
        AddEnvironment{{"new-env","New environment",Privacy::Internal}},
        RenameEnvironment{find(f.d.structure->environments,"env"),"Reviewed environment"},
        RetireEmptyEnvironment{find(f.d.structure->environments,"empty-env")},
        SetAssetPlacement{anchor(f.d,"free"),std::nullopt,AssetPlacement{"free","","","",std::nullopt}}}};
    const auto r=preview(api,f,p);
    const auto expected=r.json["expected"].toObject(),token=expected["reviewToken"].toObject(),diff=r.json["diff"].toObject();
    fields(token,{"schema","schemaVersion","projectId","canonicalPath","storeUuid","revision","contentDigest",
        "registryDigest","scope","proposal","proposalDigest","diffDigest"},"Physical token shape differs");
    fields(token["scope"].toObject(),{"projectId","allowPhysicalWrite","allowInternal"},"Physical scope fields differ");
    fields(diff,{"sites","areas","environments","placements","affected"},"Physical diff shape differs");
    check(token["schema"]=="lmti.physical-hierarchy.review.v1"&&token["proposal"].toObject()["changes"].toArray().size()==11,
          "Physical token lost type tag or one operation");
    check(diff["sites"].toArray().size()==3&&diff["areas"].toArray().size()==4&&
        diff["environments"].toArray().size()==3&&diff["placements"].toArray().size()==1,
        "Eleven-operation diff omitted changed catalog or placement rows");
    const auto move=affected(diff["affected"].toArray(),"asset","machine-a");
    fields(move,{"kind","id","beforeClassification","afterClassification","beforePath","afterPath"},"Affected path shape differs");
    const auto oldpath=move["beforePath"].toObject(),newpath=move["afterPath"].toObject();
    check(oldpath["areaAncestors"].toArray()==QJsonArray{"floor","cell"}&&
        newpath["areaAncestors"].toArray()==QJsonArray{"spare","cell"}&&
        newpath["assetAncestors"].toArray()==QJsonArray{"broker-c","gateway-b"}&&newpath["environmentId"]=="env",
        "Unchanged descendant lost complete ordered physical paths");
    for(const auto &kind:{"site","area","environment","asset"}) {
        bool found=false;for(const auto &a:diff["affected"].toArray())if(a.toObject()["kind"]==kind)found=true;
        check(found,"A physical affected kind was omitted");
    }
    const auto placed=diff["placements"].toArray().first().toObject();
    check(placed["before"].isNull()&&placed["after"].isObject()&&placed["after"].toObject()["role"].isNull(),
          "Absent placement and declared empty unknown role were conflated");
    // Native owner comparison tests domain/wire correlation; paths and final
    // document expectations above/below are constructed independently.
    const auto direct=export_physical_hierarchy_review(preview_physical_hierarchy(f.source,f.scope(),p));
    check(token["proposalDigest"]==direct.proposal_digest&&token["diffDigest"]==direct.diff_digest&&
        token["proposal"].toObject()==proposal_json(direct.proposal),"Wire token differs from physical owner token");
    auto reversed=p;std::reverse(reversed.changes.begin(),reversed.changes.end());
    check(preview(api,f,reversed).json==r.json,"Normalized review depends on caller operation order");
    same_source(f,before,library,"Preview mutated a store");
    const auto request=commit_request(r.json);
    const auto input=QJsonDocument(request).toJson(QJsonDocument::Compact);
    check(input.size()+1<=input_cap,"Emitted review cannot fit future commit input");
    const auto result=api.call(f,request,true);write_reply(result,"confirmed",true,"NONE");
    const auto details=result.json["details"].toObject();
    fields(details,{"projectId","storeUuid","previousRevision","revision","proposalDigest"},"Confirmed correlation fields differ");
    check(details["projectId"]==s(f.d.project.id)&&details["storeUuid"]==token["storeUuid"]&&
        details["proposalDigest"]==token["proposalDigest"]&&details["previousRevision"]==1&&details["revision"]==2,
        "Confirmed result is not correlated with reviewed identity/revision");
    auto wanted=f.d;auto &st=*wanted.structure;
    st.sites.push_back({"new-site","New site",Privacy::Internal});
    std::erase_if(st.sites,[](const auto &a){return a.id=="empty-site";});
    for(auto &a:st.sites)if(a.id=="factory-demo")a.label="Reviewed factory";
    st.areas.push_back({"new-area","New area","new-site","",Privacy::Internal});
    std::erase_if(st.areas,[](const auto &a){return a.id=="empty-area";});
    for(auto &a:st.areas){if(a.id=="floor")a.label="Reviewed floor";if(a.id=="cell")a.parent_area_id="spare";}
    st.environments.push_back({"new-env","New environment",Privacy::Internal});
    std::erase_if(st.environments,[](const auto &a){return a.id=="empty-env";});
    for(auto &a:st.environments)if(a.id=="env")a.label="Reviewed environment";
    st.asset_placements.push_back({"free","","","",std::nullopt});wanted.topology.revision=2;
    auto actual=load_project(f.source);normalize(wanted);normalize(actual);
    check(actual==wanted,"Commit changed unrelated typed metadata, logical structure, observations or release evidence");
    check(bytes(f.library)==library,"Project commit changed library");
    const auto committed=bytes(f.source);
    write_reply(api.call(f,request,true),"refused",false,"CONFIG_CHANGED");
    const PhysicalHierarchyProposal reuse{f.d.project.id,2,{AddSite{{"empty-site","Replacement",Privacy::Internal}}}};
    read_error(api.call(f,preview_request(reuse)),"CONFIG_CHANGED");
    same_source(f,committed,library,"Replay or retired identity reuse changed stores");
    std::cout<<"Physical accepted batch: changes=11; responseBytes="<<r.size<<"; commitBytes="<<input.size()+1<<".\n";
}
void token_and_scope(const Facade &api) {
    Fixture f;const auto r=preview(api,f,rename(f));const auto before=bytes(f.source),library=bytes(f.library);
    const auto change=[&](const std::function<void(QJsonObject &)> &mutate,const char *code) {
        auto request=commit_request(r.json),expected=request["expected"].toObject(),token=expected["reviewToken"].toObject();
        mutate(token);expected["reviewToken"]=token;request["expected"]=expected;
        write_reply(api.call(f,request,true),"refused",false,code);
        same_source(f,before,library,"Tampered token changed stores");
    };
    change([](auto &t){t["schema"]="lmti.logical-hierarchy.review.v1";},"INVALID_INPUT");
    change([](auto &t){t["proposalDigest"]=QString(64,'0');},"INVALID_INPUT");
    change([](auto &t){t["diffDigest"]=QString(64,'0');},"CONFIG_CHANGED");
    change([](auto &t){t["contentDigest"]=QString(64,'0');},"CONFIG_CHANGED");
    change([](auto &t){t["registryDigest"]=QString(64,'0');},"CONFIG_CHANGED");
    change([](auto &t){t["storeUuid"]=QUuid::createUuid().toString(QUuid::WithoutBraces).toLower();},"CONFIG_CHANGED");
    change([](auto &t){auto scope=t["scope"].toObject();scope["allowPhysicalWrite"]=false;t["scope"]=scope;},"SCOPE_DENIED");
    change([](auto &t){auto scope=t["scope"].toObject();scope["allowLogicalWrite"]=true;t["scope"]=scope;},"INVALID_INPUT");
    change([](auto &t){t["projectId"]="different-project";},"SCOPE_DENIED");
    change([](auto &t){
        const auto path=t["canonicalPath"].toString();t["canonicalPath"]=path.left(path.lastIndexOf('/')+1)+"never-open.sqlite";
    },"CONFIG_CHANGED");
    check(!QFileInfo::exists(f.temp.filePath("never-open.sqlite")),"Private canonical comparison key was opened/created");
    change([](auto &t){
        auto p=t["proposal"].toObject();auto changes=p["changes"].toArray();auto item=changes[0].toObject();
        item["desiredLabel"]="Substituted";changes[0]=item;p["changes"]=changes;t["proposal"]=p;
    },"INVALID_INPUT");
    write_reply(api.call(f,commit_request(r.json),true,false),"refused",false,"SCOPE_DENIED");
}
void identity_drift(const Facade &api) {
    for(const auto &sql:{
        "UPDATE project SET label='Same revision independent metadata'",
        "INSERT INTO identity_registry VALUES('area','retired-history','retired')",
        "UPDATE store_identity SET store_uuid='11111111-1111-4111-8111-111111111111'"}) {
        Fixture f;const auto r=preview(api,f,rename(f));
        {Sql db(f.source);db.exec(sql);}
        const auto before=bytes(f.source),library=bytes(f.library);
        write_reply(api.call(f,commit_request(r.json),true),"refused",false,"CONFIG_CHANGED");
        same_source(f,before,library,"Same-revision identity/graph/registry drift was overwritten");
    }
    Fixture f;const auto r=preview(api,f,rename(f));
    const auto initial=inspect_project_library(f.library).token;
    const auto other=f.temp.filePath("other-root");require(QDir(f.temp.path()).mkdir("other-root"),"ABA root creation failed.");
    const auto moved=link_library_folder_cas(f.library,s(f.d.project.id),other,initial);
    const auto returned=link_library_folder_cas(f.library,s(f.d.project.id),f.folder,moved);
    check(returned.generation==initial.generation+2&&returned.library_uuid==initial.library_uuid&&returned.digest==initial.digest,
          "Fixture did not perform an actual root ABA");
    const auto before=bytes(f.source),library=bytes(f.library);
    write_reply(api.call(f,commit_request(r.json),true),"refused",false,"CONFIG_CHANGED");
    same_source(f,before,library,"Root ABA stale review changed stores");
}
void placement_and_policy(const Facade &api) {
    Fixture f;const auto library=bytes(f.library);
    const auto blank=AssetPlacement{"free","","","",std::nullopt};
    auto r=preview(api,f,{f.d.project.id,1,{SetAssetPlacement{anchor(f.d,"free"),std::nullopt,blank}}});
    write_reply(api.call(f,commit_request(r.json),true),"confirmed",true,"NONE");
    r=preview(api,f,{f.d.project.id,2,{SetAssetPlacement{anchor(f.d,"free"),blank,std::nullopt}}});
    check(r.json["diff"].toObject()["placements"].toArray()[0].toObject()["after"].isNull(),"Explicit removal encoded as empty placement");
    write_reply(api.call(f,commit_request(r.json),true),"confirmed",true,"NONE");
    const auto read=api.call(f,{{"action","physical-hierarchy-state"}});
    read_ok(read,"physical-hierarchy-state",{"libraryIdentity","projectIdentity","projection"});
    check(projected(read.json["projection"].toObject()["assets"].toArray(),"free")["placement"].isNull(),"Removed placement remains declared");
    f.d=load_project(f.source);const auto before=bytes(f.source);
    const auto refuse=[&](const PhysicalHierarchyProposal &p,const char *code,bool internal=true){
        read_error(api.call(f,preview_request(p),false,internal),code);
        same_source(f,before,library,"Refused policy review changed stores");
    };
    refuse({f.d.project.id,3,{RenameSite{find(f.d.structure->sites,"factory-demo"),"Factory"}}},"INVALID_INPUT");
    refuse({f.d.project.id,3,{ReparentArea{find(f.d.structure->areas,"floor"),"cell"}}},"INVALID_INPUT");
    refuse({f.d.project.id,3,{RetireEmptyArea{find(f.d.structure->areas,"cell")}}},"CONFIG_CHANGED");
    refuse({f.d.project.id,3,{SetAssetPlacement{anchor(f.d,"free"),std::nullopt,
        AssetPlacement{"free","cell","missing-parent","env",PhysicalRole::Device}}}},"SCOPE_DENIED");
    refuse({f.d.project.id,3,{AddEnvironment{{"public-add","Public addition",Privacy::Public}}}},"SCOPE_DENIED");
    auto hidden=document();for(auto &a:hidden.structure->areas)if(a.id=="cell")a.privacy=Privacy::Internal;
    Fixture private_fixture(hidden);
    auto expected=find(private_fixture.d.structure->areas,"cell");expected.label="Wrong old value";
    const PhysicalHierarchyProposal deny{private_fixture.d.project.id,1,{RenameArea{expected,"New"}}};
    read_error(api.call(private_fixture,preview_request(deny),false,false),"SCOPE_DENIED");
    expected.id="missing-area";
    read_error(api.call(private_fixture,preview_request({private_fixture.d.project.id,1,{RenameArea{expected,"New"}}}),false,false),
        "SCOPE_DENIED");
    const auto oldplacement=*std::find_if(private_fixture.d.structure->asset_placements.begin(),
        private_fixture.d.structure->asset_placements.end(),[](const auto &a){return a.asset_id=="machine-a";});
    auto placement=oldplacement;placement.area_id="spare";placement.parent_asset_id="";
    read_error(api.call(private_fixture,preview_request({private_fixture.d.project.id,1,{
        SetAssetPlacement{anchor(private_fixture.d,"machine-a"),oldplacement,placement}}})),
        "SCOPE_DENIED");
}
void state_and_original(const Facade &api) {
    auto d=document();
    d.structure->sites.push_back({"private-site","Private site",Privacy::Internal});
    d.structure->areas.push_back({"hidden","Hidden","factory-demo","",Privacy::Internal});
    d.structure->areas.push_back({"public-child","Public child","factory-demo","hidden",Privacy::Public});
    d.structure->environments.push_back({"private-env","Private environment",Privacy::Internal});
    d.topology.assets.push_back({"hidden-area-asset","Hidden by area","factory-demo",Kind::Sensor,Privacy::Public});
    d.topology.assets.push_back({"hidden-env-asset","Hidden by environment","factory-demo",Kind::Sensor,Privacy::Public});
    d.topology.assets.push_back({"hidden-site-asset","Hidden unplaced by site","private-site",Kind::Sensor,Privacy::Public});
    d.structure->asset_placements.push_back({"hidden-area-asset","public-child","","",std::nullopt});
    d.structure->asset_placements.push_back({"hidden-env-asset","","","private-env",std::nullopt});
    Fixture f(d,3);const auto before=bytes(f.source),library=bytes(f.library);
    const auto internal=api.call(f,{{"action","physical-hierarchy-state"}});
    read_ok(internal,"physical-hierarchy-state",{"libraryIdentity","projectIdentity","projection"});
    const auto full=internal.json["projection"].toObject();
    fields(full,{"projectId","revision","sites","areas","environments","assets"},"Full physical projection fields differ");
    check(projected(full["areas"].toArray(),"public-child")["ancestors"].toArray()==QJsonArray{"hidden"}&&
        projected(full["areas"].toArray(),"public-child")["classification"]=="internal","Area inherited path/privacy lost");
    for(const auto &id:{"hidden-area-asset","hidden-env-asset","hidden-site-asset"})
        check(projected(full["assets"].toArray(),id)["classification"]=="internal","Effective asset privacy lost");
    check(!projected(full["environments"].toArray(),"empty-env").isEmpty(),"Unused authorized catalog omitted");
    const auto machine=projected(full["assets"].toArray(),"machine-a");
    check(machine["path"].toObject()["areaAncestors"].toArray()==QJsonArray{"floor","cell"}&&
        machine["path"].toObject()["assetAncestors"].toArray()==QJsonArray{"broker-c","gateway-b"},
        "Complete state physical ancestors differ");
    const auto external=api.call(f,{{"action","physical-hierarchy-state"}},false,false);
    read_ok(external,"physical-hierarchy-state",{"libraryIdentity","projectIdentity","projection"});
    const auto visible=external.json["projection"].toObject();
    check(projected(visible["areas"].toArray(),"hidden").isEmpty()&&projected(visible["areas"].toArray(),"public-child").isEmpty(),
        "Hidden ancestry promoted a public child");
    for(const auto &id:{"hidden-area-asset","hidden-env-asset","hidden-site-asset"})
        check(projected(visible["assets"].toArray(),id).isEmpty(),"Hidden physical asset escaped filtering");
    check(projected(visible["assets"].toArray(),"free")["placement"].isNull(),"Unplaced asset gained an inferred role");
    const auto locator=api.call(f,{{"action","physical-hierarchy-locator"}});
    read_ok(locator,"physical-hierarchy-locator",{"libraryIdentity","projectId","database","linkedRoot"});
    check(locator.json["database"]==f.source&&locator.json["linkedRoot"]==f.folder,"Locator changed private I/O spelling");
    same_source(f,before,library,"Physical state/locator changed stores");
#ifdef Q_OS_WIN
    const auto request=original_request(f);
    const auto original=api.call(f,request);
    read_ok(original,"physical-hierarchy-original-state",{"libraryIdentity","projectIdentity","projection"});
    check(original.json["projection"].toObject()==full&&original.json["projectIdentity"]==internal.json["projectIdentity"],
        "Conditional original state differs from same captured owner state");
    auto wrong=request,expected=wrong["expected"].toObject();expected["linkedRoot"]=f.temp.filePath("different-root");wrong["expected"]=expected;
    read_error(api.call(f,wrong),"CONFIG_CHANGED");
    wrong=request;expected=wrong["expected"].toObject();auto project=expected["project"].toObject();
    project["storeUuid"]="11111111-1111-4111-8111-111111111111";expected["project"]=project;wrong["expected"]=expected;
    read_error(api.call(f,wrong),"CONFIG_CHANGED");
    wrong=request;expected=wrong["expected"].toObject();project=expected["project"].toObject();
    auto physical=project["physical"].toObject();physical["state"]="unsupported";project["physical"]=physical;
    expected["project"]=project;wrong["expected"]=expected;read_error(api.call(f,wrong),"RECOVERY_REQUIRED");
    const auto mutate_physical=[&](const std::function<void(QJsonObject &)> &fn,const char *code){
        auto input=request,e=input["expected"].toObject(),p=e["project"].toObject(),physical=p["physical"].toObject();
        fn(physical);p["physical"]=physical;e["project"]=p;input["expected"]=e;read_error(api.call(f,input),code);
    };
    mutate_physical([](auto &p){p["extra"]=true;},"INVALID_INPUT");
    mutate_physical([](auto &p){auto chain=p["chain"].toArray();auto row=chain[0].toObject();row["dev"]=1;chain[0]=row;p["chain"]=chain;},
        "INVALID_INPUT");
    mutate_physical([](auto &p){auto chain=p["chain"].toArray();auto row=chain[0].toObject();row["ino"]="01";chain[0]=row;p["chain"]=chain;},
        "INVALID_INPUT");
    mutate_physical([](auto &p){auto chain=p["chain"].toArray();chain[0]=QJsonValue(QJsonValue::Null);p["chain"]=chain;},
        "RECOVERY_REQUIRED");
    wrong=request;expected=wrong["expected"].toObject();expected["profiles"]=QJsonObject{};wrong["expected"]=expected;
    read_error(api.call(f,wrong),"INVALID_INPUT");
    same_source(f,before,library,"Conditional refusal changed original stores");
    auto next=load_project(f.source);next.project.label="Known independent fresh revision";save_project(f.source,next);
    const auto fresh=api.call(f,request);
    read_ok(fresh,"physical-hierarchy-original-state",{"libraryIdentity","projectIdentity","projection"});
    check(fresh.json["projection"].toObject()["revision"]==2,"Original identity read incorrectly pins historical revision");
#else
    ++skipped;std::cout<<"SKIP Windows original physical identity wire.\n";
#endif
}
void source_boundaries(const Facade &api) {
    Fixture missing;const auto absent=missing.temp.filePath("absent.sqlite");
    // Preserve the original file; mutate only the disposable library locator.
    {Sql db(missing.library);QSqlQuery q(db.db);q.prepare("UPDATE library_entries SET path=?");q.addBindValue(absent);
        require(q.exec(),"Missing locator fixture failed.");}
    const auto library=bytes(missing.library);
    read_error(api.call(missing,{{"action","physical-hierarchy-state"}}),"OWNER_UNAVAILABLE");
    read_error(api.call(missing,preview_request(rename(missing))),"OWNER_UNAVAILABLE");
    const auto locator=api.call(missing,{{"action","physical-hierarchy-locator"}});
    read_ok(locator,"physical-hierarchy-locator",{"libraryIdentity","projectId","database","linkedRoot"});
    check(locator.json["database"]==absent&&!QFileInfo::exists(absent)&&bytes(missing.library)==library,
          "Library-only locator probed/created offline project or changed library");
    Fixture legacy(demo_project(),1);
    read_error(api.call(legacy,{{"action","physical-hierarchy-state"}}),"UNSUPPORTED_SCHEMA");
    Fixture v1(document(),1);
    const auto previewed=preview(api,v1,rename(v1));
    const auto identity=previewed.json["expected"].toObject()["libraryIdentity"].toObject();
    check(identity["schema"]==1&&identity["uuid"].isNull()&&identity["generation"].isNull(),"V1 library invented durable identity");
    write_reply(api.call(v1,commit_request(previewed.json),true),"confirmed",true,"NONE");
    Fixture last;{Sql db(last.source);db.exec("UPDATE project SET revision=9007199254740990");}
    last.d=load_project(last.source);const auto lastbytes=bytes(last.source),lastlibrary=bytes(last.library);
    const auto state=api.call(last,{{"action","physical-hierarchy-state"}});
    read_ok(state,"physical-hierarchy-state",{"libraryIdentity","projectIdentity","projection"});
    check(state.json["projection"].toObject()["revision"].toInteger()==9007199254740990LL,"Last valid native revision unreadable");
    read_error(api.call(last,preview_request(rename(last))),"BUDGET_EXCEEDED");
    same_source(last,lastbytes,lastlibrary,"Exhausted revision mutated stores");
}
void strict_inputs(const Facade &api) {
    Fixture f;const auto before=bytes(f.source),library=bytes(f.library);
    const QByteArray state="{\"action\":\"physical-hierarchy-state\"}";
    struct InvalidInput { const char *label; QByteArray bytes; };
    const InvalidInput malformed[]={
        {"duplicate-action","{\"action\":\"physical-hierarchy-state\",\"action\":\"physical-hierarchy-state\"}"},
        {"extra-state-field","{\"action\":\"physical-hierarchy-state\",\"extra\":1}"},
        {"null-action","{\"action\":null}"},{"array-root","[]"},
        {"trailing-ctrl-z",state+QByteArray(1,'\x1a')+"garbage"},
        {"trailing-nul",state+QByteArray(1,'\0')}};
    for(const auto &input:malformed)read_error(api.raw(f,input.bytes),"INVALID_INPUT",input.label);
    const auto metadata=QJsonDocument(preview_request(rename(f,"LABEL_MARKER"))).toJson(QJsonDocument::Compact);
    require(metadata.count("\"LABEL_MARKER\"")==1,"Malformed metadata fixture is not unique.");
    auto bad_utf8=metadata;bad_utf8.replace("\"LABEL_MARKER\"",QByteArray("\"before")+QByteArray::fromHex("ff")+"after\"");
    read_error(api.raw(f,bad_utf8),"INVALID_INPUT","invalid-utf8-label");
    const InvalidInput invalid_labels[]={
        {"unpaired-high-surrogate-label","\"before\\ud800after\""},
        {"unpaired-low-surrogate-label","\"before\\udc00after\""},
        {"reversed-surrogate-pair-label","\"before\\udc00\\ud800after\""}};
    for(const auto &input:invalid_labels) {
        auto request=metadata;request.replace("\"LABEL_MARKER\"",input.bytes);
        read_error(api.raw(f,request),"INVALID_INPUT",input.label);
    }
    auto paired=metadata;paired.replace("\"LABEL_MARKER\"","\"before\\ud83d\\ude80after\"");
    const auto paired_reply=api.raw(f,paired);
    read_ok(paired_reply,"physical-hierarchy-preview",{"expected","diff"});
    const auto paired_label=QString::fromUtf8(QByteArray("before")+QByteArray::fromHex("f09f9a80")+"after");
    const auto paired_proposal=paired_reply.json["expected"].toObject()["reviewToken"].toObject()["proposal"].toObject();
    check(paired_proposal["changes"].toArray()[0].toObject()["desiredLabel"]==paired_label,
          "Valid surrogate pair changed in normalized proposal","paired-surrogate-label");
    check(paired_reply.json["diff"].toObject()["sites"].toArray()[0].toObject()["after"].toObject()["label"]==paired_label,
          "Valid surrogate pair changed in complete diff","paired-surrogate-label");
    auto nested_duplicate=metadata;
    nested_duplicate.replace("\"desiredLabel\":\"LABEL_MARKER\"","\"desiredLabel\":\"LABEL_MARKER\",\"desiredLabel\":\"LABEL_MARKER\"");
    read_error(api.raw(f,nested_duplicate),"INVALID_INPUT","duplicate-desired-label");
    auto exact=state;exact.append(QByteArray(input_cap-exact.size(),' '));
    read_ok(api.raw(f,exact),"physical-hierarchy-state",{"libraryIdentity","projectIdentity","projection"});
    exact.append(' ');read_error(api.raw(f,exact),"INVALID_INPUT","over-cap-read");
    write_reply(api.raw(f,exact,true),"refused",false,"INVALID_INPUT",true);
    auto args=api.args(f);args.removeLast();read_error(api.raw(f,state,false,true,{},false,args),"INVALID_INPUT","invalid-argv-count");
    args=api.args(f);args.append("extra");read_error(api.raw(f,state,false,true,{},false,args),"INVALID_INPUT","invalid-argv-count");
    const auto base=preview_request(rename(f));
    const auto mutate=[&](const char *label,const std::function<void(QJsonObject &)> &fn,const char *code="INVALID_INPUT"){
        auto request=base,p=request["proposal"].toObject();fn(p);request["proposal"]=p;read_error(api.call(f,request),code,label);
    };
    mutate("fractional-revision",[](auto &p){p["expectedRevision"]=1.5;});
    mutate("string-revision",[](auto &p){p["expectedRevision"]=QString("1");});
    mutate("empty-changes",[](auto &p){p["changes"]=QJsonArray{};});
    mutate("too-many-changes",[](auto &p){auto changes=p["changes"].toArray();const auto row=changes[0];for(int i=1;i<33;++i)changes.append(row);p["changes"]=changes;},"BUDGET_EXCEEDED");
    mutate("duplicate-target",[](auto &p){auto changes=p["changes"].toArray();changes.append(changes[0]);p["changes"]=changes;});
    mutate("extra-change-field",[](auto &p){auto changes=p["changes"].toArray(),r=changes;auto item=changes[0].toObject();item["extra"]=true;r[0]=item;p["changes"]=r;});
    mutate("invalid-id",[](auto &p){auto changes=p["changes"].toArray();auto item=changes[0].toObject();auto old=item["expected"].toObject();
        old["id"]="invalid/id";item["expected"]=old;changes[0]=item;p["changes"]=changes;});
    mutate("oversize-label",[](auto &p){auto changes=p["changes"].toArray();auto item=changes[0].toObject();item["desiredLabel"]=QString(121,'x');changes[0]=item;p["changes"]=changes;});
    auto placement=preview_request({f.d.project.id,1,{SetAssetPlacement{anchor(f.d,"free"),std::nullopt,
        AssetPlacement{"free","","","",std::nullopt}}}});
    auto p=placement["proposal"].toObject(),changes=p["changes"].toArray()[0].toObject();
    auto desired=changes["desired"].toObject();desired["role"]="unknown";changes["desired"]=desired;p["changes"]=QJsonArray{changes};
    placement["proposal"]=p;read_error(api.call(f,placement),"INVALID_INPUT","invalid-physical-role");
    const auto valid=preview(api,f,rename(f));
    auto bad=commit_request(valid.json);bad["extra"]=1;write_reply(api.call(f,bad,true),"refused",false,"INVALID_INPUT");
    write_reply(api.call(f,{{"action","physical-hierarchy-commit"},{"expected",QJsonValue(QJsonValue::Null)}},true),
        "refused",false,"INVALID_INPUT");
    write_reply(api.call(f,{{"action","arbitrary-unrecognized"}},true),"refused",false,"INVALID_INPUT",true);
    write_reply(api.raw(f,"{\"action\":\"physical-hierarchy-commit\",\"action\":\"physical-hierarchy-commit\"}",true),
        "refused",false,"INVALID_INPUT",true);
    same_source(f,before,library,"Malformed or bounded read/write input changed stores");
}
void fault_outcomes(const Facade &api) {
    struct Case {const char *fault,*outcome,*code;bool committed,details;};
    const Case cases[]={
        {"before_owner","refused","OWNER_UNAVAILABLE",false,false},
        {"entered_owner","unknown","OWNER_UNAVAILABLE",false,false},
        {"during_rewrite","unknown","OWNER_UNAVAILABLE",false,false},
        {"before_commit","unknown","OWNER_UNAVAILABLE",false,false},
        {"after_commit","unknown","RECOVERY_REQUIRED",true,false},
        {"after_confirmed","confirmed","NONE",true,false}};
    for(const auto &c:cases) {
        Fixture f;const auto r=preview(api,f,rename(f));const auto before=bytes(f.source),library=bytes(f.library);
        const auto result=api.call(f,commit_request(r.json),true,true,c.fault);
        write_reply(result,c.outcome,c.details,c.code);
        const auto actual=load_project(f.source);
        check(actual.topology.revision==(c.committed?2:1),"Injected phase durability differs from independent owner read");
        check(find(actual.structure->sites,"factory-demo").label==(c.committed?"Reviewed physical site":"Factory"),
            "Injected commit/rollback persisted unexpected graph");
        check(bytes(f.library)==library,"Fault path changed library");
        if(!c.committed)check(bytes(f.source)==before,"Pre-commit fault did not roll back exact source bytes");
        else {
            const auto committed=bytes(f.source);
            write_reply(api.call(f,commit_request(r.json),true),"refused",false,"CONFIG_CHANGED");
            check(bytes(f.source)==committed,"Stale retry after actual commit advanced again");
        }
    }
    Fixture production;const auto review=preview(api,production,rename(production));
    write_reply(api.call(production,commit_request(review.json),true,true,"during_rewrite",true),"confirmed",true,"NONE");
    check(load_project(production.source).topology.revision==2,"Isolated fault selector entered shipped binary");
}
void linked_library(const Facade &api) {
    Fixture f;const auto r=preview(api,f,rename(f));const auto before=bytes(f.source),library=bytes(f.library);
    const auto alias=f.temp.filePath("library-hardlink.sqlite");
    std::error_code error;
#ifdef Q_OS_WIN
    std::filesystem::create_hard_link(std::filesystem::path(f.library.toStdWString()),std::filesystem::path(alias.toStdWString()),error);
#else
    std::filesystem::create_hard_link(std::filesystem::path(f.library.toStdString()),std::filesystem::path(alias.toStdString()),error);
#endif
    if(error){++skipped;std::cout<<"SKIP local hardlink fixture unavailable.\n";return;}
    read_error(api.call(f,{{"action","physical-hierarchy-state"}}),"OWNER_UNAVAILABLE");
    read_error(api.call(f,preview_request(rename(f))),"OWNER_UNAVAILABLE");
    write_reply(api.call(f,commit_request(r.json),true),"refused",false,"OWNER_UNAVAILABLE");
    same_source(f,before,library,"Linked library refusal changed stores");
    check(bytes(alias)==library,"Linked alias changed on refusal");
}
ProjectDocument workload(int assets) {
    auto d=document();d.bindings.clear();d.work.clear();d.topology.assets.clear();d.topology.links.clear();
    d.structure->sites={{"factory-demo","Factory",Privacy::Public}};d.structure->areas.clear();
    d.structure->environments.clear();d.structure->asset_placements.clear();
    std::string parent;
    for(int i=0;i<31;++i) {
        const auto id="area-"+std::to_string(i)+"-"+std::string(50,'x');
        d.structure->areas.push_back({id,"Area","factory-demo",parent,Privacy::Public});parent=id;
    }
    for(int i=0;i<assets;++i) {
        const auto id="asset-"+std::to_string(i);
        d.topology.assets.push_back({id,"Asset","factory-demo",Kind::Sensor,Privacy::Public});
        d.structure->asset_placements.push_back({id,parent,"","",std::nullopt});
    }
    validate(d);return d;
}
void workload_caps(const Facade &api) {
    for(const auto count:{16,2000}) {
        Fixture f(workload(count));const auto before=bytes(f.source),library=bytes(f.library);
        const auto read=api.call(f,{{"action","physical-hierarchy-state"}});
        const auto r=api.call(f,preview_request(rename(f)));
        const auto direct=preview_physical_hierarchy(f.source,f.scope(),rename(f));
        check(direct.diff().affected.size()==static_cast<std::size_t>(count+32),
              "Valid deep/broad workload lost complete descendants");
        for(const auto &a:direct.diff().affected)if(a.kind==PhysicalHierarchyEntityKind::Asset)
            check(a.before_path.area_ancestors.size()==31&&a.after_path.area_ancestors.size()==31,
                  "Workload did not have exact combined depth32");
        if(count==16) {
            read_ok(read,"physical-hierarchy-state",{"libraryIdentity","projectIdentity","projection"});
            read_ok(r,"physical-hierarchy-preview",{"expected","diff"});
            check(r.json["diff"].toObject()["affected"].toArray().size()==count+32,"Accepted review truncated descendants");
            const auto request=commit_request(r.json);const auto input=QJsonDocument(request).toJson(QJsonDocument::Compact);
            check(input.size()+1<=input_cap,"Accepted workload review cannot be committed within input cap");
            same_source(f,before,library,"Accepted workload reads changed stores");
            write_reply(api.call(f,request,true),"confirmed",true,"NONE");
            check(load_project(f.source).topology.revision==2,"Accepted workload commit did not increment once");
            std::cout<<"Physical workload accepted: assets="<<count<<"; depth=32; stateBytes="<<read.size
                <<"; responseBytes="<<r.size<<"; commitBytes="<<input.size()+1<<".\n";
        } else {
            read_error(read,"BUDGET_EXCEEDED");read_error(r,"BUDGET_EXCEEDED");
            same_source(f,before,library,"Oversize valid state/review changed stores");
            std::cout<<"Physical workload refused: assets="<<count<<"; depth=32; affected="<<direct.diff().affected.size()
                <<"; emittedStateBytes="<<read.size<<"; emittedResponseBytes="<<r.size<<"; no partial review.\n";
        }
    }
}
} // namespace

int main(int argc,char **argv) {
    QCoreApplication app(argc,argv);
    if(app.arguments().size()!=3){std::cerr<<"Provide production and isolated physical admin paths.\n";return 1;}
    const Facade api(app.arguments()[1],app.arguments()[2]);
    const std::pair<const char *,void(*)(const Facade &)> cases[]={
        {"all_eleven",all_eleven},{"token_and_scope",token_and_scope},{"identity_drift",identity_drift},
        {"placement_and_policy",placement_and_policy},{"state_and_original",state_and_original},
        {"source_boundaries",source_boundaries},{"strict_inputs",strict_inputs},{"fault_outcomes",fault_outcomes},
        {"linked_library",linked_library},{"workload_caps",workload_caps}};
    int passed=0;
    for(const auto &[name,call]:cases) {
        const auto before=failures,skipped_before=skipped;
        try{call(api);}catch(const std::exception &){++failures;std::cerr<<name<<": bounded fixture/transport exception.\n";}
        if(before==failures&&skipped_before==skipped)++passed;
        std::cout<<name<<": "<<(before!=failures?"FAIL":skipped_before!=skipped?"SKIP":"PASS")<<'\n';
    }
    std::cout<<"Physical hierarchy transport: "<<passed<<'/'<<std::size(cases)<<" cases passed; "<<checks
        <<" behavioral checks; "<<failures<<" failures; "<<skipped<<" skipped.\n";
    return failures?1:0;
}
