#include "lmti/project_original_read.hpp"
#include "../storage/original_read_p.hpp"
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
#include <algorithm>
#include <cstdlib>
#include <cstring>
#include <functional>
#include <iostream>
#include <memory>
#ifdef Q_OS_WIN
#define NOMINMAX
#include <windows.h>
#include <winioctl.h>
#endif

#ifndef LMTI_ORIGINAL_READ_TEST_HOOKS
#error Compile only this isolated test target with original-read hooks.
#endif

namespace {
using Code=lmti::OriginalReadCode;
using Phase=lmti::detail::OriginalReadPhase;
using Expected=lmti::OriginalHierarchyExpected;
using State=lmti::OriginalPhysicalState;
int cases=0,checks=0,failures=0,skips=0;
void check(bool value,const char *message) {
    ++checks; if(!value){++failures;std::cerr<<"FAIL: "<<message<<'\n';}
}
void need(bool value,const char *message="Controlled fixture setup failed.") {
    if(!value)throw lmti::Error(message);
}
QString at(const QString &parent,const QString &leaf){return QDir(parent).filePath(leaf);}
QString uuid(){return QUuid::createUuid().toString(QUuid::WithoutBraces);}
QString mkdir(const QString &parent,const QString &leaf){
    need(QDir(parent).mkdir(leaf));return at(parent,leaf);
}
QByteArray bytes(const QString &path){
    QFile file(path);need(file.open(QIODevice::ReadOnly));return file.readAll();
}
void put(const QString &path,const QByteArray &data){
    QFile file(path);need(file.open(QIODevice::WriteOnly|QIODevice::NewOnly));need(file.write(data)==data.size());
}
QByteArray hash(const QString &path){
    QFile file(path);need(file.open(QIODevice::ReadOnly));QCryptographicHash h(QCryptographicHash::Sha256);
    while(!file.atEnd()){const auto block=file.read(64*1024);need(!block.isEmpty());h.addData(block);}return h.result().toHex();
}
using Tree=QMap<QString,QByteArray>;
void tree_into(const QString &base,const QString &relative,Tree &result){
    for(const auto &item:QDir(relative.isEmpty()?base:at(base,relative)).entryInfoList(
            QDir::AllEntries|QDir::NoDotAndDotDot|QDir::Hidden|QDir::System,QDir::Name)){
        const auto name=relative.isEmpty()?item.fileName():relative+'/'+item.fileName();
        if(item.isSymLink()||item.isJunction()){result[name]="redirect";continue;}
        if(item.isDir()){result[name]="directory";tree_into(base,name,result);}
        else result[name]=QByteArray::number(item.size())+":"+
            (name.endsWith("-shm")?QByteArray("existing-shm-coordination"):hash(item.filePath()));
    }
}
Tree tree(const QString &base){Tree result;tree_into(base,{},result);return result;}
class Sql {
    QString connection_=uuid();
  public:
    QSqlDatabase db;
    explicit Sql(const QString &path){
        need(QFileInfo(path).isFile());db=QSqlDatabase::addDatabase("QSQLITE",connection_);
        db.setDatabaseName(path);db.setConnectOptions("QSQLITE_BUSY_TIMEOUT=1000");need(db.open());
    }
    ~Sql(){db.close();db={};QSqlDatabase::removeDatabase(connection_);}
    void exec(const QString &sql,const QVariantList &values={}){
        QSqlQuery q(db);need(q.prepare(sql));for(const auto &v:values)q.addBindValue(v);need(q.exec());
    }
};
std::function<void(Phase,const QString&)> callback;
void dispatch(Phase phase,const QString &path){if(callback)callback(phase,path);}
class Hook {
  public:
    explicit Hook(std::function<void(Phase,const QString&)> next){
        need(!callback);callback=std::move(next);lmti::detail::set_original_read_test_hook(dispatch);
    }
    ~Hook(){lmti::detail::set_original_read_test_hook(nullptr);callback={};}
};
void refused(const std::function<void()> &fn,Code code){
    try{fn();check(false,"Expected conditional-read refusal did not occur.");}
    catch(const lmti::OriginalReadError &e){
        check(e.code==code,"Conditional-read refusal used an unexpected bounded code.");
        check(QByteArray(e.what())=="Original binding read was refused.","Conditional-read error exposed raw details.");
    }
}

// Independent fixture identity capture, not the production lease helper.
// It deliberately closes every metadata handle before invoking the owner.
lmti::OriginalPhysicalTarget physical(const QString &path,bool missing=false){
    lmti::OriginalPhysicalTarget result;result.path=QDir::cleanPath(path);
    QStringList parts;auto cursor=result.path;
    while(true){parts.prepend(cursor);const auto parent=QFileInfo(cursor).dir().absolutePath();
        if(parent==cursor)break;cursor=parent;}
    if(missing){need(!QFileInfo::exists(path));result.state=State::Missing;parts.removeLast();}
#ifdef Q_OS_WIN
    for(qsizetype i=0;i<parts.size();++i){
        const bool directory=missing||i+1<parts.size();
        const auto handle=CreateFileW(reinterpret_cast<LPCWSTR>(parts[i].utf16()),FILE_READ_ATTRIBUTES,
            FILE_SHARE_READ|FILE_SHARE_WRITE|FILE_SHARE_DELETE,nullptr,OPEN_EXISTING,
            FILE_FLAG_OPEN_REPARSE_POINT|(directory?FILE_FLAG_BACKUP_SEMANTICS:0),nullptr);
        need(handle!=INVALID_HANDLE_VALUE);BY_HANDLE_FILE_INFORMATION info{};
        const auto ok=GetFileInformationByHandle(handle,&info);const auto closed=CloseHandle(handle);
        need(ok&&closed&&!(info.dwFileAttributes&FILE_ATTRIBUTE_REPARSE_POINT)&&
            bool(info.dwFileAttributes&FILE_ATTRIBUTE_DIRECTORY)==directory&&(directory||info.nNumberOfLinks==1));
        const auto ticks=(quint64(info.ftCreationTime.dwHighDateTime)<<32)|info.ftCreationTime.dwLowDateTime;
        need(ticks>116444736000000000ULL);
        result.chain.push_back({QString::number(info.dwVolumeSerialNumber),
            QString::number((quint64(info.nFileIndexHigh)<<32)|info.nFileIndexLow),
            QString::number(ticks-116444736000000000ULL)+"00"});
    }
#else
    (void)parts;throw lmti::Error("Windows identity fixture is required.");
#endif
    return result;
}

struct Fixture {
    QTemporaryDir temp{QDir(QDir::tempPath()).filePath("lmti-original-hierarchy-XXXXXX")};
    QString store,library,project,root,other_root,replacement,backups;
    explicit Fixture(int schema=3,bool unicode=false){
        need(temp.isValid());store=mkdir(temp.path(),unicode?QString::fromUtf8("Phân-cấp-測試"):QString("stores"));
        library=at(store,"library.sqlite");project=at(store,"project.sqlite");
        root=mkdir(temp.path(),"linked-root");other_root=mkdir(temp.path(),"other-root");
        backups=mkdir(temp.path(),"backups");replacement=at(temp.path(),"substitute.sqlite");
        auto d=lmti::demo_project();
        d.structure.emplace();
        d.structure->sites={{"factory-demo","Factory",lmti::Privacy::Internal}};
        d.structure->subsystems={{"visible","Visible branch","",lmti::Privacy::Public},
            {"internal","Internal branch","",lmti::Privacy::Internal},
            {"internal-parent","Internal parent","",lmti::Privacy::Internal},
            {"inherited-child","Child beneath internal","internal-parent",lmti::Privacy::Public}};
        d.structure->component_memberships={{"sensor-firmware","visible"},{"gateway-agent","internal"}};
        d.repositories[0].privacy=lmti::Privacy::Internal;
        d.topology.revision=lmti::save_project(project,d);
        auto second=lmti::demo_project();second.structure.emplace();
        second.structure->sites={{"factory-demo","Factory",lmti::Privacy::Internal}};
        second.project.label="Substitute project";
        second.topology.revision=lmti::save_project(replacement,second);
        lmti::remember_library_project(library,{"factory-monitor","Synthetic hierarchy row",project,root});
        if(schema>=2)need(lmti::upgrade_project_library(library,backups,lmti::inspect_project_library(library).token).state==
            lmti::LibraryUpgradeState::Upgraded);
        if(schema==3)need(lmti::upgrade_library_activation_format(library,backups,lmti::inspect_library_activation_upgrade(library)).state==
            lmti::LibraryUpgradeState::Upgraded);
        // Intentionally no profile store exists anywhere in this fixture.
    }
    Expected expected()const{
        const auto catalog=lmti::inspect_project_library(library);
        const auto document=lmti::load_project(project);
        Expected e;e.project_id="factory-monitor";
        e.library={catalog.token.schema,catalog.token.canonical_path,catalog.token.library_uuid,physical(library)};
        e.project={2,QString::fromStdString(document.storage_lineage->store_uuid),physical(project)};
        e.linked_root=root;return e;
    }
    lmti::OriginalHierarchyRead read(const Expected &e,bool internal=true)const{
        return lmti::read_original_hierarchy_state(library,{"factory-monitor",true,internal},e);
    }
};
bool subsystem(const lmti::LogicalHierarchyProjection &p,const std::string &id){
    return std::any_of(p.subsystems.begin(),p.subsystems.end(),[&](const auto&r){return r.value.id==id;});
}
bool component(const lmti::LogicalHierarchyProjection &p,const std::string &id){
    return std::any_of(p.components.begin(),p.components.end(),[&](const auto&r){return r.value.id==id;});
}
void schema_privacy_and_current_revision(){
    for(const int schema:{1,2,3}){
        Fixture f(schema,schema==3);const auto e=f.expected();const auto before=tree(f.temp.path());
        int profile_opens=0;
        {Hook hook([&](Phase p,const QString&){if(p==Phase::BeforeProfileOpen)++profile_opens;});
         const auto pub=f.read(e,false),internal=f.read(e,true);
         check(pub.library.schema==schema&&pub.state.snapshot.schema==2&&
             pub.state.snapshot.store_uuid==e.project.store_uuid,"Original immutable identities changed.");
         check(pub.state.projection.subsystems.size()==1&&subsystem(pub.state.projection,"visible")&&
             pub.state.projection.components.size()==1&&component(pub.state.projection,"monitor-backend"),
             "Public state leaked inherited repository/subsystem privacy or promoted hidden children.");
         check(internal.state.projection.subsystems.size()==4&&component(internal.state.projection,"sensor-firmware")&&
             component(internal.state.projection,"gateway-agent")&&subsystem(internal.state.projection,"internal-parent")&&
             std::any_of(internal.state.projection.subsystems.begin(),internal.state.projection.subsystems.end(),
                 [](const auto &row){return row.value.id=="inherited-child"&&
                     row.classification==lmti::Privacy::Internal&&row.ancestors==std::vector<std::string>{"internal-parent"};}),
             "Internal projection lost authorized rows or failed to retain inherited classification/ancestry.");
         const auto ordinary=lmti::inspect_logical_hierarchy(f.project,{"factory-monitor",true,true});
         check(internal.state.snapshot==ordinary.snapshot,"Conditional capture changed existing native snapshot digest framing.");}
        check(profile_opens==0&&tree(f.temp.path())==before,"Hierarchy state touched profiles or modified native data.");
        need(QDir().rmdir(f.root));
        {Sql db(f.project);db.exec("UPDATE project SET revision=9007199254740990");}
        const auto changed=tree(f.temp.path());const auto fresh=f.read(e);
        check(fresh.state.projection.revision==9007199254740990LL&&
             fresh.state.snapshot.revision==9007199254740990LL&&tree(f.temp.path())==changed,
             "Current maximum valid read revision/offline linked root was refused or altered.");
    }
}
void identity_before_content(){
    Fixture f;const auto original=f.expected();const auto before=tree(f.temp.path());
    for(const int field:{0,1,2,3}){
        auto e=original;
        if(field==0)e.library.uuid=uuid();
        if(field==1)e.project.store_uuid=uuid();
        if(field==2)e.project.physical.chain.back().ino="9007199254740993";
        if(field==3)e.linked_root=f.other_root;
        int content=0,profiles=0;
        Hook hook([&](Phase p,const QString&){if(p==Phase::BeforeProjectContent)++content;if(p==Phase::BeforeProfileOpen)++profiles;});
        refused([&]{f.read(e);},Code::ConfigChanged);
        check(content==0&&profiles==0,"Mismatched immutable identity read project content/profile.");
    }
    check(tree(f.temp.path())==before,"Identity refusal mutated files.");
    {Sql db(f.project);db.exec("UPDATE project SET id='different-project'");
        db.exec("UPDATE components SET kind='invalid-kind'");}
    int content=0;
    {Hook hook([&](Phase p,const QString&){if(p==Phase::BeforeProjectContent)++content;});
     refused([&]{f.read(original);},Code::ConfigChanged);}
    check(content==0,"Project ID mismatch reached graph validation before rejection.");
}
void catalog_race_original_only(){
    for(const int schema:{1,3}){
        Fixture f(schema);const auto e=f.expected();const auto main=hash(f.project),other=hash(f.replacement);
        int opened=0,substituted=0,selected=0;
        Hook hook([&](Phase p,const QString &path){
            if(p==Phase::AfterInitialLocatorCompared){
                ++selected;auto token=lmti::inspect_project_library(f.library).token;
                if(schema==1){
                    lmti::forget_library_project(f.library,"factory-monitor");
                    lmti::remember_library_project(f.library,{"factory-monitor","Substitute project",f.replacement,f.root});
                }else{
                    token=lmti::forget_library_project_cas(f.library,"factory-monitor",token);
                    lmti::register_library_project_cas(f.library,{"factory-monitor","Substitute project",f.replacement,f.root},token);
                }
            }
            if(p==Phase::BeforeProjectOpen){++opened;if(path!=f.project)++substituted;}
        });
        refused([&]{f.read(e);},Code::ConfigChanged);
        check(selected==1&&opened==1&&substituted==0&&hash(f.project)==main&&hash(f.replacement)==other,
            "Catalog edit reselected/substituted project I/O or changed either native project.");
    }
}
QString local_key(QString path){
    path=QDir::cleanPath(QDir::fromNativeSeparators(path));
#ifdef Q_OS_WIN
    path=path.toCaseFolded();
#endif
    return path;
}
void ordinary_fixture_root(const QString &root){
    const QFileInfo info(root);
    need(info.isAbsolute()&&!root.startsWith("//")&&!root.startsWith("\\\\")&&
        info.isDir()&&!info.isSymLink()&&!info.isJunction()&&!info.canonicalFilePath().isEmpty()&&
        local_key(info.absoluteFilePath())==local_key(info.canonicalFilePath()));
}
void fixture_move_paths(const QString &root,const QString &source,const QString &destination){
    ordinary_fixture_root(root);const auto prefix=local_key(root)+"/";
    const QFileInfo from(source),to(destination),parent(to.dir().absolutePath());
    need(from.isAbsolute()&&to.isAbsolute()&&local_key(source).startsWith(prefix)&&
        local_key(destination).startsWith(prefix)&&
        QDir::fromNativeSeparators(source)==QDir::cleanPath(QDir::fromNativeSeparators(source))&&
        QDir::fromNativeSeparators(destination)==QDir::cleanPath(QDir::fromNativeSeparators(destination)));
    need((from.isFile()||from.isDir())&&!from.isSymLink()&&!from.isJunction()&&
        !from.canonicalFilePath().isEmpty()&&local_key(from.canonicalFilePath())==local_key(source)&&
        parent.isDir()&&!parent.isSymLink()&&!parent.isJunction()&&!parent.canonicalFilePath().isEmpty()&&
        local_key(parent.canonicalFilePath())==local_key(parent.absoluteFilePath())&&
        (local_key(parent.canonicalFilePath())==local_key(root)||local_key(parent.canonicalFilePath()).startsWith(prefix))&&
        !to.exists()&&!to.isSymLink()&&!to.isJunction());
    for(const auto &start:{from.dir().absolutePath(),parent.absoluteFilePath()}){
        auto current=start;
        while(local_key(current)!=local_key(root)){
            const QFileInfo item(current);
            need(local_key(current).startsWith(prefix)&&item.isDir()&&!item.isSymLink()&&!item.isJunction());
            const auto next=item.dir().absolutePath();need(next!=current);current=next;
        }
    }
}
bool move_local(const QString &root,const QString &source,const QString &destination){
    fixture_move_paths(root,source,destination);
#ifdef Q_OS_WIN
    return MoveFileW(reinterpret_cast<LPCWSTR>(source.utf16()),reinterpret_cast<LPCWSTR>(destination.utf16()))!=0;
#else
    return QFile::rename(source,destination);
#endif
}

void leases_and_replacements(){
    for(const bool fail:{false,true}){
        Fixture f;const auto e=f.expected();const auto before=tree(f.temp.path());
        {Hook hook([&](Phase p,const QString&){
            if(p!=Phase::AfterLeasesAcquired)return;
            for(const auto &path:{f.library,f.project,f.store})
                check(!move_local(f.temp.path(),path,path+"-held"),"Original namespace rename succeeded while held.");
            if(fail)throw lmti::Error("Controlled read interruption.");
         });
         if(fail)refused([&]{f.read(e);},Code::OwnerUnavailable);else f.read(e);}
        for(const auto &path:{f.library,f.project,f.store}){
            need(move_local(f.temp.path(),path,path+"-released"));
            need(move_local(f.temp.path(),path+"-released",path));
        }
        check(tree(f.temp.path())==before,"Lease release checks changed data or leaked handles.");
    }
    for(const bool library:{false,true}){
        Fixture f;const auto e=f.expected();const auto path=library?f.library:f.project;
        need(move_local(f.temp.path(),path,path+"-retained")&&QFile::copy(path+"-retained",path));
        const auto before=tree(f.temp.path());int content=0;
        {Hook hook([&](Phase p,const QString&){if(p==Phase::BeforeProjectContent)++content;});
         refused([&]{f.read(e);},Code::ConfigChanged);}
        check(content==0&&tree(f.temp.path())==before,"Same-path replacement was read or changed.");
    }
}
void sidecars_and_wal(){
    {
        Fixture f;const auto e=f.expected();
        Sql catalog(f.library),project(f.project);
        for(auto *db:{&catalog,&project}){db->exec("PRAGMA journal_mode=WAL");db->exec("PRAGMA wal_autocheckpoint=0");}
        catalog.exec("UPDATE library_entries SET label='WAL hierarchy row' WHERE id='factory-monitor'");
        project.exec("UPDATE project SET revision=2");
        need(QFileInfo(f.project+"-wal").size()>32&&QFileInfo(f.project+"-shm").size()>0);
        const auto before=tree(f.temp.path());int retained=0;
        {Hook hook([&](Phase p,const QString&){
            if(p!=Phase::AfterLeasesAcquired)return;++retained;
            for(const auto &base:{f.library,f.project})for(const auto &suffix:{QString("-wal"),QString("-shm")})
                check(!move_local(f.temp.path(),base+suffix,base+suffix+"-moved"),"Live sidecar was not retained.");
         });
         const auto r=f.read(e);check(r.state.snapshot.revision==2&&r.state.projection.revision==2,
             "Conditional state missed committed WAL graph revision.");}
        check(retained==1&&tree(f.temp.path())==before,"Conditional state checkpointed main/WAL or altered SHM shape.");
    }
    for(const auto &suffix:{QString("-journal"),QString("-wal"),QString("-shm")}){
        Fixture f;const auto e=f.expected();put(f.project+suffix,"unusable sidecar");
        const auto before=tree(f.temp.path());
        refused([&]{f.read(e);},Code::OwnerUnavailable);
        check(tree(f.temp.path())==before,"Unsafe sidecar was repaired/modified.");
    }
    {
        Fixture f;const auto e=f.expected();
        Hook hook([&](Phase p,const QString&){if(p==Phase::BeforeFinalVerification)put(f.project+"-journal",{});});
        refused([&]{f.read(e);},Code::ConfigChanged);
    }
}
void pure_invalid(){
    Fixture f;const auto original=f.expected();const auto before=tree(f.temp.path());int phases=0;
    Hook hook([&](Phase,const QString&){++phases;});
    {auto e=original;e.library.physical.chain[0].dev="4294967296";refused([&]{f.read(e);},Code::InvalidInput);}
    {auto e=original;e.project.physical.chain.back().birthtime_ns="1792482362793881701";refused([&]{f.read(e);},Code::InvalidInput);}
    {auto e=original;e.project.physical.chain.resize(65,e.project.physical.chain[0]);refused([&]{f.read(e);},Code::LimitExceeded);}
    {auto e=original;e.project.schema=1;e.project.store_uuid.clear();refused([&]{f.read(e);},Code::InvalidInput);}
    {auto e=original;e.library.physical.state=State::Missing;refused([&]{f.read(e);},Code::RecoveryRequired);}
    {auto e=original;e.project_id="other-project";refused([&]{f.read(e);},Code::ScopeDenied);}
    {auto e=original;e.project.physical.path="\\\\server\\share\\project.sqlite";refused([&]{f.read(e);},Code::InvalidInput);}
    refused([&]{lmti::read_original_hierarchy_state(f.library,{"factory-monitor",false,true},original);},Code::ScopeDenied);
    check(phases==0&&tree(f.temp.path())==before,"Malformed request reached namespace/read phases or changed native files.");
}
QJsonObject physical_json(const lmti::OriginalPhysicalTarget &p){
    QJsonArray chain;for(const auto &id:p.chain)
        chain.append(QJsonObject{{"dev",id.dev},{"ino",id.ino},{"birthtimeNs",id.birthtime_ns}});
    return {{"version",1},{"path",p.path},{"kind","file"},
        {"state",p.state==State::Present?"present":"missing"},{"chain",chain}};
}
struct Frame{QByteArray bytes;QJsonObject value;};
Frame invoke(const QString &binary,const QStringList &arguments,const QByteArray &input){
    QProcess child;child.setProgram(binary);child.setArguments(arguments);child.start();
    need(child.waitForStarted(5000),"Read-only facade did not start.");
    need(child.write(input)==input.size(),"Read-only facade input could not be queued.");child.closeWriteChannel();
    if(!child.waitForFinished(30000)){child.kill();child.waitForFinished(5000);throw lmti::Error("Read-only facade deadline expired.");}
    need(child.exitStatus()==QProcess::NormalExit&&child.exitCode()==0&&child.readAllStandardError().isEmpty(),
        "Facade failed without a bounded private response.");
    const auto out=child.readAllStandardOutput();
    check(!out.isEmpty()&&out.endsWith('\n')&&out.size()<=512*1024,"Facade response lacked complete bounded LF framing.");
    return {out,lmti::detail::strict_json_object(out,512*1024)};
}
void error(const Frame &frame,const QString &code){
    check(frame.value==QJsonObject{{"ok",false},{"code",code}},"Private refusal leaked payload or used the wrong fixed code.");
}
void exact_fields(const QJsonObject &value,const QSet<QString> &wanted){
    QSet<QString> actual;for(auto it=value.begin();it!=value.end();++it)actual.insert(it.key());
    check(actual==wanted,"Wire contract omitted a field or disclosed an unapproved extra field.");
}

QJsonObject request(const Expected &e){
    return {{"action","logical-hierarchy-original-state"},{"expected",QJsonObject{
        {"version",1},{"projectId",QString::fromStdString(e.project_id)},
        {"library",QJsonObject{{"schema",e.library.schema},{"canonicalPath",e.library.canonical_path},
            {"uuid",e.library.schema==1?QJsonValue(QJsonValue::Null):QJsonValue(e.library.uuid)},
            {"physical",physical_json(e.library.physical)}}},
        {"project",QJsonObject{{"schema",2},{"storeUuid",e.project.store_uuid},{"physical",physical_json(e.project.physical)}}},
        {"linkedRoot",e.linked_root}}}};
}
QStringList args(const Fixture &f){return {"--logical-hierarchy-read","--library",f.library,
    "--project","factory-monitor","--visibility","internal"};}
Frame invoke(const QString &binary,const Fixture &f,const QJsonObject &payload){
    return invoke(binary,args(f),QJsonDocument(payload).toJson(QJsonDocument::Compact));
}
void shipped_wire(const QString &binary){
    for(const int schema:{1,3}){
        Fixture f(schema,true);const auto e=f.expected();const auto before=tree(f.temp.path());
        const auto locator=invoke(binary,f,{{"action","logical-hierarchy-locator"}});
        exact_fields(locator.value,{"ok","schema","action","libraryIdentity","projectId","database","linkedRoot"});
        check(locator.value.value("ok")==true&&locator.value.value("database")==f.project&&
            locator.value.value("linkedRoot")==f.root,"Locator failed to preserve private raw selected paths.");
        const auto r=invoke(binary,f,request(e));
        exact_fields(r.value,{"ok","schema","action","libraryIdentity","projectIdentity","projection"});
        check(r.value.value("ok")==true&&r.value.value("action")=="logical-hierarchy-original-state"&&
            r.value.value("schema")=="lmti.logical-hierarchy.owner.v1","Original hierarchy success frame changed.");
        const auto ordinary=invoke(binary,f,{{"action","logical-hierarchy-state"}});
        check(r.value.value("projectIdentity")==ordinary.value.value("projectIdentity")&&
            r.value.value("projection")==ordinary.value.value("projection"),"New action changed full state framing.");
        check(tree(f.temp.path())==before,"Actual read-only CLI changed native data.");
        need(move_local(f.temp.path(),f.project,f.project+"-offline"));
        const auto offline=invoke(binary,f,{{"action","logical-hierarchy-locator"}});
        check(offline.value.value("ok")==true&&offline.value.value("database")==f.project,
            "Locator probed its offline project instead of returning selected catalog metadata.");
    }
}
void malformed_wire(const QString &binary){
    Fixture f;const auto e=f.expected();const auto before=tree(f.temp.path());
    auto value=request(e);value["profiles"]="forbidden";error(invoke(binary,f,value),"INVALID_INPUT");
    value=request(e);auto expected=value["expected"].toObject();expected["linkedRoot"]=f.other_root;value["expected"]=expected;
    error(invoke(binary,f,value),"CONFIG_CHANGED");
    value=request(e);expected=value["expected"].toObject();auto project=expected["project"].toObject();
    auto pin=project["physical"].toObject();pin["state"]="unsupported";project["physical"]=pin;expected["project"]=project;value["expected"]=expected;
    error(invoke(binary,f,value),"RECOVERY_REQUIRED");
    const auto valid=QJsonDocument(request(e)).toJson(QJsonDocument::Compact);
    error(invoke(binary,args(f),valid+QByteArray::fromHex("1a")+"garbage"),"INVALID_INPUT");
    error(invoke(binary,args(f),valid+QByteArray(1,'\0')),"INVALID_INPUT");
    error(invoke(binary,args(f),QByteArray(64*1024+1,' ')),"INVALID_INPUT");
    error(invoke(binary,f,{{"action","logical-hierarchy-locator"},{"expected",QJsonObject{}}}),"INVALID_INPUT");
    check(tree(f.temp.path())==before,"Malformed CLI input changed files or performed a write.");
}
void run(const char *name,const std::function<void()> &test){
    ++cases;std::cout<<"CASE: "<<name<<'\n';
    try{test();}catch(const std::exception &e){++failures;std::cerr<<"FAIL: "<<name<<" ["<<e.what()<<"]\n";}
    catch(...){++failures;std::cerr<<"FAIL: "<<name<<" [unclassified fixture exception]\n";}
}

} // namespace
int main(int argc,char **argv){
    QCoreApplication app(argc,argv);
    try {
        need(app.arguments().size()==2,"Provide current native admin.");
#ifdef Q_OS_WIN
        run("schema/privacy/current-revision matrix without profiles",schema_privacy_and_current_revision);
        run("immutable identity rejection before graph content",identity_before_content);
        run("catalog CAS after selection opens only original project",catalog_race_original_only);
        run("namespace leases/release and physical replacements",leases_and_replacements);
        run("real WAL and sidecar presence/refusal",sidecars_and_wal);
        run("pure request validation before namespace access",pure_invalid);
        run("shipped locator/conditional state and old state compatibility",[&]{shipped_wire(app.arguments()[1]);});
        run("shipped strict frames and exact identity envelope",[&]{malformed_wire(app.arguments()[1]);});
#else
        ++skips;std::cout<<"SKIP: Windows original namespace guarantee unavailable.\n";
#endif
    }catch(const std::exception &e){++failures;std::cerr<<"FAIL: setup ["<<e.what()<<"]\n";}
    std::cout<<"original hierarchy read: "<<cases<<" cases, "<<checks<<" checks, "<<failures<<" failures, "<<skips<<" skips\n";
    return failures?1:0;
}
