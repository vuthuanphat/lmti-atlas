#include "lmti/project_copy.hpp"
#include "lmti/project_store.hpp"
#include "../common/local_owner_path.hpp"
#include <QCoreApplication>
#include <QDir>
#include <QFile>
#include <QFileInfo>
#include <QJsonDocument>
#include <QJsonObject>
#include <QMap>
#include <QTemporaryDir>
#include <QUuid>
#include <algorithm>
#include <cstring>
#include <functional>
#include <iostream>
#ifdef Q_OS_WIN
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#include <winioctl.h>
#else
#include <unistd.h>
#endif

namespace {
int failures = 0, skips = 0;
void check(bool value,const char *message) {
    if (!value) { ++failures; std::cerr << message << '\n'; }
}
void require(bool value) { if (!value) throw lmti::Error("Discovery fixture setup failed."); }
QString path(const QString &parent,const QString &name) { return QDir(parent).filePath(name); }
QString fresh_id() { return QUuid::createUuid().toString(QUuid::WithoutBraces); }
QString canonical_key(const QString &value) {
    auto result = QDir::cleanPath(value);
#ifdef Q_OS_WIN
    result = result.toCaseFolded();
#endif
    return result;
}
QByteArray bytes(const QString &value) {
    QFile file(value); require(file.open(QIODevice::ReadOnly)); return file.readAll();
}
void put(const QString &value,const QByteArray &data) {
    QFile file(value); require(file.open(QIODevice::WriteOnly|QIODevice::Truncate));
    require(file.write(data)==data.size()); file.close();
}
QString directory(const QString &parent,const QString &name) {
    require(QDir(parent).mkdir(name)); return path(parent,name);
}
using Tree = QMap<QString,QByteArray>;
void record_tree(const QString &root,const QString &relative,Tree &result) {
    const auto current = relative.isEmpty() ? root : path(root,relative);
    for (const auto &entry : QDir(current).entryInfoList(
             QDir::AllEntries|QDir::NoDotAndDotDot|QDir::Hidden|QDir::System,QDir::Name)) {
        const auto name = relative.isEmpty() ? entry.fileName() : relative+'/'+entry.fileName();
        if (entry.isSymLink() || entry.isJunction())
            result.insert(name,"link:"+entry.symLinkTarget().toUtf8()); // Never follow a fixture link.
        else if (entry.isDir()) {
            result.insert(name,"directory"); record_tree(root,name,result);
        } else result.insert(name,"file:"+bytes(entry.filePath()));
    }
}
Tree snapshot(const QString &root) { Tree result; record_tree(root,{},result); return result; }
lmti::ProjectCopyDiscovery read_only(const QString &root,const QString &parent) {
    const auto before = snapshot(root);
    const auto result = lmti::discover_project_copies(parent);
    check(snapshot(root)==before,"discovery changed fixture bytes or entries");
    return result;
}
const lmti::ProjectCopyCandidate &candidate(const lmti::ProjectCopyDiscovery &result,const QString &id) {
    const auto found = std::find_if(result.candidates.begin(),result.candidates.end(),
                                   [&](const auto &row){return row.operation_id==id;});
    require(found!=result.candidates.end()); return *found;
}
void valid_metadata(const lmti::ProjectCopyCandidate &row,const lmti::ProjectCopyStatus &prepared) {
    check(row.state==lmti::ProjectCopyCandidateState::Uninspected && row.intent.has_value(),
          "valid intent was not explicitly uninspected");
    if (!row.intent) return;
    check(row.intent->mode==prepared.mode && row.intent->seeds_internal_sites==prepared.seeds_internal_sites &&
          row.intent->source==prepared.source && row.intent->target==prepared.target,
          "discovery changed recorded intent metadata");
}
struct Fixture {
    QTemporaryDir temp;
    QString source,parent;
    lmti::ProjectCopyStatus prepared;
    explicit Fixture(bool structured=false) {
        require(temp.isValid()); source=temp.filePath("source.sqlite"); parent=directory(temp.path(),"copies");
        lmti::ProjectDocument document;
        document.project={"discovery-project","Controlled discovery","Local copy recovery",lmti::Privacy::Internal};
        if (structured) document.structure.emplace();
        document.topology.revision=lmti::save_project(source,document);
        const auto mode=structured?lmti::ProjectCopyMode::CloneV2:lmti::ProjectCopyMode::MigrateV1;
        prepared=lmti::prepare_project_copy(source,parent,lmti::inspect_project_copy(source,mode));
        require(prepared.state==lmti::ProjectCopyState::Prepared && prepared.verified_receipt);
    }
    QString operation() const { return path(parent,prepared.operation_id); }
    QString file(const QString &name) const { return path(operation(),name); }
    QJsonObject intent() const { return QJsonDocument::fromJson(bytes(file("intent.json"))).object(); }
};
QJsonObject relocated_intent(const QJsonObject &original,const QString &parent,const QString &id) {
    auto result=original; result["operationId"]=id;
    auto target=result["target"].toObject();
    target["canonicalPath"]=canonical_key(path(path(parent,id),"project.sqlite"));
    result["target"]=target; return result;
}
void lost_uuid_and_ambiguous_equivalent_copies() {
    Fixture f;
    const auto source_before=bytes(f.source);
    const auto second=lmti::prepare_project_copy(f.source,f.parent,lmti::inspect_project_copy(f.source,lmti::ProjectCopyMode::MigrateV1));
    require(second.state==lmti::ProjectCopyState::Prepared);
    // Discovery is given only the trusted parent: neither remembered UUID nor
    // a proposed source identity selects a winner.
    const auto result=read_only(f.temp.path(),f.parent);
    check(result.complete && result.code==lmti::ProjectCopyCode::None &&
          result.examined_entries==2 && result.unattributed_entries==0 && result.candidates.size()==2,
          "equivalent copy discovery omitted or selected one operation");
    valid_metadata(candidate(result,f.prepared.operation_id),f.prepared);
    valid_metadata(candidate(result,second.operation_id),second);
    check(f.prepared.target.content_digest==second.target.content_digest &&
          f.prepared.target.store_uuid!=second.target.store_uuid,"equivalent-copy fixture is not distinct");
    const auto before=snapshot(f.temp.path());
    for (const auto &row:result.candidates) {
        const auto inspected=lmti::inspect_project_copy_operation(f.parent,row.operation_id);
        check(inspected.state==lmti::ProjectCopyState::Prepared && inspected.code==lmti::ProjectCopyCode::None,
              "independent inspection did not recover a discovered real copy");
    }
    check(snapshot(f.temp.path())==before && bytes(f.source)==source_before,
          "independent discovered-copy inspection wrote state");
}
void intent_failures_are_not_copy_proofs() {
    Fixture f;
    const auto malformed_parent=directory(f.temp.path(),"intent-cases");
    struct Row { QString id; lmti::ProjectCopyCandidateState state; };
    std::vector<Row> rows;
    const auto add=[&](const char *kind,lmti::ProjectCopyCandidateState state) {
        const auto id=fresh_id(),child=directory(malformed_parent,id);
        auto object=relocated_intent(f.intent(),malformed_parent,id);
        auto value=QJsonDocument(object).toJson(QJsonDocument::Compact);
        const auto name=QString::fromLatin1(kind);
        if(name=="missing") put(path(child,"project.sqlite"),"not opened by discovery");
        else {
            if(name=="empty") value.clear();
            else if(name=="malformed") value="{";
            else if(name=="duplicate") value="{\"operationId\":\""+id.toUtf8()+"\","+value.mid(1);
            else if(name=="nested-duplicate") value.replace("\"projectId\":","\"projectId\":\"other-project\",\"projectId\":");
            else if(name=="oversize") value=QByteArray(8193,' ');
            else if(name=="wrong-operation") { object["operationId"]=fresh_id(); value=QJsonDocument(object).toJson(QJsonDocument::Compact); }
            else if(name=="wrong-target") {
                auto target=object["target"].toObject(); target["canonicalPath"]=f.source;
                object["target"]=target; value=QJsonDocument(object).toJson(QJsonDocument::Compact);
            }
            put(path(child,"intent.json"),value);
        }
        rows.push_back({id,state});
    };
    add("missing",lmti::ProjectCopyCandidateState::Incomplete);
    add("empty",lmti::ProjectCopyCandidateState::Incomplete);
    for(const auto *kind:{"malformed","duplicate","nested-duplicate","oversize","wrong-operation","wrong-target"})
        add(kind,lmti::ProjectCopyCandidateState::Invalid);
    const auto empty=fresh_id(); directory(malformed_parent,empty);
    rows.push_back({empty,lmti::ProjectCopyCandidateState::Incomplete});
    const auto ordinary=fresh_id(); put(path(malformed_parent,ordinary),"ordinary file, not a reservation");
    rows.push_back({ordinary,lmti::ProjectCopyCandidateState::Invalid});
    const auto result=read_only(f.temp.path(),malformed_parent);
    check(result.complete && result.code==lmti::ProjectCopyCode::None && result.examined_entries==rows.size() &&
          result.unattributed_entries==rows.size() && result.candidates.size()==rows.size(),
          "stable malformed entries changed enumeration completeness or attribution");
    for(const auto &wanted:rows) {
        const auto &row=candidate(result,wanted.id);
        check(row.state==wanted.state && !row.intent,"invalid/incomplete intent gained source attribution");
    }
}
void metadata_is_private_unverified_not_authority() {
    Fixture f(true);
    auto intent=f.intent();
    for(const auto *key:{"source","target"}) {
        auto token=intent[key].toObject(); token["projectId"]="foreign-project"; intent[key]=token;
    }
    auto source=intent["source"].toObject();
    source["canonicalPath"]=canonical_key(f.temp.filePath("absent-foreign-source.sqlite")); intent["source"]=source;
    put(f.file("intent.json"),QJsonDocument(intent).toJson(QJsonDocument::Compact));
    const auto result=read_only(f.temp.path(),f.parent);
    const auto &row=candidate(result,f.prepared.operation_id);
    check(result.complete && row.state==lmti::ProjectCopyCandidateState::Uninspected && row.intent &&
          row.intent->source.project_id=="foreign-project" && row.intent->target.project_id=="foreign-project",
          "foreign intent metadata was treated as selected project authority or verified proof");
    const auto before=snapshot(f.temp.path());
    const auto inspected=lmti::inspect_project_copy_operation(f.parent,row.operation_id);
    check(inspected.state!=lmti::ProjectCopyState::Prepared && inspected.code!=lmti::ProjectCopyCode::None,
          "altered unsigned discovery metadata certified a real target");
    check(snapshot(f.temp.path())==before,"refused independent inspection changed evidence");
}
void missing_and_changed_databases_do_not_change_discovery() {
    Fixture f(true);
    require(QFile::rename(f.source,f.temp.filePath("retained-source.sqlite")));
    require(QFile::rename(f.file("project.sqlite"),f.temp.filePath("retained-target.sqlite")));
    require(QFile::rename(f.file("verified.json"),f.temp.filePath("retained-verified.json")));
    auto result=read_only(f.temp.path(),f.parent);
    valid_metadata(candidate(result,f.prepared.operation_id),f.prepared);
    check(result.complete,"missing source/target/final receipt prevented metadata-only discovery");
    put(f.source,"changed source bytes"); put(f.file("project.sqlite"),"changed target bytes");
    put(f.file("verified.json"),"{malformed final receipt");
    result=read_only(f.temp.path(),f.parent);
    valid_metadata(candidate(result,f.prepared.operation_id),f.prepared);
    check(result.complete,"changed source/target/final receipt was opened by discovery");
}
void immediate_children_only_and_budget() {
    QTemporaryDir temp; require(temp.isValid());
    const auto nested=directory(temp.path(),"nested");
    const auto unrelated=directory(nested,"unrelated-folder");
    directory(unrelated,fresh_id());
    auto result=read_only(temp.path(),nested);
    check(result.complete && result.examined_entries==1 && result.unattributed_entries==1 && result.candidates.empty(),
          "discovery recursed into an unrelated child");
    const auto nonrecursive=directory(temp.path(),"one-reservation");
    const auto outer=fresh_id(),outer_path=directory(nonrecursive,outer);
    directory(outer_path,fresh_id());
    result=read_only(temp.path(),nonrecursive);
    check(result.complete && result.examined_entries==1 && result.candidates.size()==1 &&
          candidate(result,outer).state==lmti::ProjectCopyCandidateState::Incomplete,
          "discovery recursed below a UUID reservation");
    const auto invalid=directory(temp.path(),"invalid-names");
    for(std::size_t i=0;i<lmti::max_project_copy_discovery_entries;++i)
        put(path(invalid,QString(".invalid-%1").arg(i)),"");
    result=read_only(temp.path(),invalid);
    check(result.complete && result.code==lmti::ProjectCopyCode::None &&
          result.examined_entries==lmti::max_project_copy_discovery_entries &&
          result.unattributed_entries==lmti::max_project_copy_discovery_entries && result.candidates.empty(),
          "invalid or hidden names escaped the exact discovery budget");
    put(path(invalid,"invalid-overflow"),"");
    result=read_only(temp.path(),invalid);
    check(!result.complete && result.code==lmti::ProjectCopyCode::BudgetExceeded &&
          result.examined_entries==lmti::max_project_copy_discovery_entries+1 &&
          result.unattributed_entries==lmti::max_project_copy_discovery_entries && result.candidates.empty(),
          "overflow was silently represented as a complete empty discovery");
    const auto candidates=directory(temp.path(),"candidate-limit");
    for(std::size_t i=0;i<=lmti::max_project_copy_discovery_entries;++i) directory(candidates,fresh_id());
    result=read_only(temp.path(),candidates);
    check(!result.complete && result.code==lmti::ProjectCopyCode::BudgetExceeded &&
          result.examined_entries==lmti::max_project_copy_discovery_entries+1 &&
          result.candidates.size()==lmti::max_project_copy_discovery_entries,
          "UUID candidates were not bounded independently of enumeration");
}
#ifdef Q_OS_WIN
class DenyRead final {
    HANDLE handle=INVALID_HANDLE_VALUE;
  public:
    explicit DenyRead(const QString &file) {
        handle=CreateFileW(reinterpret_cast<LPCWSTR>(file.utf16()),GENERIC_READ,0,nullptr,OPEN_EXISTING,FILE_ATTRIBUTE_NORMAL,nullptr);
        require(handle!=INVALID_HANDLE_VALUE);
    }
    ~DenyRead() { if(handle!=INVALID_HANDLE_VALUE) CloseHandle(handle); }
    DenyRead(const DenyRead &)=delete;
    DenyRead &operator=(const DenyRead &)=delete;
};
#endif
void exclusive_file_access_evidence() {
#ifdef Q_OS_WIN
    Fixture f;
    auto before=snapshot(f.temp.path());
    {
        DenyRead source(f.source),target(f.file("project.sqlite")),verified(f.file("verified.json"));
        const auto result=lmti::discover_project_copies(f.parent);
        check(result.complete && result.code==lmti::ProjectCopyCode::None,
              "discovery attempted to open an exclusively held source/target/final receipt");
        valid_metadata(candidate(result,f.prepared.operation_id),f.prepared);
    }
    check(snapshot(f.temp.path())==before,"metadata discovery changed exclusively held files");
    {
        DenyRead intent(f.file("intent.json"));
        const auto result=lmti::discover_project_copies(f.parent);
        const auto &row=candidate(result,f.prepared.operation_id);
        check(!result.complete && result.code==lmti::ProjectCopyCode::OwnerUnavailable &&
              row.state==lmti::ProjectCopyCandidateState::Unavailable && !row.intent && result.unattributed_entries==1,
              "unreadable intent was silently treated as a complete/missing candidate");
    }
    check(snapshot(f.temp.path())==before,"unavailable intent handling wrote fixture bytes");
#else
    ++skips; std::cout<<"SKIP: Windows mandatory file-sharing proof is unavailable on this platform.\n";
#endif
}
bool make_symlink(const QString &link,const QString &target,bool folder) {
#ifdef Q_OS_WIN
    const auto flags=DWORD(folder?1:0);
    if(CreateSymbolicLinkW(reinterpret_cast<LPCWSTR>(link.utf16()),reinterpret_cast<LPCWSTR>(target.utf16()),flags|2)) return true;
    if(GetLastError()==ERROR_INVALID_PARAMETER)
        return CreateSymbolicLinkW(reinterpret_cast<LPCWSTR>(link.utf16()),reinterpret_cast<LPCWSTR>(target.utf16()),flags)!=0;
    return false;
#else
    (void)folder; return ::symlink(QFile::encodeName(target).constData(),QFile::encodeName(link).constData())==0;
#endif
}
bool make_junction(const QString &link,const QString &target) {
#ifdef Q_OS_WIN
    // Fixed local temporary paths only; never invoke a shell or follow a
    // receipt-selected target. A denied reparse privilege is an explicit skip.
    if(!QDir().mkdir(link)) return false;
    const auto handle=CreateFileW(reinterpret_cast<LPCWSTR>(link.utf16()),GENERIC_WRITE,0,nullptr,OPEN_EXISTING,
                                  FILE_FLAG_OPEN_REPARSE_POINT|FILE_FLAG_BACKUP_SEMANTICS,nullptr);
    if(handle==INVALID_HANDLE_VALUE) { QDir().rmdir(link); return false; }
    struct Buffer { DWORD tag; WORD length,reserved,sub_offset,sub_length,print_offset,print_length; wchar_t names[2048]; } data{};
    const auto print=QDir::toNativeSeparators(target),sub=QString("\\??\\")+print;
    require(sub.size()+print.size()+2<2048);
    data.tag=IO_REPARSE_TAG_MOUNT_POINT;
    data.sub_length=WORD(sub.size()*sizeof(wchar_t)); data.print_offset=WORD(data.sub_length+sizeof(wchar_t));
    data.print_length=WORD(print.size()*sizeof(wchar_t));
    std::memcpy(data.names,sub.utf16(),data.sub_length);
    std::memcpy(reinterpret_cast<char *>(data.names)+data.print_offset,print.utf16(),data.print_length);
    data.length=WORD(8+data.print_offset+data.print_length+sizeof(wchar_t)); DWORD returned=0;
    const auto ok=DeviceIoControl(handle,FSCTL_SET_REPARSE_POINT,&data,DWORD(data.length+8),nullptr,0,&returned,nullptr);
    CloseHandle(handle); if(!ok) QDir().rmdir(link); return ok!=0;
#else
    (void)link; (void)target; return false;
#endif
}
void local_links_are_not_followed() {
    Fixture f;
    for(const bool junction:{false,true}) {
        const auto holder=directory(f.temp.path(),junction?"junction-case":"symlink-case");
        const auto id=fresh_id(),link=path(holder,id);
        const auto made=junction?make_junction(link,f.operation()):make_symlink(link,f.operation(),true);
        if(!made) {
            ++skips; std::cout<<"SKIP: local "<<(junction?"junction":"directory symlink")<<" creation unavailable/denied.\n"; continue;
        }
        const auto result=read_only(f.temp.path(),holder);
        const auto &row=candidate(result,id);
        check(!result.complete && result.code==lmti::ProjectCopyCode::OwnerUnavailable &&
              row.state==lmti::ProjectCopyCandidateState::Unavailable && !row.intent,
              "linked UUID child was traversed or hidden from incomplete status");
        const auto parent_result=read_only(f.temp.path(),link);
        check(!parent_result.complete && parent_result.code!=lmti::ProjectCopyCode::None && parent_result.candidates.empty(),
              "linked trusted parent was followed");
    }
    for(const bool junction:{false,true}) {
        const auto holder=directory(f.temp.path(),junction?"intent-junction-case":"intent-symlink-case");
        const auto id=fresh_id(),child=directory(holder,id),link=path(child,"intent.json");
        const auto made=junction?make_junction(link,f.operation()):make_symlink(link,f.file("intent.json"),false);
        if(made) {
            const auto result=read_only(f.temp.path(),holder);
            check(!result.complete && candidate(result,id).state==lmti::ProjectCopyCandidateState::Unavailable &&
                  !candidate(result,id).intent,"reparse intent was followed or mislabeled as stable missing/invalid intent");
        } else { ++skips; std::cout<<"SKIP: local intent "<<(junction?"junction":"symlink")<<" creation unavailable/denied.\n"; }
    }
}
void parent_and_raw_path_refusals() {
    QTemporaryDir temp; require(temp.isValid());
    const auto parent=directory(temp.path(),"parent");
    auto result=read_only(temp.path(),parent);
    check(result.complete && result.code==lmti::ProjectCopyCode::None && result.candidates.empty(),
          "ordinary empty parent is not a complete discovery");
    result=read_only(temp.path(),temp.filePath("missing"));
    check(!result.complete && result.code==lmti::ProjectCopyCode::OwnerUnavailable && result.candidates.empty(),
          "missing parent was silently created or claimed complete");
    // UNC cases exercise the pure lexical guard only: no network request can
    // occur even if a future public boundary regression were introduced.
    const QStringList lexical{"\\\\host\\share","//host/share","\\\\?\\UNC\\host\\share",
                              parent+":stream",parent+"/../parent",parent+QChar(1)};
    for(const auto &bad:lexical) {
        bool rejected=false;
        try { (void)lmti::detail::local_owner_path_lexical(bad); }
        catch(const lmti::Error &) { rejected=true; }
        check(rejected,"unsafe raw path passed pure pre-I/O validation");
    }
    const QStringList local_invalid{QString("\\\\?\\")+QDir::toNativeSeparators(parent),
                                    parent+":stream",parent+QChar(1),"relative"};
    const auto before=snapshot(temp.path());
    for(const auto &bad:local_invalid) {
        result=lmti::discover_project_copies(bad);
        check(!result.complete && result.code!=lmti::ProjectCopyCode::None && result.candidates.empty(),
              "unsafe local parent spelling was accepted");
    }
    check(snapshot(temp.path())==before,"unsafe path refusals wrote local fixture");
}
}
int main(int argc,char **argv) {
    QCoreApplication app(argc,argv);
    try {
        lost_uuid_and_ambiguous_equivalent_copies(); intent_failures_are_not_copy_proofs();
        metadata_is_private_unverified_not_authority(); missing_and_changed_databases_do_not_change_discovery();
        immediate_children_only_and_budget(); exclusive_file_access_evidence();
        local_links_are_not_followed(); parent_and_raw_path_refusals();
    } catch(const std::exception &error) {
        std::cerr<<"Unexpected discovery fixture failure: "<<error.what()<<'\n'; return 1;
    }
    std::cout<<"Copy discovery: "<<failures<<" failures, "<<skips
             <<" conditional skips; no automatic selection or copy verification claimed.\n";
    return failures?1:0;
}
