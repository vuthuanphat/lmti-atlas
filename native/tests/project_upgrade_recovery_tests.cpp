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
#include <cstdlib>
#include <cstring>
#include <functional>
#include <iostream>
#include <optional>
#ifdef Q_OS_WIN
#define NOMINMAX
#include <windows.h>
#include <winioctl.h>
#else
#include <unistd.h>
#endif

#ifndef LMTI_LIBRARY_CORE_TEST_HOOKS
#error This suite requires isolated library owner fault hooks, never shipped storage.
#endif

namespace {
int checks=0,failures=0,skips=0,cases=0;
void check(bool value,const char *message) {
    ++checks; if(!value) { ++failures; std::cerr<<"FAIL: "<<message<<'\n'; }
}
void need(bool value,const char *message="Disposable fixture setup failed.") {
    if(!value) throw lmti::Error(message);
}
QString at(const QString &parent,const QString &name) { return QDir(parent).filePath(name); }
QString uuid() { return QUuid::createUuid().toString(QUuid::WithoutBraces); }
QString directory(const QString &parent,const QString &name) {
    need(QDir(parent).mkdir(name)); return at(parent,name);
}
void put(const QString &path,const QByteArray &value) {
    QFile file(path); need(file.open(QIODevice::WriteOnly|QIODevice::Truncate));
    need(file.write(value)==value.size());
}
QByteArray bytes(const QString &path) {
    QFile file(path); need(file.open(QIODevice::ReadOnly)); return file.readAll();
}
QByteArray sha(const QString &path) {
    QFile file(path); need(file.open(QIODevice::ReadOnly)); QCryptographicHash hash(QCryptographicHash::Sha256);
    while(!file.atEnd()) { const auto part=file.read(64*1024); need(!part.isEmpty()); hash.addData(part); }
    return hash.result().toHex();
}
// Test-owned tree only, no recursion into links. SHM may coordinate readonly
// SQLite readers; preserve its existence/size, deliberately not its bytes.
using Tree=QMap<QString,QByteArray>;
void collect(const QString &root,const QString &relative,Tree &out) {
    for(const auto &e:QDir(relative.isEmpty()?root:at(root,relative)).entryInfoList(
            QDir::AllEntries|QDir::NoDotAndDotDot|QDir::Hidden|QDir::System,QDir::Name)) {
        const auto name=relative.isEmpty()?e.fileName():relative+'/'+e.fileName();
        if(e.isSymLink()||e.isJunction()) { out.insert(name,"link"); continue; }
        if(e.isDir()) { out.insert(name,"directory"); collect(root,name,out); }
        else out.insert(name,QByteArray::number(e.size())+":"+(name.endsWith("-shm")?QByteArray("shm-coordination"):sha(e.filePath())));
    }
}
Tree snapshot(const QString &root) { Tree result; collect(root,{},result); return result; }
class Sql {
    QString connection_=uuid();
  public:
    QSqlDatabase db;
    explicit Sql(const QString &path) {
        db=QSqlDatabase::addDatabase("QSQLITE",connection_); db.setDatabaseName(path);
        db.setConnectOptions("QSQLITE_BUSY_TIMEOUT=2000"); need(db.open());
    }
    ~Sql() { db.close(); db={}; QSqlDatabase::removeDatabase(connection_); }
    void exec(const QString &statement,const QVariantList &values={}) {
        QSqlQuery query(db); need(query.prepare(statement)); for(const auto &v:values) query.addBindValue(v); need(query.exec());
    }
};
using Rows=std::vector<QVariantList>;
Rows rows(const QString &path,const QString &table) {
    Sql db(path); QSqlQuery q(db.db); need(q.exec("SELECT id,label,path,folder,pinned,opened,folder_key FROM "+table+" ORDER BY id"));
    Rows result; while(q.next()) { QVariantList row; for(int i=0;i<7;++i)row.push_back(q.value(i)); result.push_back(row); } return result;
}
bool exact_rows(const Rows &a,const Rows &b) {
    if(a.size()!=b.size())return false;
    for(std::size_t r=0;r<a.size();++r) for(qsizetype c=0;c<a[r].size();++c)
        if(a[r][c].isNull()!=b[r][c].isNull() || (!a[r][c].isNull() &&
           (a[r][c].metaType()!=b[r][c].metaType()||a[r][c]!=b[r][c])))return false;
    return true;
}
struct Fixture {
    QTemporaryDir temp;
    QString library,parent,project;
    int schema;
    explicit Fixture(int version=1,int count=3):schema(version) {
        need(temp.isValid()); library=temp.filePath("library.sqlite"); parent=directory(temp.path(),"backups");
        put(temp.filePath("upgrade-recovery-fixture.marker"),"lmti.upgrade.recovery.fixture.v1\n");
        project=temp.filePath("project.sqlite");
        lmti::ProjectDocument d; d.project={"selected","Recovery fixture","Synthetic typed library recovery",lmti::Privacy::Internal};
        d.topology.revision=lmti::save_project(project,d);
        lmti::remember_library_project(library,{"selected","Recovery fixture",project,{}});
        {
            Sql db(library); db.exec("BEGIN IMMEDIATE");
            db.exec("UPDATE library SET pinned=1,opened=23,folder=NULL,folder_key=NULL");
            for(int n=1;n<count;++n) {
                const auto id=QString("row-%1").arg(n,3,10,QChar('0'));
                db.exec("INSERT INTO library VALUES(?,?,?,?,?,?,?)",{id,"Offline fixture",temp.filePath(id+".sqlite"),
                    QVariant(QMetaType::fromType<QString>()),0,17+n,QVariant(QMetaType::fromType<QString>())});
            }
            if(count>=3) {
                db.exec("UPDATE library SET folder='',folder_key='' WHERE id='row-001'");
                db.exec("UPDATE library SET folder='',folder_key=NULL WHERE id='row-002'");
            }
            db.exec("COMMIT");
        }
        if(version>=2) {
            const auto result=lmti::upgrade_project_library(library,parent,lmti::inspect_project_library(library).token);
            need(result.state==lmti::LibraryUpgradeState::Upgraded);
        }
        need(QFile::remove(project)); // All referenced projects are deliberately offline.
    }
    lmti::LibraryFormatPreview expected() const {
        const auto view=lmti::inspect_project_library(library);
        return view.token.schema==1?lmti::LibraryFormatPreview{view.token,view.token.digest}:
            lmti::inspect_library_activation_upgrade(library);
    }
    lmti::LibraryUpgradeStatus upgrade(const lmti::LibraryFormatPreview &expected,
        lmti::LibraryTestFault fault=lmti::LibraryTestFault::None) const {
        lmti::set_library_test_fault(fault);
        const auto result=expected.source.schema==1?lmti::upgrade_project_library(library,parent,expected.source):
            lmti::upgrade_library_activation_format(library,parent,expected);
        lmti::set_library_test_fault(lmti::LibraryTestFault::None); return result;
    }
};
using Result=lmti::LibraryUpgradeRecovery;
using Condition=lmti::LibraryUpgradeRecoveryCondition;
using State=lmti::LibraryBackupObservationState;
using Match=lmti::LibraryBackupReceiptMatch;
Result observe(const Fixture &f,const lmti::LibraryFormatPreview &expected,const QString &parent={}) {
    const auto before=snapshot(f.temp.path());
    auto result=lmti::inspect_library_upgrade_recovery(f.library,parent.isEmpty()?f.parent:parent,expected);
    check(snapshot(f.temp.path())==before,"Recovery read changed source/main/WAL/backup bytes or entries.");
    check(result.examined_entries<=1001 && result.artifacts.size()<=1000 &&
          result.unresolved_entries<=result.examined_entries,"Recovery read exceeded bounded observation counts.");
    check(std::is_sorted(result.artifacts.begin(),result.artifacts.end(),[](const auto &a,const auto &b) {
        return a.artifact_key<b.artifact_key;
    }),"Artifact order is not deterministic.");
    return result;
}
const lmti::LibraryBackupObservation &artifact(const Result &result,const QString &operation) {
    const auto it=std::find_if(result.artifacts.begin(),result.artifacts.end(),[&](const auto &a){return a.operation_id==operation;});
    need(it!=result.artifacts.end(),"Expected bounded artifact observation absent."); return *it;
}
void verified(const Result &r,Condition condition) {
    check(r.complete && r.condition==condition && r.code==lmti::LibraryCode::None &&
          r.current.has_value() && r.current_snapshot_digest.size()==64 && r.parent_snapshot_digest.size()==64 &&
          r.unresolved_entries==0,"Complete typed recovery state was not verified.");
}
void unresolved(const Result &r) {
    check(!r.complete && r.condition==Condition::Unresolved && r.code!=lmti::LibraryCode::None,
          "Incomplete recovery was presented as verified.");
}
void refused(const std::function<void()> &call,lmti::LibraryCode code=lmti::LibraryCode::InvalidInput) {
    try { call(); check(false,"Malformed recovery input was accepted."); }
    catch(const lmti::LibraryError &e) {
        check(e.code==code && QByteArray(e.what())=="Library operation was refused.","Typed recovery refusal leaked details or wrong code.");
    }
}
QString duplicate(const Fixture &f,const QString &backup,const QString &id={}) {
    const auto child=directory(f.parent,id.isEmpty()?uuid():id);
    need(QFile::copy(backup,at(child,QFileInfo(backup).fileName()))); return QFileInfo(child).fileName();
}

void original_empty_and_offline() {
    for(const int schema:{1,2}) {
        Fixture f(schema); const auto expected=f.expected();
        const auto empty=directory(f.temp.path(),"empty-current-parent");
        const auto result=observe(f,expected,empty); verified(result,Condition::OriginalStateVerified);
        check(result.examined_entries==0 && result.artifacts.empty() && !result.committed_operation_id,
              "Empty original state invented an upgrade identity.");
        check(result.current==expected.source,"Original state changed its library token.");
        if(schema==2) {
            const auto prior=observe(f,expected); verified(prior,Condition::OriginalStateVerified);
            check(prior.artifacts.size()==1 && prior.artifacts[0].receipt_match==Match::UpgradeV1 &&
                  !prior.artifacts[0].matches_expected && !prior.committed_operation_id,
                  "Earlier visible v1 backup was confused with the requested v2 transition.");
        }
    }
}
void actual_orphans_and_nullable_rows() {
    for(const int schema:{1,2}) {
        Fixture f(schema); const auto expected=f.expected(); const auto original=rows(f.library,schema==1?"library":"library_entries");
        const auto source=sha(f.library);
        const auto fault=schema==1?lmti::LibraryTestFault::AfterBackupVerification:lmti::LibraryTestFault::AfterFormatBackupVerification;
        const auto first=f.upgrade(expected,fault),second=f.upgrade(expected,fault);
        check(first.state==lmti::LibraryUpgradeState::RecoveryRequired && second.state==lmti::LibraryUpgradeState::RecoveryRequired &&
              first.operation_id!=second.operation_id,"Actual pre-COMMIT faults did not retain two independent reservations.");
        check(sha(f.library)==source && exact_rows(original,rows(first.backup_path,schema==1?"library":"library_entries")),
              "Faulted upgrade changed source or collapsed nullable typed backup fields.");
        const auto result=observe(f,expected); verified(result,Condition::OriginalStateVerified);
        check(!result.committed_operation_id,"Equivalent orphan candidates identified a lost operation.");
        for(const auto &id:{first.operation_id,second.operation_id}) {
            const auto &a=artifact(result,id);
            check(a.state==State::Verified && a.matches_expected && a.receipt_match==Match::None &&
                  a.schema==schema && a.full_snapshot_digest==expected.full_snapshot_digest,
                  "Pre-COMMIT artifact was not independently verified without attribution.");
        }
        const auto extra=duplicate(f,first.backup_path);
        const auto copied=observe(f,expected); verified(copied,Condition::OriginalStateVerified);
        check(artifact(copied,extra).receipt_match==Match::None && !copied.committed_operation_id,
              "Duplicated matching backup acquired a guessed durable receipt.");
    }
}
void before_and_after_commit() {
    for(const int schema:{1,2}) for(const bool after:{false,true}) {
        Fixture f(schema); const auto expected=f.expected();
        const auto fault=schema==1?(after?lmti::LibraryTestFault::AfterUpgradeCommit:lmti::LibraryTestFault::BeforeUpgradeCommit):
            (after?lmti::LibraryTestFault::AfterFormatCommit:lmti::LibraryTestFault::BeforeFormatCommit);
        const auto unknown=f.upgrade(expected,fault);
        check(unknown.state==lmti::LibraryUpgradeState::RecoveryRequired && !unknown.operation_id.isEmpty(),
              "Commit boundary fault was not represented as unknown.");
        const auto result=observe(f,expected);
        verified(result,after?Condition::CommittedStateVerified:Condition::OriginalStateVerified);
        const auto &a=artifact(result,unknown.operation_id);
        check(a.matches_expected && a.state==State::Verified &&
              a.receipt_match==(after?(schema==1?Match::UpgradeV1:Match::UpgradeV2):Match::None),
              "Recovery receipt correlation ignored actual COMMIT boundary.");
        check(after?result.committed_operation_id==unknown.operation_id:!result.committed_operation_id,
              "Recovery assigned a committed identity to an uncommitted attempt.");
        if(after) {
            lmti::pin_library_project(f.library,"selected",false);
            const auto fresh=observe(f,expected); verified(fresh,Condition::CommittedStateVerified);
            check(fresh.current_snapshot_digest!=result.current_snapshot_digest,
                  "Committed recovery fingerprint omitted changed cosmetic rows.");
        }
    }
}
void durable_lineage_and_tamper() {
    Fixture f(2); const auto expected=f.expected(); const auto status=f.upgrade(expected,lmti::LibraryTestFault::AfterFormatCommit);
    auto result=observe(f,expected); verified(result,Condition::CommittedStateVerified);
    check(result.artifacts.size()==2 && std::count_if(result.artifacts.begin(),result.artifacts.end(),
          [](const auto &a){return a.receipt_match==Match::UpgradeV1;})==1 &&
          std::count_if(result.artifacts.begin(),result.artifacts.end(),
          [](const auto &a){return a.receipt_match==Match::UpgradeV2;})==1,"Two legitimate durable backups were not independently covered.");
    // Receipt-named full backup evidence cannot replace the exact original v2
    // generation/bindings pin, even when its UUID and full digest still match.
    for(const bool change_generation:{true,false}) {
        auto altered=expected;
        if(change_generation)++altered.source.generation;
        else altered.source.digest=QString(64,expected.source.digest==QString(64,'a')?'b':'a');
        const auto mismatch=observe(f,altered); unresolved(mismatch);
        const auto &row=artifact(mismatch,status.operation_id);
        check(!row.matches_expected && row.full_snapshot_digest==expected.full_snapshot_digest &&
              mismatch.parent_snapshot_digest.isEmpty(),
              "Committed receipt bypassed the original generation or bindings digest pin.");
    }
    result=observe(f,expected); verified(result,Condition::CommittedStateVerified);
    check(artifact(result,status.operation_id).matches_expected,
          "Exact original v2 pins stopped verifying after mismatched read-only requests.");
    // Move only this known test-owned fixed leaf; missing committed evidence cannot
    // be replaced by selecting an equivalent orphan with another operation UUID.
    const auto twin=duplicate(f,status.backup_path);
    need(QFile::rename(status.backup_path,f.temp.filePath("retained-backup.sqlite")));
    result=observe(f,expected); unresolved(result);
    check(artifact(result,twin).matches_expected && artifact(result,twin).receipt_match==Match::None,
          "Equivalent backup impersonated missing committed operation.");
    need(QFile::rename(f.temp.filePath("retained-backup.sqlite"),status.backup_path));
    {
        Sql db(status.backup_path); db.exec("UPDATE library_identity SET library_uuid=?",{uuid()});
    }
    result=observe(f,expected); unresolved(result);
    check(artifact(result,status.operation_id).state!=State::Verified,"Changed backup UUID was accepted at same path.");
}
void full_snapshot_and_nullable_drift() {
    for(const int schema:{1,2}) {
        Fixture f(schema); const auto expected=f.expected();
        const auto status=f.upgrade(expected,schema==1?lmti::LibraryTestFault::AfterBackupVerification:lmti::LibraryTestFault::AfterFormatBackupVerification);
        {
            Sql db(status.backup_path);
            db.exec(QString("UPDATE %1 SET folder='' WHERE id='selected'").arg(schema==1?"library":"library_entries"));
        }
        auto result=observe(f,expected); unresolved(result);
        check(artifact(result,status.operation_id).state==State::Foreign,"NULL-to-empty typed change was ignored.");
        // Current original rows changed without a v2 binding-generation change.
        const auto token=lmti::inspect_project_library(f.library).token;
        lmti::pin_library_project(f.library,"selected",false);
        if(schema==2)check(lmti::inspect_project_library(f.library).token==token,"Cosmetics fixture unexpectedly changed authority token.");
        const auto empty=directory(f.temp.path(),"empty-after-cosmetics");
        result=observe(f,expected,empty); unresolved(result);
    }
}
void malformed_coverage() {
    const QStringList variants{"empty","partial","extra","foreign","both","nonuuid","ordinary-file"};
    for(const auto &variant:variants) {
        Fixture f; const auto expected=f.expected(); QString id=uuid(),child;
        if(variant=="nonuuid") { id="unrecognized-name"; child=directory(f.parent,id); }
        else if(variant=="ordinary-file") { put(at(f.parent,id),"ordinary"); }
        else {
            child=directory(f.parent,id);
            if(variant=="partial")put(at(child,"library-v1.sqlite"),"not SQLite");
            else if(variant=="extra") {
                need(QFile::copy(f.library,at(child,"library-v1.sqlite"))); put(at(child,"unrecognized"),"extra");
            } else if(variant=="both") {
                need(QFile::copy(f.library,at(child,"library-v1.sqlite")));
                need(QFile::copy(f.library,at(child,"library-v2.sqlite")));
            } else if(variant=="foreign") {
                need(QFile::copy(f.library,at(child,"library-v1.sqlite")));
                Sql db(at(child,"library-v1.sqlite")); db.exec("UPDATE library SET label='Other valid snapshot' WHERE id='selected'");
            }
        }
        const auto result=observe(f,expected); unresolved(result);
        check(result.examined_entries==1 && result.unresolved_entries==1 && result.artifacts.size()==1,
              "Invalid immediate entry disappeared from complete coverage counts.");
        const auto &a=result.artifacts[0];
        if(variant=="empty")check(a.state==State::Incomplete,"Empty reservation was not incomplete.");
        else if(variant=="foreign")check(a.state==State::Foreign,"Foreign valid full snapshot was accepted or mislabeled.");
        else check(a.state!=State::Verified,"Malformed or unrecognized entry was silently verified.");
        if(variant=="nonuuid")check(!a.operation_id,"Invalid filename was returned as an operation UUID.");
        check(a.artifact_key.size()==64 && !a.matches_expected && a.receipt_match==Match::None,
              "Malformed artifact gained receipt authority.");
    }
}
void row_and_entry_bounds() {
    {
        Fixture f(1,500); const auto expected=f.expected();
        const auto orphan=f.upgrade(expected,lmti::LibraryTestFault::AfterBackupVerification);
        auto result=observe(f,expected); verified(result,Condition::OriginalStateVerified);
        check(artifact(result,orphan.operation_id).full_snapshot_digest==expected.full_snapshot_digest,"500-row typed snapshot was truncated.");
    }
    {
        Fixture f; const auto expected=f.expected();
        for(int n=0;n<1000;++n)directory(f.parent,QString("00000001-0000-4000-8000-%1").arg(n+1,12,16,QChar('0')));
        auto result=observe(f,expected); unresolved(result);
        check(result.examined_entries==1000 && result.artifacts.size()==1000 && result.unresolved_entries==1000 &&
              result.code!=lmti::LibraryCode::BudgetExceeded,"Exactly1000 bounded empty reservations were treated as overflow or truncated.");
        directory(f.parent,"unattributed-overflow-entry");
        result=observe(f,expected); unresolved(result);
        check(result.examined_entries==1001 && result.artifacts.size()<=1000 &&
              result.unresolved_entries<=1000 && result.code==lmti::LibraryCode::BudgetExceeded,
              "1001st entry was not an unattributed budget sentinel.");
    }
}
void aggregate_byte_budget() {
    Fixture f; const auto expected=f.expected();
    for(int n=0;n<9;++n) {
        const auto child=directory(f.parent,uuid()),leaf=at(child,"library-v1.sqlite");
        need(QFile::copy(f.library,leaf)); QFile padded(leaf); need(padded.open(QIODevice::ReadWrite)); need(padded.resize(64LL*1024*1024));
    }
    const auto result=observe(f,expected); unresolved(result);
    check(result.code==lmti::LibraryCode::BudgetExceeded,"Aggregate content-work cap did not refuse bounded oversized combination.");
}
// This private self-child accepts no SQL or arbitrary filename. It mutates only
// a marked, existing test library and deliberately skips SQLite close so a real
// committed WAL and its preexisting SHM remain without a live writer.
int leave_wal(const QString &library) {
    const QFileInfo file(library),parent(file.absolutePath());
    need(file.fileName()=="library.sqlite" && file.isFile() && !file.isSymLink() && !file.isJunction() &&
         parent.isDir() && !parent.isSymLink() && !parent.isJunction());
    need(bytes(at(parent.filePath(),"upgrade-recovery-fixture.marker"))=="lmti.upgrade.recovery.fixture.v1\n");
    const auto schema=lmti::inspect_project_library(library).token.schema;
    need(schema==1||schema==2);
    Sql db(library);
    db.exec("PRAGMA journal_mode=WAL"); db.exec("PRAGMA wal_autocheckpoint=0"); db.exec("BEGIN IMMEDIATE");
    db.exec(QString("UPDATE %1 SET label='Committed WAL fixture',opened=61 WHERE id='selected'").arg(schema==1?"library":"library_entries"));
    db.exec("COMMIT");
    std::_Exit(0);
}
void make_wal(const Fixture &f) {
    QProcess child; child.setProgram(QCoreApplication::applicationFilePath()); child.setArguments({"--leave-wal",f.library});
    child.start(); need(child.waitForStarted(5000)); need(child.waitForFinished(15000));
    need(child.exitStatus()==QProcess::NormalExit && child.exitCode()==0,"Controlled WAL child failed.");
    need(QFileInfo(f.library+"-wal").size()>32 && QFileInfo(f.library+"-shm").size()>0,"Committed WAL/SHM fixture was not retained.");
}
void source_wal_and_no_repair() {
    for(const int schema:{1,2}) {
        Fixture f(schema); make_wal(f);
        const auto expected=f.expected(); const auto before=sha(f.library), wal=sha(f.library+"-wal");
        const auto result=observe(f,expected); verified(result,Condition::OriginalStateVerified);
        check(sha(f.library)==before && sha(f.library+"-wal")==wal && QFileInfo::exists(f.library+"-shm"),
              "Readonly live-source inspection checkpointed/deleted WAL or created a different main snapshot.");
    }
    {
        Fixture f; make_wal(f); const auto expected=f.expected();
        need(QFile::rename(f.library+"-shm",f.temp.filePath("retained-shm")));
        const auto result=observe(f,expected); unresolved(result);
        check(!QFileInfo::exists(f.library+"-shm"),"Recovery created missing source SHM.");
    }
    for(const auto &suffix:{QString("-journal"),QString("-shm")}) {
        Fixture f; const auto expected=f.expected();
        put(f.library+suffix,suffix=="-journal"?QByteArray("nonempty rollback journal"):QByteArray(32768,'\0'));
        const auto result=observe(f,expected); unresolved(result);
    }
}
void standalone_backup_sidecars() {
    for(const auto &suffix:{QString("-wal"),QString("-shm"),QString("-journal")}) {
        Fixture f; const auto expected=f.expected();
        const auto result=f.upgrade(expected,lmti::LibraryTestFault::AfterBackupVerification);
        put(result.backup_path+suffix,{});
        const auto observed=observe(f,expected); unresolved(observed);
        check(artifact(observed,result.operation_id).state!=State::Verified,
              "Standalone immutable backup inspection ignored an existing sidecar.");
    }
}
#ifdef Q_OS_WIN
class DenyRead {
    HANDLE handle_=INVALID_HANDLE_VALUE;
  public:
    explicit DenyRead(const QString &path) {
        handle_=CreateFileW(reinterpret_cast<LPCWSTR>(path.utf16()),GENERIC_READ,0,nullptr,OPEN_EXISTING,FILE_ATTRIBUTE_NORMAL,nullptr);
        need(handle_!=INVALID_HANDLE_VALUE);
    }
    ~DenyRead() { if(handle_!=INVALID_HANDLE_VALUE)CloseHandle(handle_); }
};
#endif
bool hardlink(const QString &alias,const QString &target) {
#ifdef Q_OS_WIN
    return CreateHardLinkW(reinterpret_cast<LPCWSTR>(alias.utf16()),reinterpret_cast<LPCWSTR>(target.utf16()),nullptr)!=0;
#else
    return ::link(QFile::encodeName(target).constData(),QFile::encodeName(alias).constData())==0;
#endif
}
bool symlink_file(const QString &alias,const QString &target) {
#ifdef Q_OS_WIN
    if(CreateSymbolicLinkW(reinterpret_cast<LPCWSTR>(alias.utf16()),reinterpret_cast<LPCWSTR>(target.utf16()),2))return true;
    if(GetLastError()==ERROR_INVALID_PARAMETER)
        return CreateSymbolicLinkW(reinterpret_cast<LPCWSTR>(alias.utf16()),reinterpret_cast<LPCWSTR>(target.utf16()),0)!=0;
    return false;
#else
    return ::symlink(QFile::encodeName(target).constData(),QFile::encodeName(alias).constData())==0;
#endif
}
bool junction(const QString &alias,const QString &target) {
#ifdef Q_OS_WIN
    if(!QDir().mkdir(alias))return false;
    const auto handle=CreateFileW(reinterpret_cast<LPCWSTR>(alias.utf16()),GENERIC_WRITE,0,nullptr,OPEN_EXISTING,
        FILE_FLAG_OPEN_REPARSE_POINT|FILE_FLAG_BACKUP_SEMANTICS,nullptr);
    if(handle==INVALID_HANDLE_VALUE){QDir().rmdir(alias);return false;}
    struct Buffer {DWORD tag;WORD length,reserved,sub_offset,sub_length,print_offset,print_length;wchar_t names[2048];} data{};
    const auto print=QDir::toNativeSeparators(target),sub=QString("\\??\\")+print;
    need(sub.size()+print.size()+2<2048); data.tag=IO_REPARSE_TAG_MOUNT_POINT;
    data.sub_length=WORD(sub.size()*sizeof(wchar_t)); data.print_offset=WORD(data.sub_length+sizeof(wchar_t));
    data.print_length=WORD(print.size()*sizeof(wchar_t));
    std::memcpy(data.names,sub.utf16(),data.sub_length);
    std::memcpy(reinterpret_cast<char *>(data.names)+data.print_offset,print.utf16(),data.print_length);
    data.length=WORD(8+data.print_offset+data.print_length+sizeof(wchar_t));DWORD returned=0;
    const auto ok=DeviceIoControl(handle,FSCTL_SET_REPARSE_POINT,&data,DWORD(data.length+8),nullptr,0,&returned,nullptr);
    CloseHandle(handle);if(!ok)QDir().rmdir(alias);return ok!=0;
#else
    (void)alias;(void)target;return false;
#endif
}
void unavailable_and_links() {
#ifdef Q_OS_WIN
    {
        Fixture f;const auto expected=f.expected();
        const auto orphan=f.upgrade(expected,lmti::LibraryTestFault::AfterBackupVerification);
        const auto before=snapshot(f.temp.path());
        { DenyRead held(f.library); const auto result=lmti::inspect_library_upgrade_recovery(f.library,f.parent,expected);unresolved(result);
          check(!result.current && result.current_snapshot_digest.isEmpty() && result.parent_snapshot_digest.isEmpty(),
                "Unreadable source acquired a fresh current identity or usable snapshot digest.");
          const auto &row=artifact(result,orphan.operation_id);
          check(row.schema==1 && row.full_snapshot_digest==expected.full_snapshot_digest &&
                row.state==State::Unavailable && !row.matches_expected && row.receipt_match==Match::None &&
                !result.committed_operation_id && result.unresolved_entries==1,
                "Unclassified matching backup became Foreign, gained receipt authority, or vanished from unresolved coverage."); }
        check(snapshot(f.temp.path())==before,"Exclusive source read failure changed files.");
    }
    {
        Fixture f;const auto expected=f.expected();const auto backup=f.upgrade(expected,lmti::LibraryTestFault::AfterBackupVerification);
        const auto before=snapshot(f.temp.path());
        { DenyRead held(backup.backup_path);const auto result=lmti::inspect_library_upgrade_recovery(f.library,f.parent,expected);unresolved(result);
          check(artifact(result,backup.operation_id).state==State::Unavailable,"Exclusively held backup did not remain unavailable."); }
        check(snapshot(f.temp.path())==before,"Exclusive backup read failure changed files.");
    }
#else
    ++skips;std::cout<<"SKIP: Windows mandatory sharing lock evidence unavailable on this platform.\n";
#endif
    {
        Fixture f;const auto expected=f.expected();
        if(hardlink(f.temp.filePath("retained-main-alias"),f.library))unresolved(observe(f,expected));
        else {++skips;std::cout<<"SKIP: local filesystem denied/unavailable hardlink creation.\n";}
    }
    {
        Fixture f;const auto expected=f.expected();const auto backup=f.upgrade(expected,lmti::LibraryTestFault::AfterBackupVerification);
        if(hardlink(f.temp.filePath("retained-backup-alias"),backup.backup_path))unresolved(observe(f,expected));
        else {++skips;std::cout<<"SKIP: local filesystem denied/unavailable backup hardlink creation.\n";}
    }
    {
        Fixture f;const auto expected=f.expected();const auto child=directory(f.parent,uuid());
        if(symlink_file(at(child,"library-v1.sqlite"),f.library)) {
            const auto result=observe(f,expected);unresolved(result);
            check(result.artifacts.size()==1&&result.artifacts[0].state==State::Unavailable,"Backup symlink was followed.");
        }else {++skips;std::cout<<"SKIP: local file symlink creation unavailable/denied.\n";}
    }
    {
        Fixture f;const auto expected=f.expected();const auto outside=directory(f.temp.path(),"outside");
        need(QFile::copy(f.library,at(outside,"library-v1.sqlite")));const auto alias=at(f.parent,uuid());
        if(junction(alias,outside)) {
            const auto result=observe(f,expected);unresolved(result);
            check(result.artifacts.size()==1&&result.artifacts[0].state==State::Unavailable,"UUID junction was followed.");
            need(QDir().rmdir(alias));
        }else {++skips;std::cout<<"SKIP: local directory junction creation unavailable/denied.\n";}
    }
}
void malformed_tokens_and_paths() {
    Fixture f;const auto expected=f.expected();const auto before=snapshot(f.temp.path());
    auto wrong=expected;wrong.source.schema=3;refused([&]{lmti::inspect_library_upgrade_recovery(f.library,f.parent,wrong);});
    wrong=expected;wrong.full_snapshot_digest=QString(64,'b');refused([&]{lmti::inspect_library_upgrade_recovery(f.library,f.parent,wrong);});
    wrong=expected;wrong.source.library_uuid=uuid();refused([&]{lmti::inspect_library_upgrade_recovery(f.library,f.parent,wrong);});
    wrong=expected;wrong.source.canonical_path=f.temp.filePath("other.sqlite");refused([&]{lmti::inspect_library_upgrade_recovery(f.library,f.parent,wrong);});
    wrong=expected;wrong.source.digest="invalid";refused([&]{lmti::inspect_library_upgrade_recovery(f.library,f.parent,wrong);});
    const QStringList paths{"\\\\server\\share\\backup","//server/share/backup","\\\\?\\C:\\backup",
        f.parent+":stream",f.parent+"/../backups",f.parent+"/bad.",f.parent+"/bad ",f.parent+"/NUL",f.parent+"/bad?"};
    for(const auto &path:paths)refused([&]{lmti::inspect_library_upgrade_recovery(f.library,path,expected);});
    unresolved(observe(f,expected,f.temp.filePath("missing-parent")));
    wrong=expected;const auto absent=f.temp.filePath("absent-library.sqlite");
    wrong.source.canonical_path=QDir::cleanPath(QDir::fromNativeSeparators(absent));
#ifdef Q_OS_WIN
    wrong.source.canonical_path=wrong.source.canonical_path.toCaseFolded();
#endif
    const auto unavailable=lmti::inspect_library_upgrade_recovery(absent,f.parent,wrong);unresolved(unavailable);
    check(!unavailable.current&&!QFileInfo::exists(absent),"Recovery inspection created a missing library.");
    check(!QFileInfo::exists(f.temp.filePath("missing-parent")) && snapshot(f.temp.path())==before,"Refused path/token created or changed files.");
}
QJsonObject token_json(const lmti::LibraryToken &token) {
    return {{"schema",token.schema},{"canonicalPath",token.canonical_path},
      {"uuid",token.schema==1?QJsonValue(QJsonValue::Null):QJsonValue(token.library_uuid)},
      {"generation",token.schema==1?QJsonValue(QJsonValue::Null):QJsonValue(token.generation)},{"digest",token.digest}};
}
QJsonObject request(const lmti::LibraryFormatPreview &expected) {
    return {{"action","library-upgrade-recovery"},{"expected",QJsonObject{{"source",token_json(expected.source)},
        {"fullSnapshotDigest",expected.full_snapshot_digest}}}};
}
void fields(const QJsonObject &value,const QSet<QString> &expected) {
    QSet<QString> actual;for(auto it=value.begin();it!=value.end();++it)actual.insert(it.key());
    check(actual==expected,"Private wire exposed extra fields or omitted required fields.");
}
class Facade {
    QString binary_;
  public:
    mutable qsizetype last_size=0;
    explicit Facade(QString binary):binary_(std::move(binary)){}
    QStringList args(const Fixture &f) const {return {"--project-operation-recovery","--library",f.library,"--backup-parent",f.parent};}
    QJsonObject raw(const Fixture &f,const QByteArray &input,const QStringList &arguments) const {
        const auto before=snapshot(f.temp.path());QProcess p;p.setProgram(binary_);p.setArguments(arguments);
        p.setProcessChannelMode(QProcess::SeparateChannels);QByteArray output,errors;bool overflow=false;
        auto drain=[&]{
            while(p.bytesAvailable()){const auto part=p.read(4096);if(part.isEmpty())break;
                if(output.size()+part.size()>512*1024){overflow=true;p.kill();}else output+=part;}
        };
        QObject::connect(&p,&QProcess::readyReadStandardOutput,&p,drain);
        QObject::connect(&p,&QProcess::readyReadStandardError,&p,[&]{
            const auto part=p.readAllStandardError();if(errors.size()+part.size()>4096){overflow=true;p.kill();}else errors+=part;
        });
        p.start();need(p.waitForStarted(5000));need(p.write(input)==input.size());p.closeWriteChannel();
        if(!p.waitForFinished(30000)){p.kill();p.waitForFinished(3000);throw lmti::Error("Read-only recovery facade exceeded fixture deadline.");}
        drain();errors+=p.readAllStandardError();
        check(snapshot(f.temp.path())==before,"Read-only recovery facade changed source or artifacts.");
        need(!overflow&&errors.isEmpty()&&output.size()<=512*1024&&p.exitStatus()==QProcess::NormalExit&&p.exitCode()==0,
             "Read-only recovery facade framing/exit failed.");
        need(output.endsWith('\n'));last_size=output.size();
        return lmti::detail::strict_json_object(output,512*1024);
    }
    QJsonObject raw(const Fixture &f,const QByteArray &input) const{return raw(f,input,args(f));}
    QJsonObject call(const Fixture &f,const lmti::LibraryFormatPreview &expected) const {
        return raw(f,QJsonDocument(request(expected)).toJson(QJsonDocument::Compact));
    }
};
QJsonObject observation(const QJsonObject &reply) {
    fields(reply,{"ok","schema","action","data"});
    check(reply["ok"]==true&&reply["schema"]=="lmti.project.upgrade-recovery.v1"&&reply["action"]=="library-upgrade-recovery",
          "Recovery wire envelope changed.");
    const auto data=reply["data"].toObject();
    fields(data,{"condition","code","complete","examinedEntries","unresolvedEntries","current","currentSnapshotDigest",
        "parentSnapshotDigest","committedOperationId","artifacts"});
    const auto values=data["artifacts"].toArray();
    check(values.size()<=1000,"Wire artifact bound exceeded.");
    for(const auto &v:values) {
        const auto a=v.toObject();fields(a,{"artifactKey","operationId","schema","fullSnapshotDigest","state","receiptMatch","matchesExpected"});
        check(a["artifactKey"].isString()&&a["artifactKey"].toString().size()==64&&a["matchesExpected"].isBool(),
              "Artifact wire types changed.");
        check(a["operationId"].isNull()||QUuid(a["operationId"].toString()).toString(QUuid::WithoutBraces)==a["operationId"].toString(),
              "Wire leaked an unrecognized filename instead of an opaque artifact key.");
    }
    return data;
}
void wire_refusal(const QJsonObject &reply) {
    fields(reply,{"ok","code"});check(reply["ok"]==false&&reply["code"]=="INVALID_INPUT","Strict wire input was not refused opaquely.");
}
void process_contract(const QString &binary) {
    Facade facade(binary);Fixture f;const auto expected=f.expected();const auto input=QJsonDocument(request(expected)).toJson(QJsonDocument::Compact);
    auto data=observation(facade.call(f,expected));
    check(data["complete"]==true&&data["condition"]=="original_state_verified"&&data["code"]=="NONE"&&
          data["committedOperationId"].isNull(),"Empty original wire state invented commit or used null success code.");
    const auto orphan=f.upgrade(expected,lmti::LibraryTestFault::AfterBackupVerification);
    data=observation(facade.call(f,expected));
    check(data["complete"]==true&&data["committedOperationId"].isNull()&&data["artifacts"].toArray().size()==1,
          "Real orphan wire acquired lost-operation attribution.");
    const auto committed=f.upgrade(expected,lmti::LibraryTestFault::AfterUpgradeCommit);
    data=observation(facade.call(f,expected));
    check(data["complete"]==true&&data["condition"]=="committed_state_verified"&&
          data["committedOperationId"]==committed.operation_id,"Actual post-COMMIT wire did not use durable receipt.");
    (void)orphan;
    const QList<QByteArray> invalid{
        {},QByteArray("{}"),QByteArray::fromHex("ff"),input+QByteArray(1,'\0'),
        input+QByteArray(1,'\x1a')+"ignored-tail",input+"{}",QByteArray(32769,' '),
        QByteArray("{\"action\":\"library-upgrade-recovery\",")+input.mid(1),
        QByteArray("{\"action\":\"copy-prepare\"}"),QByteArray("{\"action\":\"library-upgrade-recovery\",\"expected\":null}")};
    for(const auto &value:invalid)wire_refusal(facade.raw(f,value));
    auto extra=request(expected);extra["extra"]=true;
    wire_refusal(facade.raw(f,QJsonDocument(extra).toJson(QJsonDocument::Compact)));
    auto wrong=request(expected),preview=wrong["expected"].toObject(),source=preview["source"].toObject();
    source["schema"]="1";preview["source"]=source;wrong["expected"]=preview;
    wire_refusal(facade.raw(f,QJsonDocument(wrong).toJson(QJsonDocument::Compact)));
    auto args=facade.args(f);args.push_back("--extra");wire_refusal(facade.raw(f,input,args));
    args=facade.args(f);args[3]="--copy-parent";wire_refusal(facade.raw(f,input,args));
    args=facade.args(f);args[4]="\\\\server\\share\\backups";wire_refusal(facade.raw(f,input,args));
    {
        Fixture v2(2);const auto reviewed=v2.expected();
        data=observation(facade.call(v2,reviewed));
        check(data["condition"]=="original_state_verified"&&data["current"].toObject()["schema"]==2,
              "Private process lost exact original v2 identity.");
        const auto upgraded=v2.upgrade(reviewed,lmti::LibraryTestFault::AfterFormatCommit);
        data=observation(facade.call(v2,reviewed));
        check(data["condition"]=="committed_state_verified"&&data["committedOperationId"]==upgraded.operation_id&&
              data["current"].toObject()["schema"]==3,"Private process failed actual v2-to-v3 receipt recovery.");
    }
}
void process_bounded_coverage(const QString &binary) {
    Fixture f;Facade facade(binary);const auto expected=f.expected();
    for(int n=0;n<1000;++n)directory(f.parent,QString("00000002-0000-4000-8000-%1").arg(n+1,12,16,QChar('0')));
    auto data=observation(facade.call(f,expected));
    check(data["complete"]==false&&data["condition"]=="unresolved"&&data["examinedEntries"].toInt()==1000&&
          data["unresolvedEntries"].toInt()==1000&&data["artifacts"].toArray().size()==1000&&facade.last_size<=512*1024,
          "Maximum bounded observation did not preserve all rows inside output cap.");
    directory(f.parent,"non-uuid-sentinel");
    data=observation(facade.call(f,expected));
    check(data["complete"]==false&&data["code"]=="BUDGET_EXCEEDED"&&data["examinedEntries"].toInt()==1001&&
          data["artifacts"].toArray().size()<=1000&&data["parentSnapshotDigest"].isNull(),
          "Overflow wire returned a usable truncated parent snapshot.");
}
void run(const char *name,const std::function<void()> &test) {
    ++cases;try{test();}catch(const std::exception &){++failures;std::cerr<<"FAIL: "<<name<<" threw during controlled fixture/owner check.\n";}
    lmti::set_library_test_fault(lmti::LibraryTestFault::None);
}
}
int main(int argc,char **argv) {
    QCoreApplication app(argc,argv);const auto arguments=app.arguments();
    try {
        if(arguments.size()==3&&arguments[1]=="--leave-wal")return leave_wal(arguments[2]);
        need(arguments.size()==2,"Pass the current shipped native admin executable.");
        run("original empty and offline",original_empty_and_offline);
        run("actual orphan and nullable rows",actual_orphans_and_nullable_rows);
        run("before and after real COMMIT",before_and_after_commit);
        run("durable lineage and tamper",durable_lineage_and_tamper);
        run("full snapshot and nullable drift",full_snapshot_and_nullable_drift);
        run("malformed complete coverage",malformed_coverage);
        run("row and entry bounds",row_and_entry_bounds);
        run("aggregate byte budget",aggregate_byte_budget);
        run("source WAL and no repair",source_wal_and_no_repair);
        run("standalone backup sidecars",standalone_backup_sidecars);
        run("unavailable and local links",unavailable_and_links);
        run("malformed tokens and raw paths",malformed_tokens_and_paths);
        run("real process exact protocol",[&]{process_contract(arguments[1]);});
        run("real process bounded coverage",[&]{process_bounded_coverage(arguments[1]);});
    }catch(const std::exception &){++failures;std::cerr<<"FAIL: recovery test invocation/setup.\n";}
    std::cout<<"Library upgrade recovery: "<<cases<<" cases, "<<checks<<" checks, "<<failures
             <<" failures, "<<skips<<" conditional skips; observations do not identify a lost outcome.\n";
    return failures?1:0;
}
