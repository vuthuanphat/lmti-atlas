#include "lmti/project_original_read.hpp"
#include "../storage/original_read_p.hpp"
#include <QCoreApplication>
#include <QCryptographicHash>
#include <QDir>
#include <QFile>
#include <QFileInfo>
#include <QMap>
#include <QSqlDatabase>
#include <QSqlQuery>
#include <QTemporaryDir>
#include <QUuid>
#include <algorithm>
#include <functional>
#include <iostream>
#ifdef Q_OS_WIN
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#endif

#ifndef LMTI_ORIGINAL_READ_TEST_HOOKS
#error Compile only this isolated test target with original-read hooks.
#endif

namespace {
using Code=lmti::OriginalReadCode;
using Phase=lmti::detail::OriginalReadPhase;
using Expected=lmti::OriginalPhysicalHierarchyExpected;
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

lmti::Asset asset(const std::string &id,const std::string &site="factory-demo",
                  lmti::Privacy privacy=lmti::Privacy::Public){
    lmti::Asset result;result.id=id;result.label="Synthetic "+id;result.site=site;result.privacy=privacy;
    return result;
}
lmti::ProjectDocument physical_document(){
    using P=lmti::Privacy;
    auto d=lmti::demo_project();d.structure.emplace();auto &s=*d.structure;
    // Unrelated logical hierarchy remains present but cannot grant physical access.
    s.subsystems={{"software","Software branch","",P::Internal}};
    s.component_memberships={{"sensor-firmware","software"}};
    s.sites={{"factory-demo","Factory",P::Public},{"hidden-site","Internal site",P::Internal}};
    s.areas={{"floor","Floor","factory-demo","",P::Public},
             {"cell","Cell","factory-demo","floor",P::Public},
             {"hidden-area","Internal area","factory-demo","",P::Internal},
             {"hidden-child","Public child","factory-demo","hidden-area",P::Public}};
    s.environments={{"live","Live",P::Public},{"unused-env","Unused",P::Public},
                    {"hidden-env","Internal environment",P::Internal}};
    s.asset_placements={{"broker-c","cell","","live",lmti::PhysicalRole::Host},
                        {"gateway-b","cell","broker-c","live",lmti::PhysicalRole::Gateway},
                        {"machine-a","cell","gateway-b","live",lmti::PhysicalRole::Device}};
    d.topology.assets.push_back(asset("undeclared"));
    d.topology.assets.push_back(asset("declared-empty"));
    d.topology.assets.push_back(asset("site-leaf","hidden-site"));
    d.topology.assets.push_back(asset("area-leaf"));
    d.topology.assets.push_back(asset("env-leaf"));
    d.topology.assets.push_back(asset("private-parent","factory-demo",P::Internal));
    d.topology.assets.push_back(asset("parent-leaf"));
    s.asset_placements.push_back({"declared-empty","","","",std::nullopt});
    s.asset_placements.push_back({"area-leaf","hidden-child","","",std::nullopt});
    s.asset_placements.push_back({"env-leaf","","","hidden-env",std::nullopt});
    s.asset_placements.push_back({"private-parent","","","",std::nullopt});
    s.asset_placements.push_back({"parent-leaf","","private-parent","",std::nullopt});
    lmti::validate(d);return d;
}
struct Fixture {
    QTemporaryDir temp{QDir(QDir::tempPath()).filePath("lmti-original-physical-XXXXXX")};
    QString store,library,project,root,other_root,replacement,backups;
    explicit Fixture(int schema=3,bool unicode=false,bool structured=true){
        need(temp.isValid());store=mkdir(temp.path(),unicode?QString::fromUtf8("Vật-lý-測試"):QString("stores"));
        library=at(store,"library.sqlite");project=at(store,"project.sqlite");
        root=mkdir(temp.path(),"linked-root");other_root=mkdir(temp.path(),"other-root");
        backups=mkdir(temp.path(),"backups");replacement=at(temp.path(),"substitute.sqlite");
        auto d=structured?physical_document():lmti::demo_project();
        d.topology.revision=lmti::save_project(project,d);
        auto second=physical_document();second.project.label="Substitute project";
        second.topology.revision=lmti::save_project(replacement,second);
        lmti::remember_library_project(library,{"factory-monitor","Synthetic physical row",project,root});
        if(schema>=2)need(lmti::upgrade_project_library(library,backups,lmti::inspect_project_library(library).token).state==
            lmti::LibraryUpgradeState::Upgraded);
        if(schema==3)need(lmti::upgrade_library_activation_format(library,backups,lmti::inspect_library_activation_upgrade(library)).state==
            lmti::LibraryUpgradeState::Upgraded);
        // No profiles store exists: the physical read has no profile dependency.
    }
    Expected expected()const{
        const auto catalog=lmti::inspect_project_library(library);
        const auto document=lmti::load_project(project);
        Expected e;e.project_id="factory-monitor";
        e.library={catalog.token.schema,catalog.token.canonical_path,catalog.token.library_uuid,physical(library)};
        // The flat fixture deliberately submits a well-shaped schema-2 identity
        // against a valid schema-1 store, isolating the pre-content schema gate.
        e.project={2,document.storage_lineage?QString::fromStdString(document.storage_lineage->store_uuid):uuid(),
                   physical(project)};
        e.linked_root=root;return e;
    }
    lmti::OriginalPhysicalHierarchyRead read(const Expected &e,bool internal=true)const{
        return lmti::read_original_physical_hierarchy_state(library,{"factory-monitor",true,internal},e);
    }
};
template<typename Row> const Row &row(const std::vector<Row> &rows,const std::string &id){
    const auto found=std::find_if(rows.begin(),rows.end(),[&](const auto &r){return r.value.id==id;});
    need(found!=rows.end(),"Expected physical fixture row missing.");return *found;
}
template<typename Row> bool contains(const std::vector<Row> &rows,const std::string &id){
    return std::any_of(rows.begin(),rows.end(),[&](const auto &r){return r.value.id==id;});
}
void equal_projection(const lmti::PhysicalHierarchyProjection &a,const lmti::PhysicalHierarchyProjection &b){
    check(a.project_id==b.project_id&&a.revision==b.revision&&a.sites.size()==b.sites.size()&&
          a.areas.size()==b.areas.size()&&a.environments.size()==b.environments.size()&&a.assets.size()==b.assets.size(),
          "Conditional state changed complete physical projection counts/identity.");
    for(const auto &r:a.sites){const auto &other=row(b.sites,r.value.id);
        check(r.value==other.value&&r.classification==other.classification,"Site projection differs.");}
    for(const auto &r:a.areas){const auto &other=row(b.areas,r.value.id);
        check(r.value==other.value&&r.ancestors==other.ancestors&&r.classification==other.classification,"Area projection differs.");}
    for(const auto &r:a.environments){const auto &other=row(b.environments,r.value.id);
        check(r.value==other.value&&r.classification==other.classification,"Environment projection differs.");}
    for(const auto &r:a.assets){const auto &other=row(b.assets,r.value.id);
        check(r.value==other.value&&r.placement==other.placement&&r.path==other.path&&r.classification==other.classification,
              "Asset placement/path/classification differs.");}
}
void schema_privacy_and_current_revision(){
    using P=lmti::Privacy;
    for(const int schema:{1,2,3}){
        Fixture f(schema,schema==3);const auto e=f.expected();const auto before=tree(f.temp.path());
        int profile_opens=0;
        {Hook hook([&](Phase p,const QString&){if(p==Phase::BeforeProfileOpen)++profile_opens;});
         const auto pub=f.read(e,false),internal=f.read(e,true);
         check(pub.library.schema==schema&&pub.state.snapshot.schema==2&&pub.state.snapshot.store_uuid==e.project.store_uuid,
               "Original immutable identities changed.");
         check(pub.state.projection.sites.size()==1&&pub.state.projection.areas.size()==2&&
               pub.state.projection.environments.size()==2&&pub.state.projection.assets.size()==5,
               "Public physical state omitted authorized rows or leaked inherited privacy.");
         check(!contains(pub.state.projection.areas,"hidden-child")&&!contains(pub.state.projection.assets,"site-leaf")&&
               !contains(pub.state.projection.assets,"area-leaf")&&!contains(pub.state.projection.assets,"env-leaf")&&
               !contains(pub.state.projection.assets,"parent-leaf"),
               "Hidden ancestor promoted a child to a visible root.");
         const auto &full=internal.state.projection;
         check(full.sites.size()==2&&full.areas.size()==4&&full.environments.size()==3&&full.assets.size()==10,
               "Internal view lost authorized physical catalogs or assets.");
         const auto &child=row(full.areas,"hidden-child");
         check(child.value.privacy==P::Public&&child.classification==P::Internal&&
               child.ancestors==std::vector<std::string>{"hidden-area"},"Stored and inherited Area privacy were conflated.");
         const auto &machine=row(full.assets,"machine-a");
         check(machine.path.site_id=="factory-demo"&&machine.path.area_ancestors==std::vector<std::string>{"floor","cell"}&&
               machine.path.asset_ancestors==std::vector<std::string>{"broker-c","gateway-b"}&&machine.path.environment_id=="live",
               "Physical containment or independent environment membership was lost.");
         check(!row(full.assets,"undeclared").placement&&row(full.assets,"declared-empty").placement.has_value()&&
               !row(full.assets,"declared-empty").placement->role&&contains(full.environments,"unused-env"),
               "Undeclared/empty placement, unknown role or unused environment was lost.");
         const auto ordinary=lmti::inspect_physical_hierarchy(f.project,{"factory-monitor",true,true});
         check(internal.state.snapshot==ordinary.snapshot,"Conditional capture changed existing snapshot digest framing.");
         equal_projection(full,ordinary.projection);}
        check(profile_opens==0&&tree(f.temp.path())==before,"Physical state touched profiles or changed native data.");
        need(QDir().rmdir(f.root));
        {Sql db(f.project);db.exec("UPDATE project SET revision=9007199254740990");}
        const auto changed=tree(f.temp.path());const auto fresh=f.read(e);
        check(fresh.state.projection.revision==9007199254740990LL&&fresh.state.snapshot.revision==9007199254740990LL&&
               tree(f.temp.path())==changed,"Current maximum valid revision/offline linked root was refused or changed.");
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
    check(tree(f.temp.path())==before,"Identity refusal changed files.");
    for(const int field:{0,1,2}){
        Fixture changed(3,false,field!=0);const auto e=changed.expected();
        {Sql db(changed.project);
         if(field==1)db.exec("UPDATE project SET id='different-project'");
         if(field==2)db.exec("UPDATE store_identity SET store_uuid=?",{uuid()});
         db.exec("UPDATE assets SET kind='invalid-fixture-kind'");}
        int content=0,opens=0;const auto baseline=tree(changed.temp.path());
        {Hook hook([&](Phase p,const QString&){if(p==Phase::BeforeProjectContent)++content;if(p==Phase::BeforeProjectOpen)++opens;});
         refused([&]{changed.read(e);},Code::ConfigChanged);}
        check(opens==1&&content==0&&tree(changed.temp.path())==baseline,
              "Valid wrong schema/project/store UUID reached deliberately invalid graph content.");
    }
}
void catalog_race_original_only(){
    for(const int schema:{1,3})for(const int change:{0,1,2}){
        Fixture f(schema);const auto e=f.expected();const auto main=hash(f.project),other=hash(f.replacement);
        int opened=0,substituted=0,content=0,selected=0;
        Hook hook([&](Phase p,const QString &path){
            if(p==Phase::AfterInitialLocatorCompared){
                ++selected;auto token=lmti::inspect_project_library(f.library).token;
                if(change==2){
                    if(schema==1)lmti::link_library_folder(f.library,"factory-monitor",f.other_root);
                    else lmti::link_library_folder_cas(f.library,"factory-monitor",f.other_root,token);
                }else if(schema==1){
                    lmti::forget_library_project(f.library,"factory-monitor");
                    if(change==0)lmti::remember_library_project(f.library,{"factory-monitor","Substitute project",f.replacement,f.root});
                }else{
                    token=lmti::forget_library_project_cas(f.library,"factory-monitor",token);
                    if(change==0)lmti::register_library_project_cas(f.library,{"factory-monitor","Substitute project",f.replacement,f.root},token);
                }
            }
            if(p==Phase::BeforeProjectOpen){++opened;if(path!=f.project)++substituted;}
            if(p==Phase::BeforeProjectContent){++content;if(path!=f.project)++substituted;}
        });
        refused([&]{f.read(e);},Code::ConfigChanged);
        check(selected==1&&opened==1&&content==1&&substituted==0&&hash(f.project)==main&&hash(f.replacement)==other,
              "Catalog rebind/forget/root edit reselected a substitute or changed native project bytes.");
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
    refused([&]{lmti::read_original_physical_hierarchy_state(f.library,{"factory-monitor",false,true},original);},Code::ScopeDenied);
    check(phases==0&&tree(f.temp.path())==before,"Malformed request reached namespace/read phases or changed native files.");
}
void physical_error_routing(){
    {
        Fixture f;const auto e=f.expected();
        {Sql db(f.project);db.exec("UPDATE project SET privacy='internal'");}
        const auto before=tree(f.temp.path());int content=0;
        Hook hook([&](Phase p,const QString&){if(p==Phase::BeforeProjectContent)++content;});
        try{f.read(e,false);check(false,"Physical scope refusal was missing.");}
        catch(const lmti::PhysicalHierarchyError &error){
            check(error.code()==lmti::PhysicalHierarchyCode::ScopeDenied&&
                  QByteArray(error.what())=="Physical hierarchy operation was refused.",
                  "Physical projection scope error lost its independent bounded type/code.");
        }
        check(content==1&&tree(f.temp.path())==before,"Physical scope refusal changed native data.");
    }
    {
        Fixture f;const auto e=f.expected();const auto before=tree(f.temp.path());int content=0;
        Hook hook([&](Phase p,const QString&){
            if(p==Phase::BeforeProjectContent){++content;throw lmti::ProjectCopyError(lmti::ProjectCopyCode::BudgetExceeded);}
        });
        // A controlled budget exception at the existing capture seam tests the
        // independent mapping; it is not an elapsed-time or real I/O budget test.
        try{f.read(e);check(false,"Injected capture-budget refusal was missing.");}
        catch(const lmti::PhysicalHierarchyError &error){
            check(error.code()==lmti::PhysicalHierarchyCode::BudgetExceeded&&
                  QByteArray(error.what())=="Physical hierarchy operation was refused.",
                  "Shared capture budget was erased by the physical orchestration.");
        }
        check(content==1&&tree(f.temp.path())==before,"Budget mapping changed native data or skipped capture.");
    }
}
void one_connection_snapshot(){
    Fixture f;const auto e=f.expected();Sql writer(f.project);
    writer.exec("PRAGMA journal_mode=WAL");writer.exec("PRAGMA wal_autocheckpoint=0");
    writer.exec("UPDATE project SET label='WAL starting snapshot'");
    // The source-side snapshot is established by schema/identity checks before
    // this callback. A concurrent committed writer must not alter its graph.
    int content=0;
    {Hook hook([&](Phase p,const QString&){
        if(p==Phase::BeforeProjectContent){
            ++content;writer.exec("BEGIN IMMEDIATE");
            writer.exec("UPDATE sites SET label='After snapshot' WHERE id='factory-demo'");
            writer.exec("UPDATE project SET revision=2");writer.exec("COMMIT");
        }
     });
     const auto held=f.read(e);
     check(content==1&&held.state.snapshot.revision==1&&held.state.projection.revision==1&&
           row(held.state.projection.sites,"factory-demo").value.label=="Factory",
           "Identity and physical content used different project read snapshots.");}
    const auto fresh=f.read(e);
    check(fresh.state.snapshot.revision==2&&row(fresh.state.projection.sites,"factory-demo").value.label=="After snapshot",
          "A later identity-only read did not observe the current original-project state.");
}
void run(const char *name,const std::function<void()> &test){
    ++cases;std::cout<<"CASE: "<<name<<'\n';
    try{test();}catch(const std::exception &e){++failures;std::cerr<<"FAIL: "<<name<<" ["<<e.what()<<"]\n";}
    catch(...){++failures;std::cerr<<"FAIL: "<<name<<" [unclassified fixture exception]\n";}
}

} // namespace
int main(int argc,char **argv){
    QCoreApplication app(argc,argv);
    try{
        need(app.arguments().size()==1,"Original physical owner suite takes no process arguments.");
#ifdef Q_OS_WIN
        run("schema/privacy/placement/current-revision matrix without profiles",schema_privacy_and_current_revision);
        run("schema/ID/UUID mismatch before physical content",identity_before_content);
        run("catalog CAS after selection opens only original project",catalog_race_original_only);
        run("namespace leases/release and physical replacements",leases_and_replacements);
        run("real WAL and sidecar presence/refusal",sidecars_and_wal);
        run("pure physical request validation before namespace access",pure_invalid);
        run("independent physical scope and capture budget errors",physical_error_routing);
        run("one connection binds immutable identity and physical content",one_connection_snapshot);
#else
        ++skips;std::cout<<"SKIP: Windows original namespace guarantee unavailable.\n";
#endif
    }catch(const std::exception &e){++failures;std::cerr<<"FAIL: setup ["<<e.what()<<"]\n";}
    std::cout<<"original physical hierarchy read: "<<cases<<" cases, "<<checks<<" checks, "<<failures<<" failures, "<<skips<<" skips\n";
    return failures?1:0;
}
