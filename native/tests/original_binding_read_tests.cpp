#include "lmti/mcp_original_read.hpp"
#include "lmti/mcp_profile_store.hpp"
#include "../storage/mcp_original_read_p.hpp"
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
using Expected=lmti::OriginalBindingExpected;
using Policy=lmti::MissingProfilePolicy;
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
    QTemporaryDir temp{QDir(QDir::tempPath()).filePath("lmti-original-binding-XXXXXX")};
    QString store,library,project,profiles,root,other_root,replacement,backups;
    int library_schema,project_schema;
    explicit Fixture(int ls=3,int ps=2,bool profile=true,bool unicode=false):library_schema(ls),project_schema(ps){
        need(temp.isValid());store=mkdir(temp.path(),unicode?QString::fromUtf8("Thư-viện-測試"):QString("stores"));
        library=at(store,"library.sqlite");project=at(store,"project.sqlite");profiles=at(store,"profiles.sqlite");
        root=mkdir(temp.path(),"linked-root");other_root=mkdir(temp.path(),"other-root");backups=mkdir(temp.path(),"backups");
        replacement=at(temp.path(),"substitute.sqlite");
        put(at(temp.path(),"original-read-fixture.marker"),"lmti.original.read.fixture.v1\n");
        auto document=lmti::demo_project();
        if(ps==2){document.structure.emplace();document.structure->sites={{"factory-demo","Factory",lmti::Privacy::Internal}};}
        document.topology.revision=lmti::save_project(project,document);
        auto second=lmti::demo_project();second.project.label="Substitute project";
        if(ps==2){second.structure.emplace();second.structure->sites={{"factory-demo","Factory",lmti::Privacy::Internal}};}
        second.topology.revision=lmti::save_project(replacement,second);
        lmti::remember_library_project(library,{"factory-monitor","Synthetic library row",project,root});
        // Normal enrollment requires an existing file. Retain its library row
        // after removing this fixed fixture file to model an offline sibling.
        const auto offline_path=at(temp.path(),"offline.sqlite");
        auto offline=lmti::demo_project();offline.project.id="offline-project";offline.project.label="Offline sibling";
        offline.topology.revision=lmti::save_project(offline_path,offline);
        lmti::remember_library_project(library,{"offline-project","Offline sibling",offline_path,{}});
        if(ls>=2)need(lmti::upgrade_project_library(library,backups,lmti::inspect_project_library(library).token).state==
            lmti::LibraryUpgradeState::Upgraded);
        if(ls==3)need(lmti::upgrade_library_activation_format(library,backups,lmti::inspect_library_activation_upgrade(library)).state==
            lmti::LibraryUpgradeState::Upgraded);
        need(QFile::remove(offline_path),"Offline fixture removal failed.");
        if(profile)save_profile();
    }
    void save_profile(){
        lmti::McpProfile p{"factory-monitor",0,{{"context","Fixture context","","factory-demo",
            lmti::McpTransport::LmtiLocal,lmti::McpAuth::None}}};
        need(lmti::save_mcp_profile(profiles,p)==1);
    }
    Expected expected()const{
        const auto catalog=lmti::inspect_project_library(library);
        const auto document=lmti::load_project(project);
        Expected e;e.project_id="factory-monitor";
        e.library={catalog.token.schema,catalog.token.canonical_path,catalog.token.library_uuid,physical(library)};
        e.project={project_schema,project_schema==2?QString::fromStdString(document.storage_lineage->store_uuid):QString{},physical(project)};
        e.profiles=physical(profiles,!QFileInfo::exists(profiles));e.linked_root=root;return e;
    }
    lmti::OriginalBindingRead read(const Expected &e,Policy p=Policy::PresentOnly)const{
        return lmti::read_original_mcp_state(library,profiles,e,p);
    }
};
lmti::OriginalBindingRead unchanged(const Fixture &f,const Expected &e,Policy p=Policy::PresentOnly){
    const auto before=tree(f.temp.path());auto result=f.read(e,p);
    check(tree(f.temp.path())==before,"Conditional read changed files, main/WAL bytes, or existing SHM shape.");return result;
}
void schema_matrix(){
    for(const int ls:{1,2,3})for(const int ps:{1,2}){
        Fixture f(ls,ps,true,ls==3&&ps==2);const auto e=f.expected();const auto r=unchanged(f,e);
        check(r.library.schema==ls&&r.entry.id=="factory-monitor"&&r.entry.path==f.project&&r.entry.folder==f.root,
            "Selected library snapshot or original locator was lost.");
        check(r.document.project.id=="factory-monitor"&&r.document.topology.revision==1&&
            bool(r.document.structure)==(ps==2)&&r.profile.project_id=="factory-monitor"&&r.profile.revision==1&&
            r.profile.servers.size()==1,"Typed project/profile result is incomplete or belongs to another project.");
        check(r.library.library_uuid==e.library.uuid&&
            (ps==1||QString::fromStdString(r.document.storage_lineage->store_uuid)==e.project.store_uuid),
            "Original immutable store identity was not preserved.");
        need(QDir().rmdir(f.root)); // Linked root is locator data, not a read dependency.
        check(unchanged(f,e).entry.folder==f.root,"Offline linked root blocked metadata-only conditional read.");
    }
}
void current_revisions_and_empty_row(){
    Fixture f;auto e=f.expected();
    {Sql db(f.project);db.exec("UPDATE project SET revision=9007199254740990,label='Fresh project'");}
    auto p=lmti::load_mcp_profile(f.profiles,"factory-monitor");p.servers[0].label="Fresh profile";
    need(lmti::save_mcp_profile(f.profiles,p)==2);
    const auto r=unchanged(f,e);
    check(r.document.topology.revision==9007199254740990LL&&r.document.project.label=="Fresh project"&&
        r.profile.revision==2&&r.profile.servers[0].label=="Fresh profile","Mutable revisions were pinned as immutable identity.");
    {Sql db(f.profiles);db.exec("DELETE FROM servers WHERE project='factory-monitor'");
        db.exec("DELETE FROM profiles WHERE project='factory-monitor'");}
    const auto empty=unchanged(f,e);
    check(empty.profile.revision==0&&empty.profile.servers.empty(),"Existing-store absent row did not return a complete default profile.");
}
void immutable_identity_before_content(){
    Fixture f;const auto original=f.expected();const auto before=tree(f.temp.path());
    for(const int field:{0,1,2}){
        auto e=original;auto &id=e.project.physical.chain.back();
        if(field==0)id.dev=id.dev=="1"?"2":"1";
        if(field==1)id.ino=id.ino=="9007199254740993"?"9007199254740994":"9007199254740993";
        if(field==2)id.birthtime_ns=id.birthtime_ns=="20000000000000000000"?"20000000000000000100":"20000000000000000000";
        int phases=0;Hook hook([&](Phase,const QString&){++phases;});
        refused([&]{f.read(e);},Code::ConfigChanged);check(phases==0,"Mismatched physical identity reached content-read phases.");
    }
    for(const int field:{0,1,2,3}){
        auto e=original;
        if(field==0)e.library.uuid=uuid();
        if(field==1)e.project.store_uuid=uuid();
        if(field==2){e.project.schema=1;e.project.store_uuid.clear();}
        if(field==3)e.linked_root=f.other_root;
        int graph=0,profiles=0;
        Hook hook([&](Phase p,const QString&){if(p==Phase::BeforeProjectContent)++graph;if(p==Phase::BeforeProfileOpen)++profiles;});
        refused([&]{f.read(e);},Code::ConfigChanged);
        check(graph==0&&profiles==0,"Immutable identity mismatch read graph/profile rows.");
    }
    // The same physical store now identifies a different project. Identity
    // rejection must precede graph validation, even with deliberately bad graph.
    {Sql db(f.project);db.exec("UPDATE project SET id='other-project'");db.exec("UPDATE assets SET poll=1");}
    const auto changed=tree(f.temp.path());int graph=0;
    {Hook hook([&](Phase p,const QString&){if(p==Phase::BeforeProjectContent)++graph;});
     refused([&]{f.read(original);},Code::ConfigChanged);}
    check(graph==0&&tree(f.temp.path())==changed,"Changed project identity read graph or changed the fixture.");
    check(before!=changed,"Fixture failed to introduce an actual in-place identity change.");
}
void mutate_catalog(Fixture &f,const QString &operation){
    auto token=lmti::inspect_project_library(f.library).token;
    if(operation=="root"||operation=="aba"){
        if(token.schema==1)lmti::link_library_folder(f.library,"factory-monitor",f.other_root);
        else token=lmti::link_library_folder_cas(f.library,"factory-monitor",f.other_root,token);
        if(operation=="aba")lmti::link_library_folder_cas(f.library,"factory-monitor",f.root,token);
    }else{
        if(token.schema==1)lmti::forget_library_project(f.library,"factory-monitor");
        else token=lmti::forget_library_project_cas(f.library,"factory-monitor",token);
        if(operation=="replace"){
            const lmti::LibraryEntry row{"factory-monitor","Substitute project",f.replacement,f.root};
            if(token.schema==1)lmti::remember_library_project(f.library,row);
            else lmti::register_library_project_cas(f.library,row,token);
        }
    }
}
void concurrent_locator_never_redirects(){
    for(const auto &spec:std::vector<std::pair<int,QString>>{{1,"root"},{2,"forget"},{3,"replace"},{3,"aba"}}){
        Fixture f(spec.first,2);const auto e=f.expected();const auto project=hash(f.project),profiles=hash(f.profiles);
        int selected=0,opens=0,substitute=0;
        Hook hook([&](Phase phase,const QString &path){
            if(phase==Phase::AfterInitialLocatorCompared){++selected;mutate_catalog(f,spec.second);}
            if(phase==Phase::BeforeProjectOpen){++opens;if(path!=f.project)++substitute;}
        });
        refused([&]{f.read(e);},Code::ConfigChanged);
        check(selected==1&&opens==1&&substitute==0,"Concurrent in-place catalog edit redirected or repeated project open.");
        check(hash(f.project)==project&&hash(f.profiles)==profiles,"Catalog race changed selected project/profile data.");
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
void leases_and_release(){
    for(const bool inject:{false,true}){
        Fixture f;const auto e=f.expected();const auto before=tree(f.temp.path());int leases=0;
        {
            Hook hook([&](Phase phase,const QString&){
                if(phase!=Phase::AfterLeasesAcquired)return;++leases;
                for(const auto &path:{f.library,f.project,f.profiles,f.store}){
                    const auto moved=move_local(f.temp.path(),path,path+"-moved");
#ifdef Q_OS_WIN
                    const auto error=GetLastError();
                    check(!moved&&(error==ERROR_SHARING_VIOLATION||error==ERROR_ACCESS_DENIED),
                        "Original main/ancestor rename succeeded while namespace lease was held.");
#else
                    check(!moved,"Unsupported host unexpectedly exercised namespace leases.");
#endif
                }
                if(inject)throw lmti::Error("Synthetic phase interruption.");
            });
            if(inject)refused([&]{f.read(e);},Code::OwnerUnavailable);else f.read(e);
        }
        check(leases==1&&tree(f.temp.path())==before,"Lease phase did not execute once or changed native content.");
        // These exact same moves must succeed now, proving release on both
        // normal return and exception. Only concrete disposable paths move.
        for(const auto &path:{f.library,f.project,f.profiles,f.store}){
            const auto changed=path+"-released";need(move_local(f.temp.path(),path,changed),"Retained handle leaked after read.");
            need(move_local(f.temp.path(),changed,path),"Fixture rename could not be restored.");
        }
        check(tree(f.temp.path())==before,"Rename-release check changed file bytes.");
    }
}
void replacement_before_open(){
    for(const int which:{0,1,2}){
        Fixture f;const auto e=f.expected();const auto path=which==0?f.library:which==1?f.project:f.profiles;
        const auto retained=path+"-retained";need(move_local(f.temp.path(),path,retained)&&QFile::copy(retained,path));
        const auto before=tree(f.temp.path());int phases=0;
        {Hook hook([&](Phase,const QString&){++phases;});refused([&]{f.read(e);},Code::ConfigChanged);}
        check(phases==0&&tree(f.temp.path())==before,"Same-path copied identity was read or accepted after physical replacement.");
    }
}
void absent_profile_is_never_opened(){
    {
        Fixture f(3,2,false);const auto e=f.expected();int opened=0;
        Hook hook([&](Phase p,const QString&){if(p==Phase::BeforeProfileOpen)++opened;});
        refused([&]{f.read(e);},Code::RecoveryRequired);
        const auto r=unchanged(f,e,Policy::AllowStillAbsent);
        check(opened==0&&r.profile.project_id=="factory-monitor"&&r.profile.revision==0&&r.profile.servers.empty()&&
            !QFileInfo::exists(f.profiles),"Missing profile was opened/created instead of returning an owned default.");
    }
    {
        Fixture f(3,2,false);const auto e=f.expected();int opened=0,created=0;QByteArray created_hash;
        {Hook hook([&](Phase p,const QString&){
            if(p==Phase::AfterInitialLocatorCompared){f.save_profile();created_hash=hash(f.profiles);++created;}
            if(p==Phase::BeforeProfileOpen)++opened;
         });refused([&]{f.read(e,Policy::AllowStillAbsent);},Code::ConfigChanged);}
        check(created==1&&opened==0&&hash(f.profiles)==created_hash,"Appeared profile was opened, altered, or silently repinned.");
    }
    {
        Fixture f(3,2,false);auto e=f.expected();
        e.profiles.path=at(f.temp.path(),"missing-parent/profiles.sqlite");
        // This chain has the existing volume/ancestors through temp; its next
        // absent component is a directory, not the final permitted file leaf.
        e.profiles.chain.pop_back();
        refused([&]{lmti::read_original_mcp_state(f.library,e.profiles.path,e,Policy::AllowStillAbsent);},Code::RecoveryRequired);
        check(!QFileInfo::exists(at(f.temp.path(),"missing-parent")),"Missing-parent refusal created directories.");
    }
}
void profile_updates_same_target(){
    Fixture f;const auto e=f.expected();int writes=0;
    Hook hook([&](Phase p,const QString&){
        if(p!=Phase::AfterInitialLocatorCompared)return;
        auto profile=lmti::load_mcp_profile(f.profiles,"factory-monitor");
        profile.servers[0].label="Concurrent profile";
        need(lmti::save_mcp_profile(f.profiles,profile)==2);++writes;
    });
    const auto r=f.read(e);
    check(writes==1&&r.profile.revision==2&&r.profile.servers[0].label=="Concurrent profile",
        "Namespace lease incorrectly froze legitimate in-place profile data or returned mixed rows.");
}
bool hardlink(const QString &alias,const QString &target){
#ifdef Q_OS_WIN
    return CreateHardLinkW(reinterpret_cast<LPCWSTR>(alias.utf16()),reinterpret_cast<LPCWSTR>(target.utf16()),nullptr)!=0;
#else
    (void)alias;(void)target;return false;
#endif
}
bool file_symlink(const QString &alias,const QString &target){
#ifdef Q_OS_WIN
    if(CreateSymbolicLinkW(reinterpret_cast<LPCWSTR>(alias.utf16()),reinterpret_cast<LPCWSTR>(target.utf16()),2))return true;
    if(GetLastError()==ERROR_INVALID_PARAMETER)
        return CreateSymbolicLinkW(reinterpret_cast<LPCWSTR>(alias.utf16()),reinterpret_cast<LPCWSTR>(target.utf16()),0)!=0;
#else
    (void)alias;(void)target;
#endif
    return false;
}
bool junction(const QString &alias,const QString &target){
#ifdef Q_OS_WIN
    if(!QDir().mkdir(alias))return false;
    const auto handle=CreateFileW(reinterpret_cast<LPCWSTR>(alias.utf16()),GENERIC_WRITE,0,nullptr,OPEN_EXISTING,
        FILE_FLAG_OPEN_REPARSE_POINT|FILE_FLAG_BACKUP_SEMANTICS,nullptr);
    if(handle==INVALID_HANDLE_VALUE){QDir().rmdir(alias);return false;}
    struct Buffer{DWORD tag;WORD length,reserved,sub_offset,sub_length,print_offset,print_length;wchar_t names[2048];} data{};
    const auto print=QDir::toNativeSeparators(target),sub=QString("\\??\\")+print;need(sub.size()+print.size()+2<2048);
    data.tag=IO_REPARSE_TAG_MOUNT_POINT;data.sub_length=WORD(sub.size()*sizeof(wchar_t));
    data.print_offset=WORD(data.sub_length+sizeof(wchar_t));data.print_length=WORD(print.size()*sizeof(wchar_t));
    std::memcpy(data.names,sub.utf16(),data.sub_length);
    std::memcpy(reinterpret_cast<char*>(data.names)+data.print_offset,print.utf16(),data.print_length);
    data.length=WORD(8+data.print_offset+data.print_length+sizeof(wchar_t));DWORD returned=0;
    const auto ok=DeviceIoControl(handle,FSCTL_SET_REPARSE_POINT,&data,DWORD(data.length+8),nullptr,0,&returned,nullptr);
    CloseHandle(handle);if(!ok)QDir().rmdir(alias);return ok!=0;
#else
    (void)alias;(void)target;return false;
#endif
}
void links_and_sidecars(){
    {
        Fixture f;const auto e=f.expected();const auto alias=f.temp.filePath("hardlink-alias");
        if(hardlink(alias,f.project)){
            const auto before=tree(f.temp.path());refused([&]{f.read(e);},Code::OwnerUnavailable);
            check(tree(f.temp.path())==before,"Hardlink refusal changed files.");
        }else{++skips;std::cout<<"SKIP: local project hardlink creation unavailable/denied.\n";}
    }
    {
        Fixture f;const auto e=f.expected();const auto retained=f.project+"-retained";
        need(move_local(f.temp.path(),f.project,retained));
        if(file_symlink(f.project,retained)){
            const auto before=tree(f.temp.path());refused([&]{f.read(e);},Code::OwnerUnavailable);
            check(tree(f.temp.path())==before,"File symlink refusal changed files.");
        }else{++skips;std::cout<<"SKIP: local project file symlink creation unavailable/denied.\n";}
    }
    {
        Fixture f;const auto e=f.expected();const auto retained=f.store+"-retained";
        need(move_local(f.temp.path(),f.store,retained));
        if(junction(f.store,retained)){
            const auto before=tree(f.temp.path());refused([&]{f.read(e);},Code::OwnerUnavailable);
            check(tree(f.temp.path())==before,"Junction ancestor was followed or modified.");
            need(QDir().rmdir(f.store));
        }else{++skips;std::cout<<"SKIP: local original-store ancestor junction creation unavailable/denied.\n";}
    }
    for(const auto &suffix:{QString("-journal"),QString("-wal"),QString("-shm")}){
        Fixture f;const auto e=f.expected();
        put(f.project+suffix,suffix=="-journal"?QByteArrayLiteral("Nonempty journal"):QByteArray(128,'x'));
        const auto before=tree(f.temp.path());refused([&]{f.read(e);},Code::OwnerUnavailable);
        check(tree(f.temp.path())==before,"Unsafe sidecar read repaired or changed the fixture.");
    }
    {
        Fixture f;const auto e=f.expected();put(f.project+"-journal",{});
        if(hardlink(f.temp.filePath("journal-alias"),f.project+"-journal")){
            const auto before=tree(f.temp.path());refused([&]{f.read(e);},Code::OwnerUnavailable);
            check(tree(f.temp.path())==before,"Redirected journal was read or modified.");
        }else{++skips;std::cout<<"SKIP: local sidecar hardlink creation unavailable/denied.\n";}
    }
    {
        Fixture f;const auto e=f.expected();const auto target=mkdir(f.temp.path(),"sidecar-directory");
        if(junction(f.profiles+"-shm",target)){
            const auto before=tree(f.temp.path());refused([&]{f.read(e);},Code::OwnerUnavailable);
            check(tree(f.temp.path())==before,"Sidecar junction was followed or changed.");
            need(QDir().rmdir(f.profiles+"-shm"));
        }else{++skips;std::cout<<"SKIP: local sidecar junction creation unavailable/denied.\n";}
    }
}
int leave_wal(const QString &root){
    ordinary_fixture_root(root);ordinary_fixture_root(QDir::tempPath());
    const QFileInfo root_info(root);
    need(local_key(root_info.canonicalFilePath()).startsWith(local_key(QFileInfo(QDir::tempPath()).canonicalFilePath())+"/")&&
        root_info.fileName().startsWith("lmti-original-binding-")&&
        root_info.fileName().size()==QString("lmti-original-binding-").size()+6);
    const auto marker=at(root,"original-read-fixture.marker");(void)physical(marker);
    need(bytes(marker)=="lmti.original.read.fixture.v1\n");
    const auto store=at(root,"stores");
    ordinary_fixture_root(store);
    std::vector<std::unique_ptr<Sql>> open;
    for(const auto &name:{QString("library"),QString("project"),QString("profiles")}){
        const auto path=at(store,name+".sqlite");(void)physical(path);
        open.push_back(std::make_unique<Sql>(path));auto &db=*open.back();
        db.exec("PRAGMA journal_mode=WAL");db.exec("PRAGMA wal_autocheckpoint=0");db.exec("BEGIN IMMEDIATE");
        if(name=="library")db.exec("UPDATE library_entries SET label='WAL catalog' WHERE id='factory-monitor'");
        else if(name=="project")db.exec("UPDATE project SET label='WAL original project'");
        else db.exec("UPDATE servers SET label='WAL original profile' WHERE project='factory-monitor'");
        db.exec("COMMIT");
    }
    // Deliberately leave committed WAL without a live test keeper. This is a
    // fixed-action child operating only the harness's exactly marked fixture.
    std::_Exit(0);
}
void make_wal(const Fixture &f){
    QProcess child;child.setProgram(QCoreApplication::applicationFilePath());child.setArguments({"--leave-wal",f.temp.path()});
    child.start();need(child.waitForStarted(5000)&&child.waitForFinished(15000));
    need(child.exitCode()==0&&child.exitStatus()==QProcess::NormalExit&&child.readAllStandardError().isEmpty());
    for(const auto &path:{f.library,f.project,f.profiles})
        need(QFileInfo(path+"-wal").size()>32&&QFileInfo(path+"-shm").size()>0);
}
void live_wal_and_no_checkpoint(){
    {
        Fixture f;const auto e=f.expected();make_wal(f);const auto before=tree(f.temp.path());int leases=0;
        {Hook hook([&](Phase phase,const QString&){
            if(phase!=Phase::AfterLeasesAcquired)return;++leases;
            for(const auto &base:{f.library,f.project,f.profiles})for(const auto &suffix:{QString("-wal"),QString("-shm")})
                check(!move_local(f.temp.path(),base+suffix,base+suffix+"-moved"),"Existing live sidecar namespace was not leased.");
         });
         const auto r=f.read(e);
         check(r.entry.label=="WAL catalog"&&r.document.project.label=="WAL original project"&&
             r.profile.servers[0].label=="WAL original profile","Readonly native readers missed real committed WAL data.");}
        check(leases==1&&tree(f.temp.path())==before,"Readonly conditional read checkpointed main/WAL or changed SHM shape.");
    }
    {
        Fixture f;const auto e=f.expected();make_wal(f);
        need(move_local(f.temp.path(),f.profiles+"-shm",f.profiles+"-retained-shm"));const auto before=tree(f.temp.path());
        refused([&]{f.read(e);},Code::OwnerUnavailable);
        check(tree(f.temp.path())==before&&!QFileInfo::exists(f.profiles+"-shm"),"Missing profile SHM was created or repaired.");
    }
    {
        Fixture f;const auto e=f.expected();int added=0;
        {Hook hook([&](Phase phase,const QString&){
            if(phase==Phase::BeforeFinalVerification){put(f.project+"-journal","changed sidecar");++added;}
         });refused([&]{f.read(e);},Code::ConfigChanged);}
        check(added==1&&bytes(f.project+"-journal")=="changed sidecar","Appearing sidecar was silently ignored or altered.");
    }
}
QJsonObject physical_json(const lmti::OriginalPhysicalTarget &p){
    QJsonArray chain;for(const auto &id:p.chain)
        chain.append(QJsonObject{{"dev",id.dev},{"ino",id.ino},{"birthtimeNs",id.birthtime_ns}});
    return {{"version",1},{"path",p.path},{"kind","file"},
        {"state",p.state==State::Present?"present":"missing"},{"chain",chain}};
}
QJsonObject request(const Expected &e,bool missing=false){
    const QJsonObject library{{"schema",e.library.schema},{"canonicalPath",e.library.canonical_path},
        {"uuid",e.library.schema==1?QJsonValue(QJsonValue::Null):QJsonValue(e.library.uuid)},
        {"physical",physical_json(e.library.physical)}};
    const QJsonObject project{{"schema",e.project.schema},
        {"storeUuid",e.project.schema==1?QJsonValue(QJsonValue::Null):QJsonValue(e.project.store_uuid)},
        {"physical",physical_json(e.project.physical)}};
    return {{"action","read-original"},{"allowMissingProfile",missing},
        {"expected",QJsonObject{{"version",1},{"projectId",QString::fromStdString(e.project_id)},
            {"library",library},{"project",project},{"profiles",physical_json(e.profiles)},{"linkedRoot",e.linked_root}}}};
}
void replace_nested(QJsonObject &value,const QStringList &path,const QJsonValue &replacement){
    need(!path.empty());if(path.size()==1){value[path.front()]=replacement;return;}
    auto nested=value.value(path.front()).toObject();replace_nested(nested,path.mid(1),replacement);value[path.front()]=nested;
}
struct Frame{QByteArray bytes;QJsonObject value;};
Frame invoke(const QString &binary,const QStringList &arguments,const QByteArray &input){
    QProcess child;child.setProgram(binary);child.setArguments(arguments);child.start();
    need(child.waitForStarted(5000),"Read-only facade did not start.");
    need(child.write(input)==input.size(),"Read-only facade input could not be queued.");child.closeWriteChannel();
    if(!child.waitForFinished(15000)){child.kill();child.waitForFinished(5000);throw lmti::Error("Read-only facade deadline expired.");}
    need(child.exitStatus()==QProcess::NormalExit&&child.exitCode()==0&&child.readAllStandardError().isEmpty(),
        "Facade failed without a bounded private response.");
    const auto out=child.readAllStandardOutput();
    check(!out.isEmpty()&&out.endsWith('\n')&&out.size()<=128*1024,"Facade response lacked complete bounded LF framing.");
    return {out,lmti::detail::strict_json_object(out,128*1024)};
}
QStringList args(const Fixture &f){return {"--original-binding-read","--library",f.library,"--profiles",f.profiles};}
Frame invoke(const QString &binary,const Fixture &f,const QJsonObject &payload){
    return invoke(binary,args(f),QJsonDocument(payload).toJson(QJsonDocument::Compact));
}
void error(const Frame &frame,const QString &code){
    check(frame.value==QJsonObject{{"ok",false},{"code",code}},"Private refusal leaked payload or used the wrong fixed code.");
}
void exact_fields(const QJsonObject &value,const QSet<QString> &wanted){
    QSet<QString> actual;for(auto it=value.begin();it!=value.end();++it)actual.insert(it.key());
    check(actual==wanted,"Wire contract omitted a field or disclosed an unapproved extra field.");
}
void successful_wire(const QString &binary){
    for(const int schema:{1,3}){
        Fixture f(schema,schema==1?1:2,true,true);const auto e=f.expected();const auto before=tree(f.temp.path());
        const auto reply=invoke(binary,f,request(e));const auto &v=reply.value;
        exact_fields(v,{"ok","schema","action","binding","profile"});
        check(v.value("ok")==true&&v.value("schema")=="lmti.mcp.original-read.v1"&&v.value("action")=="read-original",
            "Conditional-read success envelope disagrees with the protocol.");
        const auto binding=v.value("binding").toObject(),profile=v.value("profile").toObject();
        exact_fields(binding,{"id","name","database","root","projectRevision","libraryIdentity","projectIdentity"});
        exact_fields(profile,{"projectId","revision","servers"});
        exact_fields(binding.value("libraryIdentity").toObject(),{"schema","canonicalPath","uuid","generation","digest"});
        exact_fields(binding.value("projectIdentity").toObject(),{"schema","storeUuid","revision"});
        check(binding.value("database")==f.project&&binding.value("root")==f.root&&
            profile.value("revision")==1&&profile.value("servers").toArray().size()==1,"Wire data did not correspond to original targets.");
        check(schema==1?binding.value("projectIdentity").toObject().value("storeUuid").isNull():
            binding.value("projectIdentity").toObject().value("storeUuid")==e.project.store_uuid,
            "Wire null/UUID project lineage semantics changed.");
        check(tree(f.temp.path())==before,"Real facade process changed native fixture files.");
        // Ordinary old mode still returns its old envelope. No new runtime
        // helper/Python execution is needed for this native read regression.
        const auto runtime=at(f.temp.path(),"inert-runtime");put(runtime,"Synthetic inert runtime.\n");
        const auto legacy=invoke(binary,{"--library",f.library,"--profiles",f.profiles,
            "--python",runtime,"--entry",runtime,"--binary",runtime},
            QByteArray("{\"action\":\"read\",\"projectId\":\"factory-monitor\"}"));
        exact_fields(legacy.value,{"ok","binding","profile"});
        check(legacy.value.value("ok")==true&&legacy.value.value("binding")==binding&&
            legacy.value.value("profile")==profile,"New conditional mode changed old read behavior.");
    }
    Fixture f;const auto e=f.expected();auto profile=lmti::load_mcp_profile(f.profiles,"factory-monitor");
    profile.servers.clear();
    for(int n=0;n<32;++n){
        const auto id=QString("remote-%1").arg(n).toStdString();
        const auto endpoint=QString("https://example.com/")+QString(480,'a')+QString::number(n);
        profile.servers.push_back({id,std::string(120,'x'),endpoint.toStdString(),"",
            lmti::McpTransport::RemoteHttps,lmti::McpAuth::ClientOAuth,true,false});
    }
    need(lmti::save_mcp_profile(f.profiles,profile)==2);
    const auto frame=invoke(binary,f,request(e));
    check(frame.value.value("ok")==true&&frame.value.value("profile").toObject().value("servers").toArray().size()==32&&
        frame.bytes.size()<128*1024,"Bounded maximum-server profile was truncated or exceeded response cap.");
    Fixture absent(3,2,false);const auto absent_pin=absent.expected();const auto before=tree(absent.temp.path());
    error(invoke(binary,absent,request(absent_pin)),"RECOVERY_REQUIRED");
    const auto allowed=invoke(binary,absent,request(absent_pin,true));
    check(allowed.value.value("ok")==true&&allowed.value.value("profile").toObject()==
        QJsonObject{{"projectId","factory-monitor"},{"revision",0},{"servers",QJsonArray{}}}&&
        tree(absent.temp.path())==before,"Wire missing-profile policy created or opened an unpinned store.");
}
void strict_process_input(const QString &binary){
    Fixture f;const auto e=f.expected();const auto good=request(e);const auto compact=QJsonDocument(good).toJson(QJsonDocument::Compact);
    const auto before=tree(f.temp.path());
    const auto encoded_root_array=QJsonDocument(QJsonArray{e.linked_root}).toJson(QJsonDocument::Compact);
    const auto encoded_root=encoded_root_array.mid(1,encoded_root_array.size()-2);
    const auto root_field=QByteArrayLiteral("\"linkedRoot\":")+encoded_root;
    need(compact.contains(root_field));
    // Preserve all keys and an otherwise absolute local path. A project ID
    // would independently reject Unicode and conceal this scalar-text check.
    auto lone_surrogate=compact;
    lone_surrogate.replace(root_field,QByteArrayLiteral("\"linkedRoot\":")+
        encoded_root.left(encoded_root.size()-1)+QByteArrayLiteral("\\ud800\""));
    const std::vector<QByteArray> invalid{
        {},QByteArray("[]"),QByteArray("null"),QByteArray("{}"),compact+QByteArray(1,'\0')+"garbage",
        compact+QByteArray(1,'\x1a')+"garbage",compact+QByteArray::fromHex("ff"),
        QByteArray("{\"action\":\"read-original\",")+compact.mid(1),
        QByteArray(compact).replace("\"projectId\":\"factory-monitor\"","\"projectId\":\"factory-monitor\",\"projectId\":\"factory-monitor\""),
        lone_surrogate,
        compact+"{}"
    };
    for(const auto &bad:invalid)error(invoke(binary,args(f),bad),"INVALID_INPUT");
    error(invoke(binary,args(f),QByteArray(64*1024+1,' ')),"LIMIT_EXCEEDED");
    // A valid exact-limit input is accepted after EOF, exercising the binary
    // pipe reader's bounded completion rather than a regular-file stdin.
    auto padded=compact;padded.append(QByteArray(64*1024-padded.size(),' '));
    check(invoke(binary,args(f),padded).value.value("ok")==true,"Exact 64KiB valid pipe input was refused.");
    std::vector<QJsonObject> malformed;
    auto add=[&](const QStringList &path,const QJsonValue &value){auto q=good;replace_nested(q,path,value);malformed.push_back(q);};
    add({"action"},"save");add({"allowMissingProfile"},1);add({"extra"},true);add({"expected","version"},2);
    add({"expected","projectId"},"../other");add({"expected","project","storeUuid"},QJsonValue::Null);
    add({"expected","library","uuid"},"00000000-0000-0000-0000-000000000000");
    add({"expected","profiles","kind"},"directory");add({"expected","profiles","state"},QJsonArray{"present"});
    add({"expected","profiles","chain"},QJsonObject{});
    auto chain=physical_json(e.profiles).value("chain").toArray();
    for(const auto &field:{QString("dev"),QString("ino"),QString("birthtimeNs")}){
        auto changed=chain;auto row=changed.last().toObject();row[field]=123;changed[changed.size()-1]=row;
        add({"expected","profiles","chain"},changed);
        row[field]="01";changed[changed.size()-1]=row;add({"expected","profiles","chain"},changed);
    }
    {auto changed=chain;auto row=changed.last().toObject();row["unexpected"]=true;changed[changed.size()-1]=row;
     add({"expected","profiles","chain"},changed);}
    for(const auto &q:malformed)error(invoke(binary,f,q),"INVALID_INPUT");
    auto over=good;QJsonArray many;for(int n=0;n<65;++n)many.append(chain.first());
    replace_nested(over,{"expected","profiles","chain"},many);error(invoke(binary,f,over),"LIMIT_EXCEEDED");
    auto null_identity=good;auto unavailable=chain;unavailable[0]=QJsonValue::Null;
    replace_nested(null_identity,{"expected","profiles","chain"},unavailable);error(invoke(binary,f,null_identity),"RECOVERY_REQUIRED");
    for(const auto &badpath:QStringList{"\\\\server\\share\\project.sqlite","\\\\?\\C:\\project.sqlite",
        f.project+":stream",f.project+"/../project.sqlite",at(f.store,"NUL"),at(f.store,"bad."),at(f.store,"bad?")}){
        auto q=good;replace_nested(q,{"expected","project","physical","path"},badpath);
        error(invoke(binary,f,q),"INVALID_INPUT");
    }
    auto wrong=args(f);wrong.removeLast();error(invoke(binary,wrong,compact),"INVALID_INPUT");
    wrong=args(f);wrong.append("--extra");error(invoke(binary,wrong,compact),"INVALID_INPUT");
    wrong=args(f);wrong[1]="--profiles";error(invoke(binary,wrong,compact),"INVALID_INPUT");
    wrong=args(f);wrong[2]=at(f.temp.path(),"different-library.sqlite");error(invoke(binary,wrong,compact),"SCOPE_DENIED");
    check(tree(f.temp.path())==before,"Malformed process request probed by creating/changing storage artifacts.");
}
void pure_typed_validation(){
    Fixture f(3,2,true,true);const auto source=f.expected();const auto before=tree(f.temp.path());int phases=0;
    Hook hook([&](Phase,const QString&){++phases;});
    for(const auto &value:QStringList{"-1","01","18446744073709551616","not-an-integer"}){
        auto e=source;e.project.physical.chain.back().ino=value;
        refused([&]{f.read(e);},Code::InvalidInput);
    }
    {auto e=source;e.library.physical.chain.front().dev="4294967296";refused([&]{f.read(e);},Code::InvalidInput);}
    {auto e=source;e.project.physical.chain.back().birthtime_ns="1792482362793881701";refused([&]{f.read(e);},Code::InvalidInput);}
    {auto e=source;e.project.physical.chain.back().birthtime_ns=QString(40,'9');refused([&]{f.read(e);},Code::InvalidInput);}
    {auto e=source;e.library.physical.chain.clear();refused([&]{f.read(e);},Code::InvalidInput);}
    {auto e=source;e.library.physical.chain.resize(65,e.library.physical.chain.front());refused([&]{f.read(e);},Code::LimitExceeded);}
    {auto e=source;e.library.physical.path=e.library.physical.path.toCaseFolded();
     need(e.library.physical.path!=source.library.physical.path);
     refused([&]{f.read(e);},Code::ScopeDenied);}
    check(phases==0&&tree(f.temp.path())==before,"Invalid typed provenance reached read phases or changed files.");
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
        const auto arguments=app.arguments();
        if(arguments.size()==3&&arguments[1]=="--leave-wal")return leave_wal(arguments[2]);
        need(arguments.size()==2,"Provide current native admin binary.");
#ifdef Q_OS_WIN
        run("library/project schema matrix and Unicode",schema_matrix);
        run("fresh mutable revisions and existing empty profile row",current_revisions_and_empty_row);
        run("immutable original identity before graph/profile content",immutable_identity_before_content);
        run("in-place catalog CAS never redirects original project read",concurrent_locator_never_redirects);
        run("namespace leases and release on success/exception",leases_and_release);
        run("same-path byte-identical physical replacement",replacement_before_open);
        run("missing-profile policy never opens appeared store",absent_profile_is_never_opened);
        run("legitimate same-store concurrent profile update",profile_updates_same_target);
        run("hardlink/reparse and bounded sidecar refusals",links_and_sidecars);
        run("real committed WAL and no checkpoint/repair",live_wal_and_no_checkpoint);
        run("pure typed identity validation before I/O",pure_typed_validation);
        run("actual shipped success framing and legacy compatibility",[&]{successful_wire(arguments[1]);});
        run("actual binary pipe strict input framing",[&]{strict_process_input(arguments[1]);});
#else
        ++skips;std::cout<<"SKIP: Windows-only original binding namespace guarantee unavailable on this platform.\n";
#endif
    }catch(const std::exception &e){++failures;std::cerr<<"FAIL: suite setup ["<<e.what()<<"]\n";}
    std::cout<<"original binding read: "<<cases<<" cases, "<<checks<<" checks, "<<failures<<" failures, "<<skips<<" skips\n";
    return failures?1:0;
}
