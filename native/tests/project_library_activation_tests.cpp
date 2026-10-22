#include "lmti/project_library.hpp"
#include <QCoreApplication>
#include <QDir>
#include <QFile>
#include <QFileInfo>
#include <QSqlDatabase>
#include <QSqlQuery>
#include <QSqlRecord>
#include <QStringList>
#include <QTemporaryDir>
#include <QUuid>
#include <QVariant>
#include <algorithm>
#include <functional>
#include <iostream>
#include <optional>
#include <stdexcept>

#ifndef LMTI_LIBRARY_CORE_TEST_HOOKS
#error Compile only in the isolated activation test executable with real owner sources.
#endif

namespace {
int failures = 0;
void check(bool ok,const char *message) { if (!ok) { std::cerr << message << '\n'; ++failures; } }
void require(bool ok,const char *message) { if (!ok) throw std::runtime_error(message); }
void rejects(const std::function<void()> &call,const char *message,std::optional<lmti::LibraryCode> code = {}) {
    try { call(); check(false,message); }
    catch (const lmti::LibraryError &error) {
        check(!code || error.code == *code,message);
        check(QByteArray(error.what()) == "Library operation was refused.","library error disclosed private details");
    } catch (const lmti::Error &) { check(!code,"operation bypassed typed refusal contract"); }
}
QByteArray bytes(const QString &path) {
    QFile file(path); require(file.open(QIODevice::ReadOnly),"cannot read disposable fixture"); return file.readAll();
}
QString mkdir(const QString &path,const QString &name) {
    require(QDir(path).mkdir(name),"cannot reserve fixture directory"); return QDir(path).filePath(name);
}
QString key(QString path) {
    path = QDir::cleanPath(QDir::fromNativeSeparators(path));
#ifdef Q_OS_WIN
    path = path.toCaseFolded();
#endif
    return path;
}
int children(const QString &path) { return QDir(path).entryList(QDir::NoDotAndDotDot | QDir::AllEntries).size(); }
QString uuid() { return QUuid::createUuid().toString(QUuid::WithoutBraces); }
// Fixture-only SQL/rename/remove below never targets files outside QTemporaryDir.
class Sql {
    QString connection_ = uuid();
  public:
    QSqlDatabase db;
    explicit Sql(const QString &path) {
        db = QSqlDatabase::addDatabase("QSQLITE",connection_); db.setDatabaseName(path);
        db.setConnectOptions("QSQLITE_BUSY_TIMEOUT=2000"); require(db.open(),"fixture database open failed");
    }
    ~Sql() { db.close(); db = {}; QSqlDatabase::removeDatabase(connection_); }
    void exec(const QString &statement,const QVariantList &values = {}) {
        QSqlQuery q(db); require(q.prepare(statement),"fixture SQL prepare failed");
        for (const auto &v : values) q.addBindValue(v);
        require(q.exec(),"fixture SQL execution failed");
    }
};
using Rows = std::vector<QVariantList>;
Rows query(const QString &path,const QString &sql) {
    Sql db(path); QSqlQuery q(db.db); require(q.exec(sql),"fixture inspection failed"); Rows result;
    while (q.next()) {
        QVariantList row; for (int i = 0; i < q.record().count(); ++i) row.push_back(q.value(i)); result.push_back(row);
    }
    return result;
}
Rows entries(const QString &path) {
    return query(path,"SELECT id,label,path,folder,pinned,opened,folder_key FROM library_entries ORDER BY id");
}
Rows identity_v2(const QString &path) {
    return query(path,"SELECT singleton,library_uuid,binding_generation,upgrade_operation_id,legacy_digest FROM library_identity");
}
bool exact(const Rows &a,const Rows &b) {
    if (a.size() != b.size()) return false;
    for (std::size_t i = 0; i < a.size(); ++i) {
        if (a[i].size() != b[i].size()) return false;
        for (qsizetype j = 0; j < a[i].size(); ++j)
            if (a[i][j].isNull() != b[i][j].isNull() || (!a[i][j].isNull() &&
                (a[i][j].metaType() != b[i][j].metaType() || a[i][j] != b[i][j]))) return false;
    }
    return true;
}
lmti::LibraryActivationReceipt successful(const lmti::LibraryActivationStatus &status,lmti::LibraryActivationState state) {
    require(status.code == lmti::LibraryCode::None && status.receipt.has_value(),"owner did not return a committed receipt");
    check(status.receipt->state == state && status.operation_id == status.receipt->token.operation_id,
          "committed result state/operation differs from receipt");
    return *status.receipt;
}
struct Fixture {
    QString base,source,library,copy_parent,backups,root,id = "activation-project";
    lmti::ProjectCopyStatus copy;
    lmti::LibraryToken v2;
    Fixture(const QTemporaryDir &temp,const QString &name,bool structured = false,bool format3 = true,bool make_copy = true) {
        base = mkdir(temp.path(),name); source = QDir(base).filePath("source.sqlite");
        library = QDir(base).filePath("library.sqlite"); copy_parent = mkdir(base,"copies");
        backups = mkdir(base,"backups"); root = mkdir(base,"project-root");
        auto d = lmti::demo_project(); d.project.id = id.toStdString(); d.project.label = "Activation fixture";
        if (structured) {
            d.structure.emplace(); d.structure->sites = {{"factory-demo","Factory",lmti::Privacy::Internal}};
            d.components.push_back({"retired-unit","Retired unit","",lmti::ComponentKind::Library,lmti::Privacy::Internal});
        }
        d.topology.revision = lmti::save_project(source,d);
        if (structured) {
            std::erase_if(d.components,[](const auto &c) { return c.id == "retired-unit"; });
            d.topology.revision = lmti::save_project(source,d);
        }
        lmti::remember_library_project(library,{id,"Activation fixture",source,root,true,0});
        const auto upgrade = lmti::upgrade_project_library(library,backups,lmti::inspect_project_library(library).token);
        require(upgrade.state == lmti::LibraryUpgradeState::Upgraded,"fixture v1 upgrade failed");
        v2 = lmti::inspect_project_library(library).token;
        if (format3) to_v3();
        if (make_copy) {
            const auto mode = structured ? lmti::ProjectCopyMode::CloneV2 : lmti::ProjectCopyMode::MigrateV1;
            copy = lmti::prepare_project_copy(source,copy_parent,lmti::inspect_project_copy(source,mode));
            require(copy.state == lmti::ProjectCopyState::Prepared && copy.verified_receipt,"native copy fixture failed");
        }
    }
    lmti::LibraryUpgradeStatus to_v3() const {
        const auto status = lmti::upgrade_library_activation_format(library,backups,lmti::inspect_library_activation_upgrade(library));
        require(status.state == lmti::LibraryUpgradeState::Upgraded,"fixture activation format upgrade failed"); return status;
    }
    QString target() const { return QDir(QDir(copy_parent).filePath(copy.operation_id)).filePath("project.sqlite"); }
    lmti::LibraryActivationPreview candidate() const {
        return lmti::inspect_library_activation_candidate(library,id,copy_parent,copy.operation_id);
    }
    lmti::LibraryActivationReceipt prepare() const {
        return successful(lmti::prepare_library_activation(library,copy_parent,candidate()),lmti::LibraryActivationState::Prepared);
    }
    lmti::LibraryActivationInspection inspect(const lmti::LibraryActivationReceipt &receipt) const {
        return lmti::inspect_library_activation(library,copy_parent,receipt.token.library_uuid,receipt.token.operation_id);
    }
};

void format_backup_wal(const QTemporaryDir &temp) {
    Fixture f(temp,"format-wal",false,false,false);
    {
        Sql db(f.library);
        db.exec("UPDATE library_entries SET folder=NULL,folder_key=NULL,pinned=1,opened=19");
        db.exec("INSERT INTO library_entries VALUES('empty-root','Empty root',?,'',0,20,'')",{QDir(f.base).filePath("offline.sqlite")});
        db.exec("INSERT INTO library_entries VALUES('mixed-root','Mixed root',?,'',1,21,NULL)",{QDir(f.base).filePath("other-offline.sqlite")});
    }
    Sql held(f.library); held.exec("PRAGMA journal_mode=WAL"); held.exec("PRAGMA wal_autocheckpoint=0");
    held.exec("BEGIN IMMEDIATE"); held.exec("UPDATE library_entries SET label='Committed WAL cosmetic',opened=222 WHERE id=?",{f.id}); held.exec("COMMIT");
    const auto main = bytes(f.library), wal = bytes(f.library + "-wal");
    const auto before_entries = entries(f.library), before_identity = identity_v2(f.library);
    const auto preview = lmti::inspect_library_activation_upgrade(f.library);
    check(!wal.isEmpty() && bytes(f.library) == main && bytes(f.library + "-wal") == wal,
          "format preview modified/checkpointed held WAL");
    const auto status = lmti::upgrade_library_activation_format(f.library,f.backups,preview);
    require(status.state == lmti::LibraryUpgradeState::Upgraded && status.code == lmti::LibraryCode::None,"WAL format upgrade failed");
    check(QFileInfo(status.backup_path).fileName() == "library-v2.sqlite" && QFileInfo(status.backup_path).dir().dirName() == status.operation_id,
          "v2 backup escaped fixed operation path");
    check(exact(before_entries,entries(status.backup_path)) && exact(before_identity,identity_v2(status.backup_path)),
          "full typed v2 backup lost NULL/empty, WAL cosmetics or original identity receipt");
    check(lmti::inspect_library_activation_upgrade(status.backup_path).full_snapshot_digest == preview.full_snapshot_digest,
          "closed/reopened v2 backup differs from full reviewed digest");
    const auto current = lmti::inspect_project_library(f.library);
    check(current.token.schema == 3 && current.token.library_uuid == preview.source.library_uuid &&
          current.token.generation == preview.source.generation && current.token.digest == preview.source.digest &&
          current.activation_format_operation_id == status.operation_id &&
          current.activation_format_backup_digest == preview.full_snapshot_digest &&
          exact(before_entries,entries(f.library)) && exact(before_identity,identity_v2(f.library)),
          "format upgrade changed authority/owned fields or lost its verified backup receipt");
    rejects([&] { lmti::forget_library_project_cas(f.library,f.id,preview.source); },"old schema-2 token accepted after format upgrade");
    check(lmti::list_library_activations(f.library).empty(),"format upgrade invented activation history");
}

void format_preview_and_failures(const QTemporaryDir &temp) {
    Fixture stale(temp,"format-stale",false,false,false);
    const auto preview = lmti::inspect_library_activation_upgrade(stale.library);
    lmti::pin_library_project(stale.library,stale.id,false);
    const auto current = lmti::inspect_library_activation_upgrade(stale.library);
    check(current.source == preview.source && current.full_snapshot_digest != preview.full_snapshot_digest,
          "full format preview did not distinguish cosmetics from authority");
    const auto before = bytes(stale.library); const auto count = children(stale.backups);
    rejects([&] { lmti::upgrade_library_activation_format(stale.library,stale.backups,preview); },"stale full format preview accepted",lmti::LibraryCode::Conflict);
    check(bytes(stale.library) == before && children(stale.backups) == count,"stale format preview wrote source/reserved backup");
    int i = 0;
    for (const auto fault : {lmti::LibraryTestFault::AfterFormatBackupVerification,lmti::LibraryTestFault::BeforeFormatCommit,
                             lmti::LibraryTestFault::AfterFormatCommit}) {
        Fixture f(temp,"format-fault-" + QString::number(++i),false,false,false);
        const auto expected = lmti::inspect_library_activation_upgrade(f.library);
        const auto owned_rows = entries(f.library), owned_identity = identity_v2(f.library);
        lmti::set_library_test_fault(fault);
        const auto status = lmti::upgrade_library_activation_format(f.library,f.backups,expected);
        lmti::set_library_test_fault(lmti::LibraryTestFault::None);
        check(status.state == lmti::LibraryUpgradeState::RecoveryRequired && status.code == lmti::LibraryCode::RecoveryRequired &&
              !status.operation_id.isEmpty() && QFileInfo(status.backup_path).isFile(),"format fault discarded backup/operation or reported success");
        check(exact(owned_rows,entries(status.backup_path)) && exact(owned_identity,identity_v2(status.backup_path)),
              "retained format failure backup lost typed data");
        const auto readback = lmti::inspect_project_library(f.library);
        if (fault == lmti::LibraryTestFault::AfterFormatCommit)
            check(readback.token.schema == 3 && readback.activation_format_operation_id == status.operation_id &&
                  readback.activation_format_backup_digest == expected.full_snapshot_digest,
                  "actual post-format-COMMIT failure was not durably identifiable");
        else check(readback.token == expected.source,"pre-format-COMMIT failure left migrated state");
        const auto source_bytes = bytes(f.library), backup_bytes = bytes(status.backup_path);
        const auto directory_count = children(f.backups);
        (void)lmti::inspect_project_library(f.library);
        check(bytes(f.library) == source_bytes && bytes(status.backup_path) == backup_bytes && children(f.backups) == directory_count,
              "format reconciliation wrote, retried or deleted backup");
    }
}

void complete_lifecycle(const QTemporaryDir &temp,bool structured) {
    Fixture f(temp,structured ? "clone-lifecycle" : "migration-lifecycle",structured);
    const auto source_before = bytes(f.source), target_before = bytes(f.target()), library_before = bytes(f.library);
    const auto reviewed = f.candidate();
    check(bytes(f.library) == library_before && reviewed.source == f.copy.source && reviewed.target == f.copy.target &&
          reviewed.seeds_internal_sites == !structured && reviewed.mode == f.copy.mode,"candidate changed state or lost native copy identity/policy");
    const auto first = successful(lmti::prepare_library_activation(f.library,f.copy_parent,reviewed),lmti::LibraryActivationState::Prepared);
    const auto second = f.prepare(); // Preparation receipts do not change binding authority.
    check(first.prepared == reviewed && first.token.revision == 1 && first.activated_generation == 0 &&
          first.source_folder == std::optional<QString>(f.root) &&
          first.source_folder_key == std::optional<QString>(key(f.root)) &&
          lmti::inspect_project_library(f.library).token == reviewed.library &&
          f.inspect(first).condition == lmti::LibraryActivationCondition::PreparedCurrent,
          "preparation changed authority or lost exact immutable prepared token/root");
    {
        Sql db(f.library); db.exec("UPDATE library_entries SET label='Latest cosmetic',pinned=0,opened=777 WHERE id=?",{f.id});
    }
    const auto cosmetics = entries(f.library);
    check(f.inspect(first).condition == lmti::LibraryActivationCondition::PreparedCurrent,
          "cosmetics incorrectly made prepared authority stale");
    const auto result = successful(lmti::activate_library_copy(f.library,f.copy_parent,first.token),lmti::LibraryActivationState::Activated);
    const auto after = lmti::inspect_project_library(f.library); auto expected_rows = cosmetics;
    expected_rows[0][2] = reviewed.target.canonical_path;
    check(result.token.revision == 2 && result.prepared == reviewed && result.activated_generation == reviewed.library.generation + 1 &&
          after.token.generation == reviewed.library.generation + 1 && exact(expected_rows,entries(f.library)),
          "activation failed to change only selected path/generation/receipt while preserving cosmetics/root");
    check(bytes(f.source) == source_before && bytes(f.target()) == target_before,"library lifecycle changed source/target project bytes");
    const auto current = f.inspect(result);
    check(current.condition == lmti::LibraryActivationCondition::ActivatedCurrent && current.receipt == result &&
          current.receipt.prepared.library.canonical_path == reviewed.library.canonical_path &&
          current.receipt.prepared.library.schema == 3,"reopened receipt lost prepared library path/schema or current state");
    const auto stable_bytes = bytes(f.library);
    rejects([&] { lmti::activate_library_copy(f.library,f.copy_parent,first.token); },"old prepared token reactivated committed operation");
    rejects([&] { lmti::abandon_library_activation(f.library,first.token); },"stale token abandoned activated history");
    check(bytes(f.library) == stable_bytes,"replayed transition wrote library");
    check(f.inspect(second).condition == lmti::LibraryActivationCondition::PreparedStale,
          "concurrent prepared receipt ignored activation generation change");
    // Old Qt window still holds the source path; it must never reverse cutover.
    rejects([&] { lmti::remember_library_project(f.library,{f.id,"Old window",f.source,{}}); },"stale Qt remember reversed activation");
    lmti::remember_library_project(f.library,{f.id,"Current window",f.target(),{}});
    lmti::link_library_folder(f.library,f.id,f.root);
    check(lmti::inspect_project_library(f.library).token == after.token,"same-target Qt refresh changed binding authority");
    require(QFile::rename(f.source,f.source + ".offline"),"cannot withdraw disposable old source");
    check(f.inspect(result).condition == lmti::LibraryActivationCondition::ActivatedCurrent,
          "activated history required withdrawn old source");
    const auto abandoned = successful(lmti::abandon_library_activation(f.library,second.token),lmti::LibraryActivationState::Abandoned);
    check(abandoned.token.revision == 2 && abandoned.prepared == reviewed && abandoned.activated_generation == 0 &&
          f.inspect(abandoned).condition == lmti::LibraryActivationCondition::Abandoned,
          "stale abandonment changed prepared evidence or required source reads");
    auto target_document = lmti::load_project(f.target()); target_document.project.goal = "Later ordinary owner edit";
    target_document.topology.revision = lmti::save_project(f.target(),target_document);
    check(f.inspect(result).condition == lmti::LibraryActivationCondition::ActivatedCurrent,
          "activated history incorrectly froze later legitimate target content");
    const auto next_root = mkdir(f.base,"next-root");
    const auto next = lmti::link_library_folder_cas(f.library,f.id,next_root,lmti::inspect_project_library(f.library).token);
    require(QFile::rename(f.target(),f.target() + ".offline"),"cannot withdraw disposable superseded target");
    const auto before_inspect = bytes(f.library);
    check(f.inspect(result).condition == lmti::LibraryActivationCondition::ActivatedSuperseded &&
          f.inspect(result).receipt == result && lmti::inspect_project_library(f.library).token == next &&
          lmti::list_library_activations(f.library).size() == 2 && bytes(f.library) == before_inspect,
          "superseded read-only recovery retried/rebound or required project files");
}

void drift_refusals(const QTemporaryDir &temp) {
    const std::vector<std::function<void(Fixture &)>> mutations{
        [](auto &f) { Sql db(f.source); db.exec("UPDATE project SET label='Source drift'"); },
        [](auto &f) { Sql db(f.target()); db.exec("UPDATE project SET label='Target drift'"); },
        [](auto &f) { Sql db(f.target()); db.exec("INSERT INTO identity_registry VALUES('component','retired-drift','retired')"); },
        [](auto &f) { Sql db(f.source); db.exec("UPDATE store_identity SET store_uuid=?",{uuid()}); },
        [](auto &f) { Sql db(f.target()); db.exec("UPDATE store_identity SET store_uuid=?",{uuid()}); },
        [](auto &f) {
            const auto other = mkdir(f.base,"other-root"); const auto t = lmti::inspect_project_library(f.library).token;
            const auto changed = lmti::link_library_folder_cas(f.library,f.id,other,t);
            (void)lmti::link_library_folder_cas(f.library,f.id,f.root,changed); // Same digest, newer generation.
        }
    };
    int index = 0;
    for (const bool before_preparation : {true,false}) for (const auto &mutate : mutations) {
        Fixture f(temp,"drift-" + QString::number(++index),true);
        const auto expected = f.candidate(); std::optional<lmti::LibraryActivationReceipt> prepared;
        if (!before_preparation) prepared = f.prepare();
        mutate(f); const auto library_bytes = bytes(f.library), source_bytes = bytes(f.source), target_bytes = bytes(f.target());
        const auto history_size = lmti::list_library_activations(f.library).size();
        if (before_preparation)
            rejects([&] { lmti::prepare_library_activation(f.library,f.copy_parent,expected); },"drifted candidate was prepared");
        else {
            check(f.inspect(*prepared).condition != lmti::LibraryActivationCondition::PreparedCurrent,
                  "drifted receipt still reported ready");
            rejects([&] { lmti::activate_library_copy(f.library,f.copy_parent,prepared->token); },"drifted prepared copy was activated");
        }
        check(bytes(f.library) == library_bytes && bytes(f.source) == source_bytes && bytes(f.target()) == target_bytes &&
              lmti::list_library_activations(f.library).size() == history_size,"drift refusal wrote, retried or added history");
    }
}

void trusted_selection_and_receipt_cas(const QTemporaryDir &temp) {
    Fixture f(temp,"trusted-selection",true);
    const auto expected = f.candidate(); const auto original_bytes = bytes(f.library);
    const auto wrong_parent = mkdir(f.base,"wrong-parent");
    rejects([&] { lmti::prepare_library_activation(f.library,wrong_parent,expected); },"request parent retargeted reviewed copy");
    auto fake = expected; fake.library.canonical_path = key(QDir(f.base).filePath("elsewhere.sqlite"));
    rejects([&] { lmti::prepare_library_activation(f.library,f.copy_parent,fake); },"prepared authority accepted different library path");
    fake = expected; fake.library.schema = 2;
    rejects([&] { lmti::prepare_library_activation(f.library,f.copy_parent,fake); },"prepared authority accepted old library schema");
    fake = expected; fake.target.canonical_path = f.source;
    rejects([&] { lmti::prepare_library_activation(f.library,f.copy_parent,fake); },"preview-controlled source alias became target authority");
    fake = expected; fake.mode = lmti::ProjectCopyMode::MigrateV1; fake.seeds_internal_sites = true;
    rejects([&] { lmti::prepare_library_activation(f.library,f.copy_parent,fake); },"wrong copy transformation policy accepted");
    check(bytes(f.library) == original_bytes && lmti::list_library_activations(f.library).empty(),"invalid selection created receipt or changed binding");
    // A missing final copy JSON is reconcilable only through actual native checks.
    require(QFile::remove(QDir(QDir(f.copy_parent).filePath(f.copy.operation_id)).filePath("verified.json")),"cannot remove disposable final copy receipt");
    const auto prepared = f.prepare();
    const auto raw = query(f.library,"SELECT library_schema,library_path FROM library_activations");
    check(raw.size() == 1 && raw[0][0].toInt() == 3 && raw[0][1].toString() == expected.library.canonical_path &&
          prepared.prepared.library == expected.library,"prepared path/schema were not stored immutably");
    const auto before = bytes(f.library);
    auto bad = prepared.token; bad.revision = 2;
    rejects([&] { lmti::activate_library_copy(f.library,f.copy_parent,bad); },"wrong receipt revision activated");
    bad = prepared.token; bad.receipt_digest = QString(64,'0');
    rejects([&] { lmti::abandon_library_activation(f.library,bad); },"wrong receipt digest abandoned");
    bad = prepared.token; bad.library_uuid = uuid();
    rejects([&] { lmti::activate_library_copy(f.library,f.copy_parent,bad); },"different library identity activated");
    rejects([&] { lmti::activate_library_copy(f.library,wrong_parent,prepared.token); },"wrong trusted parent activated");
    check(bytes(f.library) == before,"invalid receipt CAS wrote state");
    // Persisted root nullability belongs to history independently of DTO empty strings.
    const auto abandoned = successful(lmti::abandon_library_activation(f.library,prepared.token),lmti::LibraryActivationState::Abandoned);
    const auto previous_token = lmti::inspect_project_library(f.library).token;
    {
        Sql db(f.library); db.exec("UPDATE library_entries SET folder='',folder_key=NULL");
        db.exec("UPDATE library_identity SET binding_generation=binding_generation+1");
    }
    const auto empty_root = f.prepare();
    check(empty_root.source_folder.has_value() && empty_root.source_folder->isEmpty() && !empty_root.source_folder_key &&
          f.inspect(empty_root).receipt == empty_root && f.inspect(abandoned).receipt == abandoned &&
          lmti::inspect_project_library(f.library).token.generation == previous_token.generation + 1,
          "receipt persistence collapsed empty root and SQL NULL or rewrote earlier receipt");
}

void operation_faults(const QTemporaryDir &temp) {
    int index = 0;
    for (const auto fault : {lmti::LibraryTestFault::BeforePreparationCommit,lmti::LibraryTestFault::AfterPreparationCommit,
                             lmti::LibraryTestFault::BeforeActivationCommit,lmti::LibraryTestFault::AfterActivationCommit,
                             lmti::LibraryTestFault::BeforeAbandonCommit,lmti::LibraryTestFault::AfterAbandonCommit}) {
        Fixture f(temp,"operation-fault-" + QString::number(++index),true);
        const auto reviewed = f.candidate(); std::optional<lmti::LibraryActivationReceipt> initial;
        const bool preparation = fault == lmti::LibraryTestFault::BeforePreparationCommit || fault == lmti::LibraryTestFault::AfterPreparationCommit;
        const bool activation = fault == lmti::LibraryTestFault::BeforeActivationCommit || fault == lmti::LibraryTestFault::AfterActivationCommit;
        const bool after = fault == lmti::LibraryTestFault::AfterPreparationCommit || fault == lmti::LibraryTestFault::AfterActivationCommit || fault == lmti::LibraryTestFault::AfterAbandonCommit;
        if (!preparation) initial = f.prepare();
        const auto source_bytes = bytes(f.source), target_bytes = bytes(f.target());
        lmti::set_library_test_fault(fault);
        const auto status = preparation ? lmti::prepare_library_activation(f.library,f.copy_parent,reviewed) :
            activation ? lmti::activate_library_copy(f.library,f.copy_parent,initial->token) :
                         lmti::abandon_library_activation(f.library,initial->token);
        lmti::set_library_test_fault(lmti::LibraryTestFault::None);
        require(status.code == lmti::LibraryCode::RecoveryRequired && !status.operation_id.isEmpty() && status.receipt,
                "transaction fault did not return operation identity with uncertain intended receipt");
        const auto summaries = lmti::list_library_activations(f.library);
        if (preparation && !after) {
            check(summaries.empty() && lmti::inspect_project_library(f.library).token == reviewed.library,
                  "preparation pre-COMMIT fault left receipt or changed authority");
            rejects([&] { f.inspect(*status.receipt); },"intended uncommitted preparation looked durable");
        } else {
            const auto observed = f.inspect(*status.receipt);
            const auto expected_state = !after || preparation ? lmti::LibraryActivationState::Prepared :
                activation ? lmti::LibraryActivationState::Activated : lmti::LibraryActivationState::Abandoned;
            check(summaries.size() == 1 && observed.receipt.state == expected_state &&
                  observed.receipt.token.revision == (expected_state == lmti::LibraryActivationState::Prepared ? 1 : 2) &&
                  observed.receipt.prepared == reviewed &&
                  observed.library.generation == reviewed.library.generation + (activation && after ? 1 : 0),
                  "durable inspection mistook intended receipt for committed state or repeated transition");
            if (after && !preparation) {
                rejects([&] { lmti::activate_library_copy(f.library,f.copy_parent,initial->token); },"obsolete token retried uncertain committed transition");
                rejects([&] { lmti::abandon_library_activation(f.library,initial->token); },"obsolete token rewrote committed history");
            }
        }
        const auto stable = bytes(f.library); (void)lmti::list_library_activations(f.library);
        check(bytes(f.library) == stable && bytes(f.source) == source_bytes && bytes(f.target()) == target_bytes,
              "fault/reconciliation wrote projects or retried library operation");
    }
}

void inconsistent_and_replaced_library(const QTemporaryDir &temp) {
    Fixture f(temp,"inconsistent-binding",true);
    const auto prepared = f.prepare();
    const auto active = successful(lmti::activate_library_copy(f.library,f.copy_parent,prepared.token),lmti::LibraryActivationState::Activated);
    { Sql db(f.library); db.exec("UPDATE library_entries SET path=?",{f.source}); }
    const auto before = bytes(f.library);
    check(f.inspect(active).condition == lmti::LibraryActivationCondition::Inconsistent && bytes(f.library) == before,
          "same-generation impossible binding drift was silently repaired/current");
    Fixture replaced(temp,"replaced-library",true);
    const auto pending = replaced.prepare();
    { Sql db(replaced.library); db.exec("UPDATE library_identity SET library_uuid=?",{uuid()}); }
    const auto replaced_bytes = bytes(replaced.library);
    rejects([&] { lmti::activate_library_copy(replaced.library,replaced.copy_parent,pending.token); },"replaced library UUID accepted prior operation");
    rejects([&] { replaced.inspect(pending); },"wrong expected library UUID read another library's receipt");
    check(bytes(replaced.library) == replaced_bytes,"replacement refusal rewrote history");
}

void schema_and_capacity(const QTemporaryDir &temp) {
    Fixture f(temp,"history-capacity",true); const auto prepared = f.prepare();
    const auto token = lmti::inspect_project_library(f.library).token;
    {
        Sql db(f.library); QSqlQuery columns(db.db);
        require(columns.exec("PRAGMA table_info(library_activations)"),"cannot inspect fixture receipt columns");
        QStringList selection;
        while (columns.next()) {
            const auto name = columns.value(1).toString();
            require(!name.contains('"'),"unexpected fixture column name");
            selection.push_back(name == "operation_id" ? "?" : '"' + name + '"');
        }
        columns.finish(); db.exec("BEGIN IMMEDIATE");
        for (std::size_t i = 1; i < lmti::max_library_activations; ++i)
            db.exec("INSERT INTO library_activations SELECT " + selection.join(',') + " FROM library_activations WHERE operation_id=?",
                    {uuid(),prepared.token.operation_id});
        db.exec("COMMIT");
    }
    check(lmti::list_library_activations(f.library).size() == lmti::max_library_activations,
          "history fixture did not preserve exact hard capacity");
    const auto before = bytes(f.library);
    rejects([&] { f.prepare(); },"new preparation evicted history or exceeded cap",lmti::LibraryCode::BudgetExceeded);
    check(bytes(f.library) == before && lmti::inspect_project_library(f.library).token == token &&
          f.inspect(prepared).condition == lmti::LibraryActivationCondition::PreparedCurrent,
          "full history blocked inspection or mutated authority");
    const auto abandoned = successful(lmti::abandon_library_activation(f.library,prepared.token),lmti::LibraryActivationState::Abandoned);
    check(f.inspect(abandoned).receipt == abandoned && lmti::list_library_activations(f.library).size() == lmti::max_library_activations,
          "full history prevented existing transition or evicted receipt");
    int index = 0;
    for (const auto &mutation : {QString("CREATE TABLE sqliteXextra(value TEXT)"),
                                 QString("ALTER TABLE library_identity ADD COLUMN extension TEXT"),
                                 QString("UPDATE library_identity SET activation_format_backup_digest='bad'")}) {
        Fixture bad(temp,"format-rejection-" + QString::number(++index),false,false,false);
        const auto preview = lmti::inspect_library_activation_upgrade(bad.library);
        if (index == 3) bad.to_v3();
        { Sql db(bad.library); db.exec(mutation); }
        const auto source = bytes(bad.library); const auto count = children(bad.backups);
        if (index == 3) rejects([&] { lmti::inspect_project_library(bad.library); },"invalid v3 format identity accepted");
        else rejects([&] { lmti::upgrade_library_activation_format(bad.library,bad.backups,preview); },"unknown v2 schema was dropped during upgrade");
        check(bytes(bad.library) == source && children(bad.backups) == count,"format rejection wrote or reserved output");
    }
}
} // namespace

int main(int argc,char **argv) {
    QCoreApplication app(argc,argv); QTemporaryDir temp; if (!temp.isValid()) return 1;
    try {
        format_backup_wal(temp); format_preview_and_failures(temp);
        complete_lifecycle(temp,false); complete_lifecycle(temp,true); drift_refusals(temp);
        trusted_selection_and_receipt_cas(temp); operation_faults(temp);
        inconsistent_and_replaced_library(temp); schema_and_capacity(temp);
    } catch (const std::exception &error) {
        lmti::set_library_test_fault(lmti::LibraryTestFault::None);
        std::cerr << "Unexpected activation test fixture failure: " << error.what() << '\n'; return 1;
    }
    std::cout << "Library activation: reviewed cutover, typed backup, immutable receipts and uncertain commits checked\n";
    return failures ? 1 : 0;
}
