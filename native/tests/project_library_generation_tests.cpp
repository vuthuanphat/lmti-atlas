#include "lmti/project_library.hpp"
#include <QCoreApplication>
#include <QDir>
#include <QFile>
#include <QFileInfo>
#include <QSqlDatabase>
#include <QSqlQuery>
#include <QStringList>
#include <QTemporaryDir>
#include <QThread>
#include <QUuid>
#include <QVariant>
#include <algorithm>
#include <atomic>
#include <functional>
#include <cstdlib>
#include <iostream>
#include <optional>
#include <stdexcept>

#ifndef LMTI_LIBRARY_CORE_TEST_HOOKS
#error This test requires its isolated owner build, never the shipped storage library.
#endif

namespace {
int failures = 0;
void check(bool ok, const char *message) {
    if (!ok) { std::cerr << message << '\n'; ++failures; }
}
void require(bool ok, const char *message) {
    if (!ok) throw std::runtime_error(message);
}
void rejects(const std::function<void()> &call, const char *message,
             std::optional<lmti::LibraryCode> code = {}) {
    try { call(); check(false,message); }
    catch (const lmti::LibraryError &error) {
        check(!code || error.code == *code,message);
        check(QByteArray(error.what()) == "Library operation was refused.","library error exposed private details");
    } catch (const lmti::Error &) { check(!code,"library error bypassed its typed contract"); }
}
QByteArray bytes(const QString &path) {
    QFile file(path); require(file.open(QIODevice::ReadOnly),"cannot read disposable fixture");
    return file.readAll();
}
QString parent(const QTemporaryDir &temp, const QString &name) {
    require(QDir(temp.path()).mkdir(name),"cannot create disposable parent"); return temp.filePath(name);
}
QString folder_key(QString path) {
    path = QDir::cleanPath(QDir::fromNativeSeparators(path));
#ifdef Q_OS_WIN
    path = path.toCaseFolded();
#endif
    return path;
}
// Every SQL statement, rename and removal below operates only in QTemporaryDir.
// SQL is test-fixture control, not an input accepted by the native owner.
class Sql {
    QString connection_ = QUuid::createUuid().toString();
  public:
    QSqlDatabase db;
    explicit Sql(const QString &path) {
        db = QSqlDatabase::addDatabase("QSQLITE",connection_); db.setDatabaseName(path);
        db.setConnectOptions("QSQLITE_BUSY_TIMEOUT=2000");
        require(db.open(),"fixture SQLite open failed");
    }
    ~Sql() { db.close(); db = {}; QSqlDatabase::removeDatabase(connection_); }
    bool attempt(const QString &statement, const QVariantList &values = {}) {
        QSqlQuery query(db);
        if (!query.prepare(statement)) return false;
        for (const auto &value : values) query.addBindValue(value);
        return query.exec();
    }
    void exec(const QString &statement, const QVariantList &values = {}) {
        require(attempt(statement,values),"disposable fixture SQL failed");
    }
    QVariant scalar(const QString &statement) {
        QSqlQuery query(db); require(query.exec(statement) && query.next(),"fixture scalar read failed");
        return query.value(0);
    }
};
using Rows = std::vector<QVariantList>;
Rows rows(const QString &path, const QString &table) {
    Sql db(path); QSqlQuery query(db.db);
    require(query.exec("SELECT id,label,path,folder,pinned,opened,folder_key FROM " + table + " ORDER BY id"),
            "cannot inspect typed fixture rows");
    Rows result;
    while (query.next()) {
        QVariantList row; for (int i = 0; i < 7; ++i) row.push_back(query.value(i)); result.push_back(row);
    }
    return result;
}
bool exact_rows(const Rows &a, const Rows &b) {
    if (a.size() != b.size()) return false;
    for (std::size_t row = 0; row < a.size(); ++row)
        for (qsizetype column = 0; column < a[row].size(); ++column)
            if (a[row][column].isNull() != b[row][column].isNull() ||
                (!a[row][column].isNull() && (a[row][column].metaType() != b[row][column].metaType() ||
                                             a[row][column] != b[row][column]))) return false;
    return true;
}
lmti::LibraryEntry entry(const QTemporaryDir &temp, const QString &id) {
    auto project = lmti::demo_project(); project.project.id = id.toStdString();
    project.project.label = ("Fixture " + id).toStdString();
    const auto path = temp.filePath(id + ".sqlite");
    project.topology.revision = lmti::save_project(path,project);
    return {id,QString::fromStdString(project.project.label),path,{}};
}
QString library(const QTemporaryDir &temp, const QString &name, const lmti::LibraryEntry &first) {
    const auto path = temp.filePath(name + ".sqlite"); lmti::remember_library_project(path,first); return path;
}
lmti::LibraryUpgradeStatus upgraded(const QString &path, const QString &backup_parent) {
    const auto before = lmti::inspect_project_library(path);
    const auto status = lmti::upgrade_project_library(path,backup_parent,before.token);
    check(status.state == lmti::LibraryUpgradeState::Upgraded && status.code == lmti::LibraryCode::None,
          "upgrade did not report completion");
    check(!status.operation_id.isEmpty() && QFileInfo(status.backup_path).isFile(),"upgrade lost retained backup identity");
    const auto current = lmti::inspect_project_library(path);
    check(current.token == status.library && current.token.schema == 2 && current.token.generation == 1 &&
          !current.token.library_uuid.isEmpty() && current.upgrade_operation_id == status.operation_id &&
          current.legacy_digest == before.token.digest,"committed upgrade identity differs from checked source");
    return status;
}
const lmti::LibraryEntry &find(const lmti::LibraryInspection &view, const QString &id) {
    const auto it = std::find_if(view.entries.begin(),view.entries.end(),[&](const auto &e) { return e.id == id; });
    require(it != view.entries.end(),"fixture entry unexpectedly absent"); return *it;
}
int child_count(const QString &path) { return QDir(path).entryList(QDir::NoDotAndDotDot | QDir::AllEntries).size(); }

void legacy_and_missing(const QTemporaryDir &temp) {
    const auto absent = temp.filePath("absent.sqlite");
    check(lmti::project_library(absent).empty() && !QFileInfo::exists(absent),"list created a missing library");
    rejects([&] { lmti::inspect_project_library(absent); },"inspection created a missing library");
    check(!QFileInfo::exists(absent),"failed inspection created a library");
    const auto a = entry(temp,"legacy-a"), b = entry(temp,"legacy-b");
    const auto path = library(temp,"legacy",a), root = parent(temp,"legacy-root");
    lmti::pin_library_project(path,a.id,true); lmti::link_library_folder(path,a.id,root);
    auto refreshed = a; refreshed.label = "Renamed fixture"; lmti::remember_library_project(path,refreshed);
    auto view = lmti::inspect_project_library(path);
    check(view.token.schema == 1 && view.token.generation == 0 && view.token.library_uuid.isEmpty(),"default library was implicitly upgraded");
    check(find(view,a.id).label == refreshed.label && find(view,a.id).pinned && find(view,a.id).folder == root,
          "legacy remember lost pin/root or label refresh");
    lmti::remember_library_project(path,b); lmti::forget_library_project(path,b.id);
    check(lmti::project_library(path).size() == 1,"legacy add/delete behavior changed");
    const auto catalog = temp.filePath("legacy-catalog.sqlite"), imported = temp.filePath("imported-library.sqlite");
    lmti::remember_project(catalog,{a.id,a.label,a.path}); lmti::import_recent_library(catalog,imported);
    check(lmti::inspect_project_library(imported).token.schema == 1 && lmti::project_library(imported).size() == 1,
          "legacy recent import changed default schema");
    const auto import_bytes = bytes(imported); lmti::import_recent_library(catalog,imported);
    check(bytes(imported) == import_bytes,"repeat legacy import wrote an existing library");
}

void nullable_backup(const QTemporaryDir &temp) {
    const auto a = entry(temp,"nullable-a"), b = entry(temp,"nullable-b"), c = entry(temp,"nullable-c");
    const auto path = library(temp,"nullable",a), backup_parent = parent(temp,"nullable-backups");
    lmti::remember_library_project(path,b); lmti::remember_library_project(path,c);
    {
        Sql db(path);
        db.exec("UPDATE library SET folder=NULL,folder_key=NULL,pinned=1,opened=41 WHERE id=?",{a.id});
        db.exec("UPDATE library SET folder='',folder_key='',pinned=0,opened=42 WHERE id=?",{b.id});
        db.exec("UPDATE library SET folder='',folder_key=NULL,pinned=0,opened=43 WHERE id=?",{c.id});
    }
    const auto before_rows = rows(path,"library"); const auto before_bytes = bytes(path);
    const auto before = lmti::inspect_project_library(path);
    check(bytes(path) == before_bytes && child_count(backup_parent) == 0,"v1 inspection mutated source or reserved backup");
    const auto status = upgraded(path,backup_parent);
    check(exact_rows(before_rows,rows(status.backup_path,"library")),"typed backup collapsed NULL/empty or changed a legacy field");
    check(exact_rows(before_rows,rows(path,"library_entries")),"upgrade changed original typed rows");
    check(lmti::inspect_project_library(status.backup_path).token.digest == before.token.digest,
          "reopened typed backup differs from source digest");
    check(QFileInfo(status.backup_path).fileName() == "library-v1.sqlite" &&
          QFileInfo(status.backup_path).dir().dirName() == status.operation_id && child_count(backup_parent) == 1,
          "backup did not use one fresh operation directory and fixed basename");
    check(!before_rows[0][3].isValid() || before_rows[0][3].isNull(),"NULL fixture was not SQL NULL");
    check(!before_rows[1][3].isNull() && before_rows[1][3].toString().isEmpty() &&
          before_rows[2][6].isNull(),"empty/NULL fixture did not exercise distinct cells");
}

void rejected_preflight(const QTemporaryDir &temp) {
    const auto a = entry(temp,"preflight-a");
    const QStringList changes{
        "CREATE TABLE extension(value TEXT)",
        "CREATE TABLE sqliteXextra(value TEXT)",
        "ALTER TABLE library ADD COLUMN extension TEXT",
        "CREATE INDEX extension ON library(opened)",
        "CREATE VIEW extension AS SELECT id FROM library",
        "CREATE TRIGGER extension AFTER UPDATE ON library BEGIN SELECT 1; END",
        "UPDATE library SET label=x'00'",
        "UPDATE library SET label=printf('%.*c',1025,'x')",
        "UPDATE library SET folder_key='unexpected'",
        "PRAGMA user_version=3",
        "PRAGMA application_id=1"
    };
    int index = 0;
    for (const auto &change : changes) {
        const auto name = "preflight-" + QString::number(++index);
        const auto path = library(temp,name,a), output = parent(temp,name + "-backups");
        const auto token = lmti::inspect_project_library(path).token;
        { Sql db(path); db.exec(change); }
        const auto before = bytes(path);
        rejects([&] { lmti::upgrade_project_library(path,output,token); },"unsafe preflight accepted an unknown/corrupt source");
        check(bytes(path) == before && child_count(output) == 0,"preflight refusal changed source bytes or reserved output");
    }
    const auto path = library(temp,"changed-preview",a), output = parent(temp,"changed-preview-backups");
    const auto token = lmti::inspect_project_library(path).token;
    lmti::pin_library_project(path,a.id,true); const auto before = bytes(path);
    rejects([&] { lmti::upgrade_project_library(path,output,token); },"changed full v1 snapshot accepted",lmti::LibraryCode::Conflict);
    check(bytes(path) == before && child_count(output) == 0,"stale migration reserved output or changed source");
}

void committed_wal_and_old_writer(const QTemporaryDir &temp) {
    const auto a = entry(temp,"wal-a"); const auto path = library(temp,"wal-library",a);
    const auto output = parent(temp,"wal-backups");
    Sql held(path); held.exec("PRAGMA journal_mode=WAL"); held.exec("PRAGMA wal_autocheckpoint=0");
    held.exec("BEGIN IMMEDIATE");
    held.exec("UPDATE library SET label='Committed in WAL',opened=123,pinned=1 WHERE id=?",{a.id});
    held.exec("COMMIT");
    const auto main_before = bytes(path), wal_before = bytes(path + "-wal");
    const auto expected = rows(path,"library"); const auto preview = lmti::inspect_project_library(path);
    check(!wal_before.isEmpty() && find(preview,a.id).label == "Committed in WAL", "WAL fixture did not expose committed data");
    check(bytes(path) == main_before && bytes(path + "-wal") == wal_before,"read preflight checkpointed or modified the held WAL");
    QSqlQuery old_statement(held.db);
    require(old_statement.prepare("UPDATE library SET path=? WHERE id=?"),"cannot prepare old writer before upgrade");
    old_statement.addBindValue(a.path); old_statement.addBindValue(a.id);
    const auto status = lmti::upgrade_project_library(path,output,preview.token);
    check(status.state == lmti::LibraryUpgradeState::Upgraded,"WAL library did not upgrade");
    check(exact_rows(expected,rows(status.backup_path,"library")),"backup omitted committed WAL fields");
    check(!old_statement.exec(),"preopened/prepared v1 writer changed renamed library"); old_statement.finish();
    check(!held.attempt("UPDATE library SET opened=999"),"new old-format SQL still found compatibility table/view");
    check(held.scalar("PRAGMA user_version").toInt() == 2,"old-format version check could still accept migrated library");
    check(exact_rows(expected,rows(path,"library_entries")),"old writer altered migrated rows");
}

void upgrade_faults(const QTemporaryDir &temp) {
    int index = 0;
    for (const auto fault : {lmti::LibraryTestFault::AfterBackupVerification,
                             lmti::LibraryTestFault::BeforeUpgradeCommit,
                             lmti::LibraryTestFault::AfterUpgradeCommit}) {
        const auto name = "upgrade-fault-" + QString::number(++index);
        const auto a = entry(temp,name); const auto path = library(temp,name + "-library",a);
        const auto output = parent(temp,name + "-backups");
        const auto before = lmti::inspect_project_library(path); const auto before_rows = rows(path,"library");
        lmti::set_library_test_fault(fault);
        const auto status = lmti::upgrade_project_library(path,output,before.token);
        lmti::set_library_test_fault(lmti::LibraryTestFault::None);
        check(status.state == lmti::LibraryUpgradeState::RecoveryRequired &&
              status.code == lmti::LibraryCode::RecoveryRequired && !status.operation_id.isEmpty() &&
              QFileInfo(status.backup_path).isFile() && child_count(output) == 1,
              "upgrade failure lost operation/backup or falsely reported success");
        check(exact_rows(before_rows,rows(status.backup_path,"library")),"retained failure backup is incomplete");
        const auto current = lmti::inspect_project_library(path);
        if (fault == lmti::LibraryTestFault::AfterUpgradeCommit) {
            check(current.token.schema == 2 && current.token.generation == 1 && current.token == status.library &&
                  current.upgrade_operation_id == status.operation_id && current.legacy_digest == before.token.digest,
                  "actual post-COMMIT failure could not be reconciled from native identity");
            check(exact_rows(before_rows,rows(path,"library_entries")),"post-COMMIT outcome lost migrated rows");
        } else {
            check(current.token == before.token && exact_rows(before_rows,rows(path,"library")),
                  "pre-COMMIT failure left partial migration");
        }
        const auto source_bytes = bytes(path), backup_bytes = bytes(status.backup_path);
        (void)lmti::inspect_project_library(path); (void)lmti::inspect_project_library(path);
        check(bytes(path) == source_bytes && bytes(status.backup_path) == backup_bytes && child_count(output) == 1,
              "outcome inspection retried migration, deleted backup or wrote state");
    }
}

void cas_and_stale_qt(const QTemporaryDir &temp) {
    auto a = entry(temp,"cas-a"); const auto b = entry(temp,"cas-b");
    const auto root_a = parent(temp,"cas-root-a"), root_b = parent(temp,"cas-root-b"); a.folder = root_a; a.pinned = true;
    const auto path = library(temp,"cas-library",a); upgraded(path,parent(temp,"cas-backups"));
    auto token = lmti::inspect_project_library(path).token;
    auto refresh = a; refresh.folder.clear(); refresh.label = "Cosmetic refresh"; refresh.pinned = false;
    lmti::remember_library_project(path,refresh); lmti::link_library_folder(path,a.id,root_a);
    auto view = lmti::inspect_project_library(path);
    check(view.token == token && find(view,a.id).pinned && find(view,a.id).folder == root_a &&
          find(view,a.id).label == refresh.label,"same-binding Qt refresh changed binding/pin/root");
    lmti::pin_library_project(path,a.id,false);
    check(lmti::inspect_project_library(path).token == token,"cosmetic pin invalidated binding token");
    check(lmti::link_library_folder_cas(path,a.id,root_a,token) == token,"identical-root CAS advanced generation");
    const auto origin = token;
    token = lmti::link_library_folder_cas(path,a.id,root_b,token);
    check(token.generation == origin.generation + 1,"root CAS did not increment exactly once");
    const auto changed = token;
    // The actual Qt sequence omits folder in remember(), then links its retained root.
    lmti::remember_library_project(path,refresh);
    rejects([&] { lmti::link_library_folder(path,a.id,root_a); },"stale Qt root silently reselected old authority",lmti::LibraryCode::Conflict);
    check(lmti::inspect_project_library(path).token == changed,"stale Qt link changed binding generation/root");
    token = lmti::link_library_folder_cas(path,a.id,root_a,token);
    check(token.digest == origin.digest && token.generation == origin.generation + 2 && token.library_uuid == origin.library_uuid,
          "root ABA fixture did not restore same bindings with advanced generation");
    rejects([&] { lmti::forget_library_project_cas(path,a.id,origin); },"ABA accepted obsolete token",lmti::LibraryCode::Conflict);
    auto wrong_path = refresh; wrong_path.path = b.path;
    rejects([&] { lmti::remember_library_project(path,wrong_path); },"automatic remember replaced existing database path",lmti::LibraryCode::Conflict);
    rejects([&] { lmti::forget_library_project(path,a.id); },"legacy delete bypassed v2 CAS",lmti::LibraryCode::Conflict);
    const auto before_delete = token;
    token = lmti::forget_library_project_cas(path,a.id,token);
    check(token.generation == before_delete.generation + 1 && lmti::project_library(path).empty(),"CAS delete was not one authority transition");
    rejects([&] { lmti::remember_library_project(path,refresh); },"stale Qt remember resurrected deleted entry",lmti::LibraryCode::Conflict);
    check(lmti::project_library(path).empty() && lmti::inspect_project_library(path).token == token,"failed resurrection changed library");
    rejects([&] { lmti::register_library_project_cas(path,a,before_delete); },"stale token re-added deleted entry",lmti::LibraryCode::Conflict);
    token = lmti::register_library_project_cas(path,a,token);
    check(token.generation == before_delete.generation + 2 && lmti::project_library(path).size() == 1,"reviewed re-add failed to advance generation");
    rejects([&] { lmti::register_library_project_cas(path,a,token); },"existing-ID register became path replacement",lmti::LibraryCode::Conflict);
    auto mismatch = b; mismatch.id = "wrong-native-id";
    rejects([&] { lmti::register_library_project_cas(path,mismatch,token); },"register accepted mismatched native project ID");
}

void identity_and_bad_tokens(const QTemporaryDir &temp) {
    const auto a = entry(temp,"identity-a");
    const auto path = library(temp,"identity-library",a), other = library(temp,"identity-other",a);
    upgraded(path,parent(temp,"identity-backups-a")); upgraded(other,parent(temp,"identity-backups-b"));
    const auto original = lmti::inspect_project_library(path).token;
    const auto replacement = lmti::inspect_project_library(other).token;
    check(original.digest == replacement.digest && original.generation == replacement.generation &&
          original.library_uuid != replacement.library_uuid,"replacement fixture did not isolate library identity");
    require(QFile::remove(path) && QFile::rename(other,path),"cannot replace disposable library at the same path");
    const auto current = lmti::inspect_project_library(path).token; const auto before_bytes = bytes(path);
    rejects([&] { lmti::forget_library_project_cas(path,a.id,original); },"same-path UUID replacement accepted old token",lmti::LibraryCode::Conflict);
    check(bytes(path) == before_bytes && lmti::inspect_project_library(path).token == current,"replacement refusal modified current library");
    const std::vector<std::function<void(lmti::LibraryToken &)>> corruptions{
        [](auto &t) { t.digest = "bad"; }, [](auto &t) { t.library_uuid = "bad"; },
        [](auto &t) { t.generation = 0; }, [](auto &t) { t.generation = 9007199254740992LL; },
        [](auto &t) { t.schema = 4; }
    };
    for (const auto &corrupt : corruptions) {
        auto invalid = current; corrupt(invalid);
        rejects([&] { lmti::forget_library_project_cas(path,a.id,invalid); },"malformed token accepted",lmti::LibraryCode::InvalidInput);
    }
    auto wrong = current; wrong.canonical_path = folder_key(temp.filePath("different-library.sqlite"));
    rejects([&] { lmti::forget_library_project_cas(path,a.id,wrong); },"wrong canonical library path accepted",lmti::LibraryCode::Conflict);
    check(bytes(path) == before_bytes,"invalid token attempts changed stored state");
}

void cas_failure_and_limits(const QTemporaryDir &temp) {
    auto a = entry(temp,"limits-a"), b = entry(temp,"limits-b");
    const auto root_a = parent(temp,"limits-root-a"), root_b = parent(temp,"limits-root-b");
    a.folder = root_a; b.folder = root_b;
    const auto path = library(temp,"limits-library",a); lmti::remember_library_project(path,b);
    upgraded(path,parent(temp,"limits-backups"));
    auto token = lmti::inspect_project_library(path).token;
    const auto original_rows = rows(path,"library_entries");
    rejects([&] { lmti::link_library_folder_cas(path,b.id,root_a,token); },"duplicate folder authority accepted");
    check(lmti::inspect_project_library(path).token == token && exact_rows(original_rows,rows(path,"library_entries")),
          "failed CAS uniqueness check changed generation or bindings");
    lmti::set_library_test_fault(lmti::LibraryTestFault::BeforeMutationCommit);
    rejects([&] { lmti::forget_library_project_cas(path,b.id,token); },"pre-COMMIT CAS fault did not fail",lmti::LibraryCode::RecoveryRequired);
    lmti::set_library_test_fault(lmti::LibraryTestFault::None);
    check(lmti::inspect_project_library(path).token == token && exact_rows(original_rows,rows(path,"library_entries")),
          "pre-COMMIT CAS did not rollback rows and generation together");
    lmti::set_library_test_fault(lmti::LibraryTestFault::AfterMutationCommit);
    rejects([&] { lmti::forget_library_project_cas(path,b.id,token); },"post-COMMIT CAS fault did not report unknown outcome",lmti::LibraryCode::RecoveryRequired);
    lmti::set_library_test_fault(lmti::LibraryTestFault::None);
    const auto committed = lmti::inspect_project_library(path);
    check(committed.token.generation == token.generation + 1 && committed.entries.size() == 1,
          "post-COMMIT CAS inspection missed the committed transition");
    rejects([&] { lmti::forget_library_project_cas(path,b.id,token); },"old token retried a committed unknown outcome",lmti::LibraryCode::Conflict);
    { Sql db(path); db.exec("UPDATE library_identity SET binding_generation=9007199254740990"); }
    token = lmti::inspect_project_library(path).token;
    token = lmti::link_library_folder_cas(path,a.id,root_b,token);
    check(token.generation == 9007199254740991LL,"last safe generation could not be produced and reopened");
    const auto ceiling_bytes = bytes(path);
    rejects([&] { lmti::forget_library_project_cas(path,a.id,token); },"generation overflow accepted",lmti::LibraryCode::BudgetExceeded);
    check(bytes(path) == ceiling_bytes && lmti::inspect_project_library(path).token == token,"overflow mutated generation or row");
    check(lmti::link_library_folder_cas(path,a.id,root_b,token) == token,"identical no-op at ceiling failed or advanced generation");
    lmti::pin_library_project(path,a.id,true);
    check(lmti::inspect_project_library(path).token == token,"cosmetic update at ceiling changed authority token");
    { Sql db(path); db.exec("CREATE TABLE sqliteXextra(value TEXT)"); }
    const auto invalid_bytes = bytes(path);
    rejects([&] { lmti::pin_library_project(path,a.id,false); },"v2 writer ignored new unsupported table",lmti::LibraryCode::UnsupportedFormat);
    rejects([&] { lmti::forget_library_project_cas(path,a.id,token); },"CAS ignored new unsupported table",lmti::LibraryCode::UnsupportedFormat);
    check(bytes(path) == invalid_bytes,"unsupported-format writer changed bytes");
    rejects([&] { lmti::inspect_project_library(path); },"v2 read accepted wildcard-hidden extension table",lmti::LibraryCode::UnsupportedFormat);
}

void downgrade_control_table(const QTemporaryDir &temp) {
    const auto a = entry(temp,"downgrade-a");
    const auto path = library(temp,"downgrade-library",a);
    const auto output = parent(temp,"downgrade-backups"); upgraded(path,output);
    {
        Sql db(path);
        db.exec("ALTER TABLE library_identity RENAME TO temporary_identity");
        db.exec("ALTER TABLE temporary_identity RENAME TO LIBRARY_IDENTITY");
        db.exec("ALTER TABLE library_entries RENAME TO library");
        db.exec("PRAGMA user_version=1");
    }
    const auto before_bytes = bytes(path); const auto count = child_count(output);
    rejects([&] { lmti::inspect_project_library(path); },"case-renamed control table passed v1 downgrade guard",lmti::LibraryCode::UnsupportedFormat);
    rejects([&] { lmti::remember_library_project(path,a); },"legacy writer accepted downgraded control schema",lmti::LibraryCode::UnsupportedFormat);
    check(bytes(path) == before_bytes && child_count(output) == count,"downgrade refusal changed library or backups");
}

void corrupt_stored_identity(const QTemporaryDir &temp) {
    const auto a = entry(temp,"stored-identity-a");
    const QStringList mutations{
        "UPDATE library_identity SET library_uuid='invalid'",
        "UPDATE library_identity SET upgrade_operation_id='invalid'",
        "UPDATE library_identity SET legacy_digest='invalid'",
        "UPDATE library_identity SET binding_generation=0",
        "UPDATE library_identity SET binding_generation=9007199254740992",
        "INSERT INTO library_identity SELECT 2,library_uuid,binding_generation,upgrade_operation_id,legacy_digest FROM library_identity"
    };
    int index = 0;
    for (const auto &mutation : mutations) {
        const auto name = "stored-identity-" + QString::number(++index);
        const auto path = library(temp,name,a);
        upgraded(path,parent(temp,name + "-backups"));
        const auto token = lmti::inspect_project_library(path).token;
        {
            Sql db(path);
            db.exec("PRAGMA ignore_check_constraints=ON"); // Corrupt this disposable fixture only.
            db.exec(mutation);
        }
        const auto before = bytes(path);
        rejects([&] { lmti::inspect_project_library(path); },"corrupt stored library identity was readable",lmti::LibraryCode::UnsupportedFormat);
        rejects([&] { lmti::pin_library_project(path,a.id,true); },"cosmetic writer accepted corrupt stored identity",lmti::LibraryCode::UnsupportedFormat);
        rejects([&] { lmti::forget_library_project_cas(path,a.id,token); },"CAS accepted corrupt stored identity",lmti::LibraryCode::UnsupportedFormat);
        check(bytes(path) == before,"identity refusal repaired or changed corrupt storage");
    }
}

void capacity(const QTemporaryDir &temp) {
    const auto a = entry(temp,"capacity-a"), b = entry(temp,"capacity-new");
    const auto path = library(temp,"capacity-library",a);
    {
        Sql db(path); db.exec("BEGIN IMMEDIATE");
        for (int i = 1; i < 500; ++i)
            db.exec("INSERT INTO library VALUES(?,?,?,NULL,0,0,NULL)",
                    {QString("capacity-%1").arg(i),"Offline fixture",temp.filePath(QString("offline-%1.sqlite").arg(i))});
        db.exec("COMMIT");
    }
    upgraded(path,parent(temp,"capacity-backups"));
    const auto token = lmti::inspect_project_library(path).token; const auto before_bytes = bytes(path);
    check(lmti::project_library(path).size() == 500,"capacity fixture not at exact limit");
    rejects([&] { lmti::register_library_project_cas(path,b,token); },"over-capacity registration accepted",lmti::LibraryCode::BudgetExceeded);
    check(bytes(path) == before_bytes && lmti::inspect_project_library(path).token == token,"capacity refusal inserted row or advanced generation");
}

void path_boundaries(const QTemporaryDir &temp) {
    const auto a = entry(temp,"path-a"); const auto path = library(temp,"path-library",a);
    const auto output = parent(temp,"path-backups"); const auto token = lmti::inspect_project_library(path).token;
    const auto before_bytes = bytes(path);
    const QStringList invalid{"//invalid.invalid/share/library.sqlite", "\\\\?\\C:\\fixture\\library.sqlite",
                              "\\\\.\\C:\\fixture\\library.sqlite", path + ":stream", path + QChar(1)};
    for (const auto &bad : invalid) {
        rejects([&] { lmti::inspect_project_library(bad); },"unsafe raw library path was accepted");
        rejects([&] { lmti::upgrade_project_library(path,bad,token); },"unsafe backup parent was accepted");
        const auto missing_destination = temp.filePath("unsafe-catalog-import.sqlite");
        rejects([&] { lmti::import_recent_library(bad,missing_destination); },"unsafe legacy catalog source was accepted");
        check(!QFileInfo::exists(missing_destination),"unsafe catalog import created destination");
    }
    const auto private_root = parent(temp,".lmti");
    rejects([&] { lmti::upgrade_project_library(path,private_root,token); },"backup entered independent .lmti layer");
    check(bytes(path) == before_bytes && child_count(output) == 0 && child_count(private_root) == 0,
          "path refusal changed source or reserved artifacts");
}

void qt_derived_default_path(const QTemporaryDir &temp) {
    const auto install = parent(temp,"qt-install");
    require(QDir(install).mkdir("bin") && QDir(install).mkdir("data"),"cannot create default-path fixture");
    const auto application_directory = QDir(install).filePath("bin");
    const auto directory = QDir(application_directory).absoluteFilePath("../data");
    const auto catalog = QDir(directory).absoluteFilePath("projects-catalog.sqlite");
    const auto derived = QDir(QFileInfo(catalog).absolutePath()).filePath("project-library.sqlite");
    check(lmti::project_library(derived).empty() && !QFileInfo::exists(derived),
          "actual Qt default path derivation was rejected or empty listing created storage");
}

void concurrent_snapshot(const QTemporaryDir &temp) {
    const auto a = entry(temp,"concurrent-a"), b = entry(temp,"concurrent-b");
    const auto path = library(temp,"concurrent-library",a); lmti::remember_library_project(path,b);
    upgraded(path,parent(temp,"concurrent-backups"));
    { Sql db(path); db.exec("UPDATE library_entries SET label='Pair 1'"); }
    Sql held(path); held.exec("PRAGMA journal_mode=WAL"); held.exec("PRAGMA wal_autocheckpoint=0");
    std::atomic<bool> started = false, done = false, writer_ok = true, stop = false;
    std::atomic<int> commits = 0;
    auto *writer = QThread::create([&] {
        try {
            Sql db(path); started = true;
            for (int i = 2; i <= 41 && !stop; ++i) {
                db.exec("BEGIN IMMEDIATE");
                db.exec("UPDATE library_identity SET binding_generation=?",{i});
                db.exec("UPDATE library_entries SET label=?",{QString("Pair %1").arg(i)});
                db.exec("COMMIT"); ++commits; QThread::msleep(2);
            }
        } catch (...) { writer_ok = false; started = true; }
        done = true;
    });
    writer->start();
    // Bounded startup; no indefinite polling if a fixture connection fails.
    for (int i = 0; i < 2000 && !started; ++i) QThread::msleep(1);
    int overlapping_reads = 0;
    try {
        check(started,"concurrent writer did not start");
        for (int i = 0; i < 60; ++i) {
            if (!done) ++overlapping_reads;
            const auto view = lmti::inspect_project_library(path);
            check(view.entries.size() == 2,"concurrent snapshot lost an entry");
            for (const auto &e : view.entries)
                check(e.label == QString("Pair %1").arg(view.token.generation),
                      "token and rows came from different committed snapshots");
            QThread::msleep(1);
        }
    } catch (...) {
        stop = true;
        if (!writer->wait(10000)) {
            std::cerr << "Concurrent fixture cleanup exceeded its deadline\n";
            std::exit(1); // Fail without killing/retrying any production writer.
        }
        delete writer; throw;
    }
    const bool finished = writer->wait(10000);
    check(finished,"concurrent writer exceeded bounded fixture deadline");
    if (!finished) {
        stop = true;
        if (!writer->wait(10000)) {
            std::cerr << "Concurrent fixture cleanup exceeded its deadline\n";
            std::exit(1); // Preserve disposable artifacts on failed cleanup.
        }
    }
    delete writer;
    check(writer_ok && commits == 40 && overlapping_reads > 0,"concurrent fixture did not exercise reads while writes ran");
}
} // namespace

int main(int argc, char **argv) {
    QCoreApplication app(argc,argv); QTemporaryDir temp;
    if (!temp.isValid()) return 1;
    try {
        legacy_and_missing(temp); nullable_backup(temp); rejected_preflight(temp);
        committed_wal_and_old_writer(temp); upgrade_faults(temp); cas_and_stale_qt(temp);
        identity_and_bad_tokens(temp); cas_failure_and_limits(temp); downgrade_control_table(temp);
        corrupt_stored_identity(temp); capacity(temp);
        path_boundaries(temp); qt_derived_default_path(temp); concurrent_snapshot(temp);
    } catch (const std::exception &error) {
        lmti::set_library_test_fault(lmti::LibraryTestFault::None);
        std::cerr << "Unexpected library test fixture failure: " << error.what() << '\n'; return 1;
    }
    std::cout << "Library core: exact typed backups, WAL snapshots, upgrade outcomes, generations and stale writers checked\n";
    return failures ? 1 : 0;
}
