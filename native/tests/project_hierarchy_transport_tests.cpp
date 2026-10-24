#include "lmti/project_library.hpp"
#include "../common/strict_json.hpp"
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
void check(bool ok, const char *message) { ++checks; if (!ok) { ++failures; std::cerr << message << '\n'; } }
void require(bool ok, const char *message) { if (!ok) throw std::runtime_error(message); }
QString s(const std::string &v) { return QString::fromStdString(v); }
QByteArray bytes(const QString &path) {
    QFile f(path); require(f.open(QIODevice::ReadOnly), "Fixture read failed."); return f.readAll();
}
void fields(const QJsonObject &o, const QSet<QString> &wanted, const char *message) {
    QSet<QString> found; for (auto it=o.begin(); it!=o.end(); ++it) found.insert(it.key());
    check(found == wanted, message);
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
QJsonObject subsystem_json(const Subsystem &r) {
    return {{"id",s(r.id)},{"label",s(r.label)},{"parentSubsystemId",s(r.parent_subsystem_id)},{"privacy",s(name(r.privacy))}};
}
QJsonObject component_json(const SoftwareComponent &r) {
    return {{"id",s(r.id)},{"label",s(r.label)},{"repositoryId",s(r.repository_id)},
            {"kind",s(name(r.kind))},{"privacy",s(name(r.privacy))}};
}
QJsonValue member_json(const std::optional<ComponentMembership> &r) {
    return r ? QJsonValue(QJsonObject{{"componentId",s(r->component_id)},{"subsystemId",s(r->subsystem_id)}})
             : QJsonValue(QJsonValue::Null);
}
QJsonArray ids_json(const std::vector<std::string> &ids) {
    QJsonArray result; for (const auto &id:ids) result.append(s(id)); return result;
}
QJsonValue privacy_json(const std::optional<Privacy> &p) {
    return p ? QJsonValue(s(name(*p))) : QJsonValue(QJsonValue::Null);
}
QJsonObject proposal_json(const LogicalHierarchyProposal &p) {
    QJsonArray ops;
    for (const auto &change:p.changes) ops.append(std::visit([](const auto &op)->QJsonObject {
        using T=std::decay_t<decltype(op)>;
        if constexpr(std::is_same_v<T,AddSubsystem>)
            return {{"kind","add_subsystem"},{"desired",subsystem_json(op.desired)}};
        else if constexpr(std::is_same_v<T,RenameSubsystem>)
            return {{"kind","rename_subsystem"},{"expected",subsystem_json(op.expected)},{"desiredLabel",s(op.desired_label)}};
        else if constexpr(std::is_same_v<T,ReparentSubsystem>)
            return {{"kind","reparent_subsystem"},{"expected",subsystem_json(op.expected)},{"desiredParentId",s(op.desired_parent_id)}};
        else if constexpr(std::is_same_v<T,RetireEmptySubsystem>)
            return {{"kind","retire_empty_subsystem"},{"expected",subsystem_json(op.expected)}};
        else return {{"kind","set_component_membership"},{"expectedComponent",component_json(op.expected_component)},
            {"expected",member_json(op.expected)},{"desiredSubsystemId",op.desired_subsystem_id
                ? QJsonValue(s(*op.desired_subsystem_id)) : QJsonValue(QJsonValue::Null)}};
    },change));
    return {{"projectId",s(p.project_id)},{"expectedRevision",qint64(p.expected_revision)},{"changes",ops}};
}
QJsonObject snapshot_json(const ProjectCopyToken &t) {
    return {{"schemaVersion",t.schema},{"projectId",t.project_id},{"canonicalPath",t.canonical_path},
        {"storeUuid",t.store_uuid},{"revision",qint64(t.revision)},{"contentDigest",t.content_digest},{"registryDigest",t.registry_digest}};
}
QJsonObject library_json(const LibraryToken &t) {
    return {{"schema",t.schema},{"canonicalPath",t.canonical_path},
        {"uuid",t.schema==1?QJsonValue(QJsonValue::Null):QJsonValue(t.library_uuid)},
        {"generation",t.schema==1?QJsonValue(QJsonValue::Null):QJsonValue(t.generation)},{"digest",t.digest}};
}
QJsonObject token_json(const HierarchyReviewToken &t) {
    auto o=snapshot_json(t.snapshot);
    o["schema"]="lmti.logical-hierarchy.review.v1";
    o["scope"]=QJsonObject{{"projectId",s(t.scope.project_id)},{"allowLogicalWrite",t.scope.allow_logical_write},
                          {"allowInternal",t.scope.allow_internal}};
    o["proposal"]=proposal_json(t.proposal); o["proposalDigest"]=t.proposal_digest; o["diffDigest"]=t.diff_digest;
    return o;
}
QJsonObject diff_json(const LogicalHierarchyDiff &d) {
    QJsonArray subs,members,affected;
    for(const auto &r:d.subsystems) subs.append(QJsonObject{{"id",s(r.id)},
        {"before",r.before?QJsonValue(subsystem_json(*r.before)):QJsonValue(QJsonValue::Null)},
        {"after",r.after?QJsonValue(subsystem_json(*r.after)):QJsonValue(QJsonValue::Null)}});
    for(const auto &r:d.memberships) members.append(QJsonObject{{"componentId",s(r.component_id)},
        {"before",member_json(r.before)},{"after",member_json(r.after)}});
    for(const auto &r:d.affected) affected.append(QJsonObject{
        {"kind",r.kind==HierarchyEntityKind::Subsystem?"subsystem":"component"},{"id",s(r.id)},
        {"beforeClassification",privacy_json(r.before_classification)},{"afterClassification",privacy_json(r.after_classification)},
        {"beforeAncestors",ids_json(r.before_ancestors)},{"afterAncestors",ids_json(r.after_ancestors)}});
    return {{"subsystems",subs},{"memberships",members},{"affected",affected}};
}
ProjectDocument document() {
    auto d=demo_project(); d.repositories.front().locator="fixture-private-repository";
    d.knowledge={{"design","Design","sensor-firmware","fixture-private-reference","fixture-private-fingerprint",Privacy::Public}};
    d.structure.emplace(); auto &st=*d.structure;
    st.subsystems={{"root","Root","",Privacy::Public},{"branch","Branch","root",Privacy::Public},
        {"private","Private","",Privacy::Internal},{"empty","Reusable label","",Privacy::Public}};
    st.component_memberships={{"sensor-firmware","branch"}};
    st.sites={{"factory-demo","Factory",Privacy::Public}};
    st.areas={{"cell","Cell","factory-demo","",Privacy::Public}};
    st.environments={{"test","Test",Privacy::Public}};
    st.asset_placements={{"machine-a","cell","gateway-b","test",PhysicalRole::Device},
                        {"gateway-b","cell","","test",PhysicalRole::Gateway}};
    validate(d); return d;
}
struct Fixture {
    QTemporaryDir temp;
    QString source,library,folder,backups;
    ProjectDocument d;
    explicit Fixture(ProjectDocument input=document(), int library_schema=2) {
        require(temp.isValid(),"Fixture directory failed.");
        source=temp.filePath(QString::fromUtf8("project-Σ.sqlite")); library=temp.filePath("library.sqlite");
        folder=temp.filePath("root"); backups=temp.filePath("backups");
        require(QDir(temp.path()).mkdir("root") && QDir(temp.path()).mkdir("backups"),"Fixture parents failed.");
        input.topology.revision=save_project(source,input); d=load_project(source);
        remember_library_project(library,{s(d.project.id),"Fixture",source,folder,false,17});
        if(library_schema==2) require(upgrade_project_library(library,backups,inspect_project_library(library).token).state==
                                      LibraryUpgradeState::Upgraded,"Fixture library upgrade failed.");
    }
    LogicalHierarchyScope scope(bool internal=true) const { return {d.project.id,true,internal}; }
};
const Subsystem &subsystem(const ProjectDocument &d,const std::string &id) {
    for(const auto &r:d.structure->subsystems) if(r.id==id) return r;
    throw std::runtime_error("Fixture subsystem missing.");
}
LogicalHierarchyProposal rename(const Fixture &f,const std::string &label="Reviewed root") {
    return {f.d.project.id,f.d.topology.revision,{RenameSubsystem{subsystem(f.d,"root"),label}}};
}
QJsonObject preview_request(const LogicalHierarchyProposal &p) {
    return {{"action","logical-hierarchy-preview"},{"proposal",proposal_json(p)}};
}
QJsonObject commit_request(const QJsonObject &preview) {
    return {{"action","logical-hierarchy-commit"},{"expected",preview["expected"]}};
}
struct Reply { QJsonObject json; qsizetype size; };
class Facade {
    QString real_,fault_;
  public:
    Facade(QString real,QString fault):real_(std::move(real)),fault_(std::move(fault)){}
    QStringList args(const Fixture &f,bool write=false,bool internal=true) const {
        return {write?"--logical-hierarchy-write":"--logical-hierarchy-read","--library",f.library,
                "--project",s(f.d.project.id),"--visibility",internal?"internal":"public"};
    }
    Reply raw(const Fixture &f,const QByteArray &input,bool write=false,bool internal=true,
              const QString &fault={},bool shipped=false,QStringList arguments={}) const {
        QProcess child; child.setProgram(fault.isEmpty()||shipped?real_:fault_);
        child.setArguments(arguments.isEmpty()?args(f,write,internal):arguments);
        auto env=QProcessEnvironment::systemEnvironment();
        env.remove("LMTI_HIERARCHY_FACADE_FAULT"); env.remove("LMTI_PROJECT_OPERATION_WRITE_TEST_FAULT");
        if(!fault.isEmpty()) env.insert("LMTI_HIERARCHY_FACADE_FAULT",fault);
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
void read_error(const Reply &r,const char *code) {
    fields(r.json,{"ok","code"},"Read refusal returned partial material");
    check(r.json["ok"]==false && r.json["code"]==code,"Read refusal code differs");
}
void read_ok(const Reply &r,const char *action,const QSet<QString> &extra) {
    auto wanted=extra; wanted.unite({"ok","schema","action"}); fields(r.json,wanted,"Read success fields differ");
    require(r.json["ok"]==true && r.json["schema"]=="lmti.logical-hierarchy.owner.v1" &&
            r.json["action"]==action,"Read action did not succeed.");
}
void write_reply(const Reply &r,const char *outcome,bool details,const char *code=nullptr,bool null_action=false) {
    fields(r.json,{"schema","action","outcome","code","operationId","details","detailsAvailable"},"Write outcome shape differs");
    check(r.json["schema"]=="lmti.project.operation.write.v1" && r.json["outcome"]==outcome &&
              r.json["operationId"].isNull() && r.json["detailsAvailable"]==details,"Write outcome flags differ");
    check(null_action?r.json["action"].isNull():r.json["action"]=="logical-hierarchy-commit","Write action correlation differs");
    check(details?r.json["details"].isObject():r.json["details"].isNull(),"Write details null semantics differ");
    if(code) check(r.json["code"]==code,"Write error code differs");
}
Reply preview(const Facade &api,const Fixture &f,const LogicalHierarchyProposal &p) {
    const auto r=api.call(f,preview_request(p));
    read_ok(r,"logical-hierarchy-preview",{"expected","diff"});
    fields(r.json["expected"].toObject(),{"libraryIdentity","reviewToken"},"Preview expected shape differs");
    return r;
}
void same_source(const Fixture &f,const QByteArray &source,const QByteArray &library,const char *message) {
    check(bytes(f.source)==source && bytes(f.library)==library,message);
}

void mixed_lifecycle(const Facade &api) {
    Fixture f;
    const LogicalHierarchyProposal p{f.d.project.id,1,{
        AddSubsystem{{"new-parent","New parent","",Privacy::Internal}},
        RenameSubsystem{subsystem(f.d,"branch"),"Renamed branch"},
        ReparentSubsystem{subsystem(f.d,"root"),"new-parent"},
        SetComponentMembership{f.d.components[2],std::nullopt,std::string("new-parent")},
        RetireEmptySubsystem{subsystem(f.d,"empty")}}};
    const auto before=bytes(f.source), library=bytes(f.library);
    const auto reviewed=preview(api,f,p);
    const auto direct=preview_logical_hierarchy(f.source,f.scope(),p);
    check(reviewed.json["diff"]==diff_json(direct.diff()),"Process preview differs from complete typed owner diff");
    check(reviewed.json["expected"].toObject()["reviewToken"]==token_json(export_logical_hierarchy_review(direct)),
          "Process token did not preserve full private owner pins");
    same_source(f,before,library,"Preview wrote source/library");
    const auto request=commit_request(reviewed.json);
    const auto size=QJsonDocument(request).toJson(QJsonDocument::Compact).size();
    check(size<=input_cap,"Emitted preview cannot be submitted under commit input cap");
    std::cout<<"mixed_commit_input_bytes="<<size<<'\n';
    const auto result=api.call(f,request,true);
    write_reply(result,"confirmed",true,"NONE");
    const auto detail=result.json["details"].toObject();
    fields(detail,{"projectId","storeUuid","previousRevision","revision","proposalDigest"},"Confirmed detail shape differs");
    const auto token=reviewed.json["expected"].toObject()["reviewToken"].toObject();
    check(detail["projectId"]==s(f.d.project.id) && detail["storeUuid"]==token["storeUuid"] &&
              detail["previousRevision"]==1 && detail["revision"]==2 && detail["proposalDigest"]==token["proposalDigest"],
          "Confirmed response lost expected identity/revision");
    auto after=load_project(f.source), expected=apply_logical_hierarchy(f.d,f.scope(),p).document;
    expected.topology.revision=2;
    check(after==expected && after.storage_lineage==f.d.storage_lineage,"One process commit changed unrelated fields/identity");
    check(bytes(f.library)==library,"Hierarchy changed library binding");
    const auto saved=bytes(f.source);
    write_reply(api.call(f,request,true),"refused",false,"CONFIG_CHANGED");
    same_source(f,saved,library,"Known-success replay changed native state");
    const LogicalHierarchyProposal reused{f.d.project.id,2,{
        AddSubsystem{{"empty","New object","",Privacy::Internal}}}};
    read_error(api.call(f,preview_request(reused)),"CONFIG_CHANGED");
    same_source(f,saved,library,"Retired subsystem identity was reused across process boundary");
    const auto state=api.call(f,{{"action","logical-hierarchy-state"}});
    read_ok(state,"logical-hierarchy-state",{"libraryIdentity","projectIdentity","projection"});
    check(state.json["projectIdentity"].toObject()["revision"]==2 &&
              state.json["projection"].toObject()["revision"]==2,"State after commit stale");
}

void token_tamper_and_scope(const Facade &api) {
    Fixture f; const auto original=preview(api,f,rename(f)).json;
    const auto before=bytes(f.source), library=bytes(f.library);
    const auto try_token=[&](const char *key,const QJsonValue &value,const char *code) {
        auto request=commit_request(original), expected=request["expected"].toObject(), token=expected["reviewToken"].toObject();
        token[key]=value; expected["reviewToken"]=token; request["expected"]=expected;
        write_reply(api.call(f,request,true),"refused",false,code);
    };
    try_token("schema","lmti.logical-hierarchy.review.v2","INVALID_INPUT");
    try_token("schemaVersion",1,"INVALID_INPUT");
    try_token("diffDigest",QString(64,'0'),"CONFIG_CHANGED");
    try_token("proposalDigest",QString(64,'0'),"INVALID_INPUT");
    try_token("contentDigest",QString(64,'0'),"CONFIG_CHANGED");
    try_token("registryDigest",QString(64,'0'),"CONFIG_CHANGED");
    try_token("storeUuid",QUuid::createUuid().toString(QUuid::WithoutBraces),"CONFIG_CHANGED");
    const auto canonical=original["expected"].toObject()["reviewToken"].toObject()["canonicalPath"].toString();
    try_token("canonicalPath",canonical.left(canonical.lastIndexOf('/')+1)+"never-open.sqlite","CONFIG_CHANGED");
    check(!QFileInfo::exists(f.temp.filePath("never-open.sqlite")),"Token path selected or created a file");
    auto request=commit_request(original), expected=request["expected"].toObject(), token=expected["reviewToken"].toObject();
    auto proposal=token["proposal"].toObject(); auto changes=proposal["changes"].toArray(); auto op=changes[0].toObject();
    op["desiredLabel"]="Unreviewed substitution"; changes[0]=op; proposal["changes"]=changes;
    token["proposal"]=proposal; expected["reviewToken"]=token; request["expected"]=expected;
    write_reply(api.call(f,request,true),"refused",false,"INVALID_INPUT");
    write_reply(api.call(f,commit_request(original),true,false),"refused",false,"SCOPE_DENIED");
    same_source(f,before,library,"Tampered token/scope wrote stores");
}

void identity_drift(const Facade &api) {
    for(const std::string kind:{"graph","registry","uuid","library","root-aba"}) {
        Fixture f; const auto request=commit_request(preview(api,f,rename(f)).json);
        if(kind=="graph") { Sql db(f.source); db.exec("UPDATE project SET goal='Unrelated same-revision drift'"); }
        else if(kind=="registry") { Sql db(f.source); db.exec("INSERT INTO identity_registry VALUES('subsystem','retired-private','retired')"); }
        else if(kind=="uuid") {
            const auto replacement=f.temp.filePath("replacement.sqlite"); auto d=document();
            d.topology.revision=save_project(replacement,d);
            require(QFile::rename(f.source,f.temp.filePath("retained.sqlite")) && QFile::copy(replacement,f.source),
                    "Same-path replacement fixture failed.");
        } else if(kind=="library") {
            const auto replacement=f.temp.filePath("replacement-library.sqlite");
            remember_library_project(replacement,{s(f.d.project.id),"Fixture",f.source,f.folder,false,17});
            require(upgrade_project_library(replacement,f.backups,inspect_project_library(replacement).token).state==
                    LibraryUpgradeState::Upgraded,"Replacement library fixture failed.");
            require(QFile::rename(f.library,f.temp.filePath("retained-library.sqlite")) && QFile::copy(replacement,f.library),
                    "Library replacement fixture failed.");
        } else {
            const auto other=f.temp.filePath("other-root"); require(QDir(f.temp.path()).mkdir("other-root"),"ABA parent failed.");
            const auto first=inspect_project_library(f.library).token;
            const auto next=link_library_folder_cas(f.library,s(f.d.project.id),other,first);
            const auto last=link_library_folder_cas(f.library,s(f.d.project.id),f.folder,next);
            check(last.generation==first.generation+2 && last.digest==first.digest,"Root ABA fixture did not restore digest/increment generation");
        }
        const auto source=bytes(f.source), library=bytes(f.library);
        write_reply(api.call(f,request,true),"refused",false,"CONFIG_CHANGED");
        same_source(f,source,library,"Stale identity request changed current stores");
    }
}

void direct_token_lifetime(const Facade &) {
    Fixture f; const auto p=rename(f);
    auto review=preview_logical_hierarchy(f.source,f.scope(),p);
    const auto token=export_logical_hierarchy_review(review);
    const auto reject=[&](const std::function<void()> &call,HierarchyCode code) {
        try { call(); check(false,"Direct token refusal accepted"); }
        catch(const HierarchyError &error) { check(error.code()==code,"Direct token refusal code differs"); }
    };
    auto bad=token; bad.version=2;
    reject([&]{restore_logical_hierarchy_review(f.temp.filePath("absent.sqlite"),f.scope(),bad);},HierarchyCode::InvalidArgument);
    check(!QFileInfo::exists(f.temp.filePath("absent.sqlite")),"Malformed token created missing file");
    const auto restored=restore_logical_hierarchy_review(f.source,f.scope(),token);
    check(export_logical_hierarchy_review(restored).snapshot==token.snapshot && restored.diff()==review.diff(),
          "Restored review refreshed or omitted original pins");
    const auto committed=commit_logical_hierarchy(f.source,f.scope(),restored);
    check(committed.state==HierarchyCommitState::Committed && committed.revision==2,"Restored review did not commit");
    reject([&]{export_logical_hierarchy_review(restored);},HierarchyCode::Conflict);
    reject([&]{restore_logical_hierarchy_review(f.source,f.scope(),token);},HierarchyCode::Conflict);
    auto moved=std::move(review);
    reject([&]{export_logical_hierarchy_review(review);},HierarchyCode::InvalidArgument);
    check(export_logical_hierarchy_review(moved).snapshot==token.snapshot,"Moving review altered private original pins");
}

void selected_source_boundaries(const Facade &api) {
    for(const QString missing:{"library","project"}) {
        Fixture f; const auto p=rename(f);
        const auto request=commit_request(preview(api,f,p).json);
        const auto path=missing=="library"?f.library:f.source;
        const auto retained=f.temp.filePath("retained.sqlite");
        require(QFile::rename(path,retained),"Missing owner fixture failed.");
        const auto retained_bytes=bytes(retained);
        const auto other=missing=="library"?f.source:f.library;
        const auto other_bytes=bytes(other);
        read_error(api.call(f,{{"action","logical-hierarchy-state"}}),"OWNER_UNAVAILABLE");
        read_error(api.call(f,preview_request(p)),"OWNER_UNAVAILABLE");
        write_reply(api.call(f,request,true),"refused",false,"OWNER_UNAVAILABLE");
        check(!QFileInfo::exists(path) && bytes(retained)==retained_bytes && bytes(other)==other_bytes,
              "Missing existing-only owner path created or changed stores");
    }
    {
        Fixture f(demo_project());
        const LogicalHierarchyProposal p{f.d.project.id,1,{AddSubsystem{{"new","New","",Privacy::Internal}}}};
        const auto before=bytes(f.source), library=bytes(f.library);
        read_error(api.call(f,{{"action","logical-hierarchy-state"}}),"UNSUPPORTED_SCHEMA");
        read_error(api.call(f,preview_request(p)),"UNSUPPORTED_SCHEMA");
        same_source(f,before,library,"Schema1 hierarchy read implicitly upgraded or changed source");
    }
    {
        Fixture f(document(),1);
        const auto before=bytes(f.library);
        const auto reviewed=preview(api,f,rename(f));
        const auto identity=reviewed.json["expected"].toObject()["libraryIdentity"].toObject();
        check(identity["schema"]==1 && identity["uuid"].isNull() && identity["generation"].isNull(),
              "Legacy library invented durable identity");
        write_reply(api.call(f,commit_request(reviewed.json),true),"confirmed",true,"NONE");
        check(bytes(f.library)==before && load_project(f.source).topology.revision==2,
              "Legacy library compatibility changed format or lost hierarchy commit");
    }
    {
        Fixture f;
        auto args=api.args(f); args[4]="not-selected";
        const auto before=bytes(f.source), library=bytes(f.library);
        read_error(api.raw(f,"{\"action\":\"logical-hierarchy-state\"}",false,true,{},false,args),"SCOPE_DENIED");
        auto p=rename(f); p.project_id="not-selected";
        read_error(api.call(f,preview_request(p)),"SCOPE_DENIED");
        same_source(f,before,library,"Unselected/mismatched project changed stores");
    }
}

std::filesystem::path native_path(const QString &path) {
#ifdef Q_OS_WIN
    return std::filesystem::path(path.toStdWString());
#else
    return std::filesystem::path(path.toStdString());
#endif
}
void library_link_boundaries(const Facade &api) {
    for(const QString suffix:{"","-wal","-shm","-journal"}) {
        Fixture f; const auto p=rename(f);
        const auto request=commit_request(preview(api,f,p).json);
        const auto linked=f.library+suffix, alias=f.temp.filePath("controlled-alias");
        if(!suffix.isEmpty()) {
            QFile sidecar(linked); require(sidecar.open(QIODevice::WriteOnly|QIODevice::NewOnly),"Sidecar fixture failed.");
            require(sidecar.write("controlled-link-fixture")==23 && sidecar.flush(),"Sidecar fixture incomplete.");
        }
        std::error_code error;
        std::filesystem::create_hard_link(native_path(linked),native_path(alias),error);
        if(error) {
            ++skipped; std::cout<<"Library hardlink fixture: SKIP host could not create confined link.\n";
            continue;
        }
        require(std::filesystem::hard_link_count(native_path(linked),error)==2 && !error,
                "Hardlink fixture did not establish alias.");
        const auto before=bytes(f.source), library=bytes(f.library), sidecar=bytes(linked);
        read_error(api.call(f,{{"action","logical-hierarchy-state"}}),"OWNER_UNAVAILABLE");
        read_error(api.call(f,preview_request(p)),"OWNER_UNAVAILABLE");
        write_reply(api.call(f,request,true),"refused",false,"OWNER_UNAVAILABLE");
        same_source(f,before,library,"Aliased library read/write changed stores");
        check(bytes(linked)==sidecar && bytes(alias)==sidecar,"Library alias guard altered linked artifact");
    }
}

void policy_refusals(const Facade &api) {
    Fixture f;
    const auto before=bytes(f.source), library=bytes(f.library);
    auto stale=rename(f); std::get<RenameSubsystem>(stale.changes[0]).expected.label="Stale label";
    read_error(api.call(f,preview_request(stale)),"CONFIG_CHANGED");
    stale=rename(f); stale.expected_revision=2;
    read_error(api.call(f,preview_request(stale)),"CONFIG_CHANGED");
    read_error(api.call(f,preview_request(rename(f,"Root"))),"INVALID_INPUT");
    read_error(api.call(f,preview_request({f.d.project.id,1,{
        ReparentSubsystem{subsystem(f.d,"root"),"branch"}}})),"INVALID_INPUT");
    read_error(api.call(f,preview_request({f.d.project.id,1,{
        RetireEmptySubsystem{subsystem(f.d,"root")}}})),"CONFIG_CHANGED");
    same_source(f,before,library,"Policy refusal changed source/library");
    {
        auto d=document();
        d.structure->subsystems[1].parent_subsystem_id="private";
        Fixture private_fixture(d);
        const auto private_before=bytes(private_fixture.source), private_library=bytes(private_fixture.library);
        const LogicalHierarchyProposal lower{d.project.id,1,{
            ReparentSubsystem{subsystem(private_fixture.d,"branch"),"root"}}};
        read_error(api.call(private_fixture,preview_request(lower)),"SCOPE_DENIED");
        same_source(private_fixture,private_before,private_library,"Declassification refusal changed stores");
    }
}

void shared_json_scalars(const Facade &) {
    const auto reject=[](const QByteArray &raw,qsizetype cap=input_cap) {
        try {
            (void)lmti::detail::strict_json_object(raw,cap);
            check(false,"Shared parser accepted invalid JSON/scalar input");
        } catch(const lmti::Error &) {
            check(true,"Shared parser refused invalid JSON/scalar input");
        }
    };
    for(const auto &token:std::vector<QByteArray>{
            R"("\ud800")",R"("\udc00")",R"("\udc00\ud800")",
            R"("\ud800x")",R"("\ud800x\udc00")"}) {
        reject(QByteArray("{\"value\":")+token+"}");
        reject(QByteArray("{\"nested\":[{\"value\":[")+token+"]}]}");
        reject(QByteArray("{")+token+":0}");
    }
    const auto rocket=QString::fromUtf8(QByteArray::fromHex("f09f9a80"));
    const auto escaped=lmti::detail::strict_json_object(
        R"({"nested":[{"\ud83d\ude80":"\ud83d\ude80"}],"literal":"\\ud800","escaped":"quote:\" slash:\\ braces:{[]}"})",input_cap);
    const auto nested=escaped["nested"].toArray().at(0).toObject();
    check(nested.size()==1 && nested[rocket].toString()==rocket,
          "Valid escaped supplementary key/value changed");
    check(escaped["literal"].toString()==QStringLiteral("\\ud800") &&
          escaped["escaped"].toString()==QStringLiteral("quote:\" slash:\\ braces:{[]}"),
          "Literal backslash or ordinary JSON escaping changed");
    const auto literal=QJsonDocument(QJsonObject{{rocket,rocket}}).toJson(QJsonDocument::Compact);
    require(literal.contains(rocket.toUtf8()),"Literal UTF-8 fixture was not literal.");
    check(lmti::detail::strict_json_object(literal,input_cap).value(rocket).toString()==rocket,
          "Valid literal supplementary key/value changed");
    reject(R"({"same":1,"\u0073ame":2})");
    reject(QByteArray("{\"")+rocket.toUtf8()+"\":1,\"\\ud83d\\ude80\":2}");
    reject(QByteArray("{\"value\":\"")+QByteArray::fromHex("ff")+"\"}");
    reject(QByteArray("{\"value\":\"")+QByteArray::fromHex("c0af")+"\"}");
    for(const auto &raw:std::vector<QByteArray>{"","[]","null","{\"value\":0} trailing","{\"value\":"}) reject(raw);
    // Scalar hardening does not add a control-character policy to this parser.
    const auto zero=lmti::detail::strict_json_object(R"({"value":"\u0000"})",input_cap)["value"].toString();
    check(zero.size()==1 && zero.at(0)==QChar(0),"Shared parser changed decoded-control policy");
    QByteArray depth="{\"value\":";
    for(int i=0;i<15;++i) depth+='[';
    depth+='0';for(int i=0;i<15;++i) depth+=']';depth+='}';
    check(lmti::detail::strict_json_object(depth,input_cap).contains("value"),"Depth16 boundary changed");
    auto too_deep=depth;too_deep.replace("0","[0]");reject(too_deep);
    const QByteArray bounded="{\"value\":\"ok\"}";
    check(lmti::detail::strict_json_object(bounded,bounded.size())["value"]=="ok","Exact byte cap changed");
    reject(bounded,bounded.size()-1);
}

void unicode_process_boundary(const Facade &api) {
    Fixture f;
    const auto source_before=bytes(f.source),library_before=bytes(f.library);
    const auto initial=QJsonDocument(preview_request(rename(f))).toJson(QJsonDocument::Compact);
    const QByteArray needle="\"desiredLabel\":\"Reviewed root\"";
    require(initial.contains(needle),"Recognized Unicode preview fixture field missing.");
    const auto reviewed=preview(api,f,rename(f));
    const auto commit=QJsonDocument(commit_request(reviewed.json)).toJson(QJsonDocument::Compact);
    require(commit.contains(needle),"Recognized Unicode commit fixture field missing.");
    for(const auto &scalar:std::vector<QByteArray>{"\\ud800","\\udc00","\\udc00\\ud800"}) {
        const auto replacement=QByteArray("\"desiredLabel\":\"before")+scalar+"after\"";
        auto malformed=initial;malformed.replace(needle,replacement);
        read_error(api.raw(f,malformed),"INVALID_INPUT");
        auto malformed_commit=commit;malformed_commit.replace(needle,replacement);
        // A parser refusal precedes action selection and owner admission. A
        // downstream token/digest refusal alone would not prove this boundary.
        write_reply(api.raw(f,malformed_commit,true),"refused",false,"INVALID_INPUT",true);
        same_source(f,source_before,library_before,"Malformed Unicode changed source/library");
    }
    auto valid=initial;
    valid.replace(needle,"\"desiredLabel\":\"before\\ud83d\\ude80after\"");
    const auto accepted=api.raw(f,valid);
    read_ok(accepted,"logical-hierarchy-preview",{"expected","diff"});
    const auto label=QStringLiteral("before")+QString::fromUtf8(QByteArray::fromHex("f09f9a80"))+QStringLiteral("after");
    const auto token=accepted.json["expected"].toObject()["reviewToken"].toObject();
    const auto changes=token["proposal"].toObject()["changes"].toArray();
    const auto rows=accepted.json["diff"].toObject()["subsystems"].toArray();
    require(changes.size()==1 && rows.size()==1,"Supplementary preview returned incomplete review.");
    check(changes.at(0).toObject()["desiredLabel"]==label &&
          rows.at(0).toObject()["after"].toObject()["label"]==label,
          "Supplementary scalar changed in normalized proposal or diff");
    same_source(f,source_before,library_before,"Valid Unicode preview wrote stores");
    auto valid_commit=QJsonDocument(commit_request(accepted.json)).toJson(QJsonDocument::Compact);
    require(valid_commit.contains(label.toUtf8()),"Supplementary commit fixture field missing.");
    valid_commit.replace(label.toUtf8(),"before\\ud83d\\ude80after");
    write_reply(api.raw(f,valid_commit,true),"confirmed",true,"NONE");
    auto expected=apply_logical_hierarchy(f.d,f.scope(),rename(f,label.toStdString())).document;
    expected.topology.revision=2;
    const auto saved=load_project(f.source);
    check(saved==expected && saved.storage_lineage==f.d.storage_lineage &&
          subsystem(saved,"root").label==label.toStdString(),
          "Valid supplementary commit lost scalar or changed unrelated native state");
    check(bytes(f.library)==library_before,"Supplementary commit changed library");
}

void strict_inputs(const Facade &api) {
    Fixture f; const auto request=preview_request(rename(f));
    const auto valid=QJsonDocument(request).toJson(QJsonDocument::Compact);
    const auto before=bytes(f.source), library=bytes(f.library);
    std::vector<QByteArray> invalid={QByteArray{}, "[]", "null", valid+" trailing",
        valid+QByteArray(1,'\0'), valid+QByteArray(1,'\x1a')+" trailing",
        "{\"action\":\"logical-hierarchy-state\",\"action\":\"logical-hierarchy-state\"}",
        "{\"action\":\"logical-hierarchy-state\",\"extra\":1}",
        "{\"action\":\"logical-hierarchy-state\",\"scope\":{\"allowInternal\":true}}"};
    auto duplicate=valid; duplicate.replace("\"expectedRevision\":1","\"expectedRevision\":1,\"expectedRevision\":1"); invalid.push_back(duplicate);
    auto utf8=valid; utf8.replace("Reviewed root",QByteArray("\xc0\xaf",2)); invalid.push_back(utf8);
    invalid.push_back(QByteArray(input_cap+1,' '));
    QByteArray depth="{\"action\":\"logical-hierarchy-state\",\"deep\":";
    for(int i=0;i<20;++i) depth+='['; depth+='0'; for(int i=0;i<20;++i) depth+=']'; depth+='}'; invalid.push_back(depth);
    for(const auto &raw:invalid) read_error(api.raw(f,raw),"INVALID_INPUT");
    for(const auto &value:QJsonArray{QJsonValue::Null,true,"1",-1,0,1.5,9007199254740991.0}) {
        auto bad=request, p=bad["proposal"].toObject(); p["expectedRevision"]=value; bad["proposal"]=p;
        read_error(api.call(f,bad),"INVALID_INPUT");
    }
    for(const char *key:{"path","allowLogicalWrite","allowInternal"}) {
        auto bad=request, p=bad["proposal"].toObject(); p[key]=true; bad["proposal"]=p;
        read_error(api.call(f,bad),"INVALID_INPUT");
    }
    auto bad=request, p=bad["proposal"].toObject(); auto ops=p["changes"].toArray(); auto op=ops[0].toObject();
    op["kind"]="set_field"; ops[0]=op; p["changes"]=ops; bad["proposal"]=p;
    read_error(api.call(f,bad),"INVALID_INPUT");
    {
        auto empty=request, shape=empty["proposal"].toObject(); shape["changes"]=QJsonArray{}; empty["proposal"]=shape;
        read_error(api.call(f,empty),"INVALID_INPUT");
        QJsonArray too_many; for(int i=0;i<33;++i) too_many.append(ops[0]); shape["changes"]=too_many; empty["proposal"]=shape;
        read_error(api.call(f,empty),"BUDGET_EXCEEDED");
    }
    {
        const LogicalHierarchyProposal membership{f.d.project.id,1,{
            SetComponentMembership{f.d.components[0],ComponentMembership{"sensor-firmware","branch"},std::nullopt}}};
        auto malformed=preview_request(membership), shape=malformed["proposal"].toObject();
        auto changes=shape["changes"].toArray();
        auto change=changes[0].toObject();
        change["desiredSubsystemId"]=""; changes[0]=change; shape["changes"]=changes; malformed["proposal"]=shape;
        read_error(api.call(f,malformed),"INVALID_INPUT");
        change["desiredSubsystemId"]=QJsonValue::Null; change["expected"]=false;
        changes[0]=change; shape["changes"]=changes; malformed["proposal"]=shape;
        read_error(api.call(f,malformed),"INVALID_INPUT");
    }
    const auto state=QJsonDocument(QJsonObject{{"action","logical-hierarchy-state"}}).toJson(QJsonDocument::Compact);
    auto at_cap=state+QByteArray(input_cap-state.size(),' ');
    read_ok(api.raw(f,at_cap),"logical-hierarchy-state",{"libraryIdentity","projectIdentity","projection"});
    read_error(api.raw(f,at_cap+" "),"INVALID_INPUT");
    const auto valid_commit=commit_request(preview(api,f,rename(f)).json);
    auto raw=QJsonDocument(valid_commit).toJson(QJsonDocument::Compact);
    raw.replace("\"revision\":1","\"revision\":1,\"revision\":1");
    write_reply(api.raw(f,raw,true),"refused",false,"INVALID_INPUT",true);
    write_reply(api.call(f,{{"action","unrecognized"}},true),"refused",false,"INVALID_INPUT",true);
    same_source(f,before,library,"Strict parser refusal or boundary read changed stores");
}

QJsonObject projected(const QJsonObject &projection,const char *group,const char *id) {
    for(const auto &r:projection[group].toArray())
        if(r.toObject()["value"].toObject()["id"]==id) return r.toObject();
    return {};
}
void state_visibility_and_offline(const Facade &api) {
    auto d=document(); d.repositories.front().privacy=Privacy::Internal;
    d.structure->subsystems.push_back({"hidden-child","Public child","private",Privacy::Public});
    Fixture f(d);
    require(QDir().rename(f.folder,f.temp.filePath("root-offline")),"Offline root fixture failed.");
    const auto before=bytes(f.source), library=bytes(f.library);
    const auto public_state=api.call(f,{{"action","logical-hierarchy-state"}},false,false);
    const auto internal=api.call(f,{{"action","logical-hierarchy-state"}});
    read_ok(public_state,"logical-hierarchy-state",{"libraryIdentity","projectIdentity","projection"});
    read_ok(internal,"logical-hierarchy-state",{"libraryIdentity","projectIdentity","projection"});
    const auto pub=public_state.json["projection"].toObject(), local=internal.json["projection"].toObject();
    check(projected(pub,"components","sensor-firmware").isEmpty() && projected(pub,"subsystems","private").isEmpty() &&
              projected(pub,"subsystems","hidden-child").isEmpty(),
          "Public projection leaked repository-hidden component or promoted hidden ancestor's child");
    check(projected(local,"subsystems","hidden-child")["classification"]=="internal" &&
              projected(local,"subsystems","hidden-child")["ancestors"].toArray()==QJsonArray{"private"},
          "Internal projection lost inherited privacy or original private ancestry");
    check(projected(local,"components","sensor-firmware")["classification"]=="internal" &&
              projected(local,"components","sensor-firmware")["ancestors"].toArray()==QJsonArray{"root","branch"},
          "Operator projection omitted effective repository privacy/complete ancestry");
    const auto projection_bytes=QJsonDocument(local).toJson(QJsonDocument::Compact);
    check(!projection_bytes.contains("fixture-private") && !projection_bytes.contains(f.source.toUtf8()) &&
              !projection_bytes.contains(f.d.storage_lineage->store_uuid.c_str()) &&
              !projection_bytes.contains("registryDigest"),"Public-intended projection leaked private owner evidence");
    read_error(api.call(f,preview_request(rename(f)),false,false),"SCOPE_DENIED");
    const auto reviewed=preview(api,f,rename(f));
    same_source(f,before,library,"State/offline preview mutated store or probed root as authority");
    write_reply(api.call(f,commit_request(reviewed.json),true),"confirmed",true,"NONE");
    { Sql db(f.source); db.exec("UPDATE project SET revision=9007199254740990"); }
    const auto limit=api.call(f,{{"action","logical-hierarchy-state"}});
    read_ok(limit,"logical-hierarchy-state",{"libraryIdentity","projectIdentity","projection"});
    check(limit.json["projectIdentity"].toObject()["revision"].toDouble()==9007199254740990.0,
          "State incorrectly requires revision room for mutation");
    f.d=load_project(f.source); read_error(api.call(f,preview_request(rename(f))),"BUDGET_EXCEEDED");
}

void fault_outcomes(const Facade &api) {
    for(const QString fault:{"before_owner","entered_owner","before_commit","after_commit","after_confirmed"}) {
        Fixture f; const auto previewed=preview(api,f,rename(f));
        const auto before=bytes(f.source), library=bytes(f.library);
        const auto result=api.call(f,commit_request(previewed.json),true,true,fault);
        if(fault=="before_owner") write_reply(result,"refused",false,"OWNER_UNAVAILABLE");
        else if(fault=="after_confirmed") write_reply(result,"confirmed",false,"NONE");
        else write_reply(result,"unknown",false,fault=="after_commit"?"RECOVERY_REQUIRED":"OWNER_UNAVAILABLE");
        const auto after=load_project(f.source);
        const bool committed=fault=="after_commit" || fault=="after_confirmed";
        check(after.topology.revision==(committed?2:1),"Fault outcome did not match independently inspected revision");
        if(committed) check(subsystem(after,"root").label=="Reviewed root","Post-commit outcome lost durable edit");
        else check(bytes(f.source)==before,"Precommit fault changed source");
        check(bytes(f.library)==library,"Fault path changed selected library");
        // No automatic retransmission after unknown. Read-only state is evidence
        // of current rows, never attribution of an historical operation.
        const auto current=api.call(f,{{"action","logical-hierarchy-state"}});
        read_ok(current,"logical-hierarchy-state",{"libraryIdentity","projectIdentity","projection"});
        check(current.json["projectIdentity"].toObject()["revision"]==after.topology.revision,
              "Read-only recovery state differs from native row inspection");
    }
    Fixture f; const auto request=commit_request(preview(api,f,rename(f)).json);
    write_reply(api.call(f,request,true,true,"before_commit",true),"confirmed",true,"NONE");
    check(load_project(f.source).topology.revision==2,"Production executable unexpectedly honored fault selector");
}

ProjectDocument workload(int components) {
    ProjectDocument d; d.project={"factory-monitor","Deep broad workload","Synthetic",Privacy::Public};
    d.structure.emplace();
    std::string parent;
    for(int i=0;i<31;++i) {
        auto id="node-"+std::to_string(i)+"-"; id.append(64-id.size(),'a');
        d.structure->subsystems.push_back({id,std::string(120,'N'),parent,Privacy::Public}); parent=id;
    }
    for(int i=0;i<components;++i) {
        auto id="component-"+std::to_string(i)+"-"; id.append(64-id.size(),'b');
        d.components.push_back({id,std::string(120,'C'),"",ComponentKind::Library,Privacy::Public});
        d.structure->component_memberships.push_back({id,parent});
    }
    validate(d); return d;
}
void workload_caps(const Facade &api) {
    struct Measured { qsizetype response,commit,emitted; bool accepted; };
    std::map<int,Measured> measurements;
    const auto probe=[&](int count) {
        Fixture f(workload(count));
        const LogicalHierarchyProposal p{f.d.project.id,1,{
            RenameSubsystem{f.d.structure->subsystems.front(),std::string(119,'R')}}};
        const auto direct=preview_logical_hierarchy(f.source,f.scope(),p);
        const QJsonObject expected{{"libraryIdentity",library_json(inspect_project_library(f.library).token)},
                                  {"reviewToken",token_json(export_logical_hierarchy_review(direct))}};
        // This independently implements the frozen DTO, not the facade serializer.
        const QJsonObject full{{"ok",true},{"schema","lmti.logical-hierarchy.owner.v1"},
            {"action","logical-hierarchy-preview"},{"expected",expected},{"diff",diff_json(direct.diff())}};
        const qsizetype response_bytes=QJsonDocument(full).toJson(QJsonDocument::Compact).size()+1;
        const auto commit=commit_request(full);
        const qsizetype commit_bytes=QJsonDocument(commit).toJson(QJsonDocument::Compact).size();
        const auto before=bytes(f.source), library=bytes(f.library);
        const auto actual=api.call(f,preview_request(p));
        const bool accepted=response_bytes<=output_cap && commit_bytes<=input_cap;
        check(direct.diff().affected.size()==static_cast<std::size_t>(31+count),
              "Workload review silently omitted affected descendants");
        if(accepted) {
            read_ok(actual,"logical-hierarchy-preview",{"expected","diff"});
            check(actual.json==full && actual.size==response_bytes,"Accepted workload response differs from complete independent DTO");
            check(commit_bytes<=input_cap,"Accepted workload token exceeds commit input cap");
            same_source(f,before,library,"Accepted workload preview wrote stores");
            write_reply(api.call(f,commit_request(actual.json),true),"confirmed",true,"NONE");
            check(load_project(f.source).topology.revision==2,"Accepted large review did not commit exactly once");
        } else {
            read_error(actual,"BUDGET_EXCEEDED");
            check(actual.json.size()==2 && !actual.json.contains("expected") && !actual.json.contains("diff"),
                  "Oversize review emitted partial diff or usable token");
            same_source(f,before,library,"Oversize valid review changed stores");
        }
        if(count==2000) {
            const auto state=api.call(f,{{"action","logical-hierarchy-state"}});
            read_error(state,"BUDGET_EXCEEDED");
            same_source(f,before,library,"Oversize valid state read changed stores");
        }
        measurements.emplace(count,Measured{response_bytes,commit_bytes,actual.size,accepted});
        return accepted;
    };
    require(probe(1),"Minimum valid workload unexpectedly refused.");
    require(!probe(2000),"Maximal depth32/broad legal graph unexpectedly fits fixture assumption.");
    int low=1,high=2000;
    // Find adjacent accepted/refused component counts for this fixed valid
    // depth32 family; every accepted point is actually committed in its own DB.
    while(high-low>1) {
        const int mid=low+(high-low)/2;
        if(probe(mid)) low=mid; else high=mid;
    }
    const auto &accepted=measurements.at(low), &refused=measurements.at(high), &maximal=measurements.at(2000);
    check(accepted.accepted && !refused.accepted && high==low+1 &&
              accepted.response<=output_cap && refused.response>output_cap,
          "Measured workload boundary is not adjacent complete-response acceptance/refusal");
    std::cout<<"Hierarchy workload accepted: components="<<low<<"; depth=32; fullResponseBytes="<<accepted.response
             <<"; emittedResponseBytes="<<accepted.emitted<<"; commitBytes="<<accepted.commit<<".\n";
    std::cout<<"Hierarchy workload refused: components="<<high<<"; depth=32; fullResponseBytes="<<refused.response
             <<"; emittedResponseBytes="<<refused.emitted<<"; commitBytes="<<refused.commit<<".\n";
    std::cout<<"Hierarchy workload maximum: components=2000; depth=32; fullResponseBytes="<<maximal.response
             <<"; emittedResponseBytes="<<maximal.emitted<<"; commitBytes="<<maximal.commit
             <<"; measuredPoints="<<measurements.size()<<".\n";
}
}

int main(int argc,char **argv) {
    QCoreApplication app(argc,argv);
    if(app.arguments().size()!=3) { std::cerr<<"Provide production and isolated hierarchy admin paths.\n"; return 1; }
    const Facade api(app.arguments()[1],app.arguments()[2]);
    const std::pair<const char *,void(*)(const Facade &)> cases[]={
        {"mixed_lifecycle",mixed_lifecycle},{"token_tamper_and_scope",token_tamper_and_scope},
        {"identity_drift",identity_drift},{"direct_token_lifetime",direct_token_lifetime},
        {"selected_source_boundaries",selected_source_boundaries},{"library_link_boundaries",library_link_boundaries},
        {"policy_refusals",policy_refusals},
        {"shared_json_scalars",shared_json_scalars},{"unicode_process_boundary",unicode_process_boundary},
        {"strict_inputs",strict_inputs},{"state_visibility_and_offline",state_visibility_and_offline},
        {"fault_outcomes",fault_outcomes},{"workload_caps",workload_caps}};
    int passed=0;
    for(const auto &[name,call]:cases) {
        const auto before=failures, skipped_before=skipped;
        try { call(api); } catch(const std::exception &) { ++failures; std::cerr<<name<<": bounded fixture/transport exception.\n"; }
        if(before==failures && skipped_before==skipped) ++passed;
        std::cout<<name<<": "<<(before!=failures?"FAIL":skipped_before!=skipped?"SKIP":"PASS")<<'\n';
    }
    std::cout<<"Hierarchy transport: "<<passed<<'/'<<std::size(cases)<<" cases passed; "<<checks
             <<" behavioral checks; "<<failures<<" failures; "<<skipped<<" skipped.\n";
    return failures?1:0;
}
