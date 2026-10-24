#include "lmti/project_store.hpp"
#include "../storage/project_copy_p.hpp"
#include <QCoreApplication>
#include <QDir>
#include <QFile>
#include <QFileInfo>
#include <QProcess>
#include <QSqlDatabase>
#include <QSqlQuery>
#include <QStringList>
#include <QTemporaryDir>
#include <QUuid>
#include <cstdlib>
#include <exception>
#include <filesystem>
#include <functional>
#include <iostream>
#include <thread>

namespace {
int failures = 0;
void check(bool value,const char *message) {
    if (!value) { ++failures; std::cerr << message << '\n'; }
}
void reject(const std::function<void()> &call,const char *message) {
    try { call(); check(false,message); }
    catch (const lmti::ProjectCopyError &e) {
        check(QByteArray(e.what()) == "Project copy was refused.","reservation error exposed private details");
    }
}
void reject_storage(const std::function<void()> &call,const char *message) {
    try { call(); check(false,message); }
    catch (const lmti::Error &) {}
}
QByteArray bytes(const QString &path) {
    QFile f(path);
    if (!f.open(QIODevice::ReadOnly)) throw lmti::Error("Fixture read failed.");
    return f.readAll();
}
class Sql {
    QString name_ = QUuid::createUuid().toString();
  public:
    QSqlDatabase db;
    explicit Sql(const QString &path) {
        db = QSqlDatabase::addDatabase("QSQLITE",name_);
        db.setDatabaseName(path);
        db.setConnectOptions("QSQLITE_BUSY_TIMEOUT=0");
        if (!db.open()) throw lmti::Error("Fixture open failed.");
    }
    ~Sql() { db.close(); db = {}; QSqlDatabase::removeDatabase(name_); }
    bool run(const QString &text) { QSqlQuery q(db); return q.exec(text); }
};
lmti::ProjectDocument fixture(const QString &path,bool structured = false) {
    auto d = lmti::demo_project();
    d.repositories.front().locator = "fixture-private-repository";
    d.knowledge.push_back({"design","Design","sensor-firmware","fixture-private-reference",
                           "fixture-fingerprint",lmti::Privacy::Internal});
    if (structured) {
        d.structure.emplace();
        d.structure->sites = {{"factory-demo","Factory",lmti::Privacy::Internal}};
        d.topology.assets.push_back({"retired-probe","Old probe","factory-demo",lmti::Kind::Sensor,
                                     lmti::Privacy::Internal});
    }
    d.topology.revision = lmti::save_project(path,d);
    if (structured) {
        d.topology.assets.pop_back();
        d.topology.revision = lmti::save_project(path,d);
    }
    return d;
}
QString key(QString path) {
    path = QFileInfo(path).canonicalFilePath();
#ifdef Q_OS_WIN
    path = path.toCaseFolded();
#endif
    return path;
}
std::filesystem::path native_path(const QString &path) {
#ifdef Q_OS_WIN
    return std::filesystem::path(path.toStdWString());
#else
    return std::filesystem::path(QFile::encodeName(path).constData());
#endif
}
using Point = lmti::detail::ReservationTestPoint;
QString disappear;
QStringList began;
bool fail_after_begin = false;
void hook(Point point,const QString &path) {
    if (point == Point::BeforeExistingOpen && path == disappear) {
        if (!QFile::rename(path,path+".retained")) throw lmti::Error("Fixture rename failed.");
    }
    if (point == Point::AfterBegin) {
        began.push_back(key(path));
        if (fail_after_begin) throw lmti::Error("Injected fixture failure.");
    }
}
struct HookScope {
    HookScope() { began.clear(); lmti::detail::set_project_reservation_test_hook(hook); }
    ~HookScope() {
        lmti::detail::set_project_reservation_test_hook(nullptr);
        disappear.clear(); fail_after_begin = false;
    }
};

void existing_only_and_aliases(const QTemporaryDir &temp) {
    const auto a = temp.filePath("existing-a.sqlite"), b = temp.filePath("existing-b.sqlite");
    fixture(a); fixture(b,true);
    const auto a_before = bytes(a), b_before = bytes(b);
    const auto missing = temp.filePath("missing.sqlite");
    reject([&] { lmti::detail::HeldProjectCopies hold(a,missing); },"missing second file accepted");
    reject([&] { lmti::detail::HeldProjectCopies hold(missing,a); },"missing first file accepted");
    check(!QFile::exists(missing) && !QFile::exists(missing+"-journal"),"reservation created a missing store");
    reject([&] { lmti::detail::HeldProjectCopies hold(a,a); },"same-file pair accepted");
    const auto alias = temp.filePath("existing-hardlink.sqlite");
    std::error_code ec;
    std::filesystem::create_hard_link(native_path(a),native_path(alias),ec);
    check(!ec,"disposable hardlink fixture unavailable");
    if (!ec) reject([&] { lmti::detail::HeldProjectCopies hold(a,alias); },"physical alias pair accepted");
    {
        HookScope installed;
        disappear = QFileInfo(a).canonicalFilePath();
        reject([&] { lmti::detail::test_project_reservation_existing_open(a); },
               "disappearing file recreated by exact reservation open mode");
        check(!QFile::exists(a) && !QFile::exists(a+"-wal") && !QFile::exists(a+"-journal"),
              "existing-only SQLite open created a file after preflight");
        check(bytes(a+".retained") == a_before,"disappearing-file failure changed retained source");
        check(QFile::rename(a+".retained",a),"cannot restore disposable renamed fixture");
    }
    check(bytes(a) == a_before && bytes(b) == b_before,"preflight refusal changed a project");
}

void capture_and_locking(const QTemporaryDir &temp) {
    // URI punctuation is literal path data, including percent-like encodings.
    const auto a = temp.filePath("capture a#%23.sqlite"), b = temp.filePath("capture-z.sqlite");
    fixture(a); fixture(b,true);
    const auto expected_a = lmti::detail::capture_project_copy(a);
    const auto expected_b = lmti::detail::capture_project_copy(b);
    const auto a_before = bytes(a), b_before = bytes(b);
    {
        HookScope installed;
        lmti::detail::HeldProjectCopies hold(b,a); // caller order is deliberately reversed.
        check(began == QStringList{key(a),key(b)},"pair did not reserve in deterministic canonical order");
        check(hold.first().token == expected_b.token && hold.second().token == expected_a.token,
              "held tokens differ from complete typed snapshots or caller order");
        check(hold.first().document == expected_b.document && hold.second().document == expected_a.document,
              "held capture lost graph fields or physical lineage path");
        check(hold.first().registry == expected_b.registry &&
              hold.first().registry.at({"asset","retired-probe"}) == false,
              "held capture dropped retired native identity");
        check(!hold.first().token.store_uuid.isEmpty() && hold.first().document.storage_lineage &&
              hold.first().document.storage_lineage->store_path == key(b).toStdString(),
              "URI opening replaced native store UUID or lineage with URI text");
        // Use another thread and real owner save, not just the test hook.
        bool refused = false;
        std::exception_ptr unexpected;
        std::thread rival([&] {
            try {
                auto d = lmti::load_project(b); d.project.label = "Competing owner edit";
                try { lmti::save_project(b,d); }
                catch (const lmti::Error &) { refused = true; }
            } catch (...) { unexpected = std::current_exception(); }
        });
        rival.join();
        if (unexpected) std::rethrow_exception(unexpected);
        check(refused,"held project reservation allowed another owner to commit");
        Sql competitor(a);
        check(!competitor.run("BEGIN IMMEDIATE"),"first project was not held while second was captured");
        hold.check_held();
        check(lmti::detail::capture_project_copy(b).token == hold.first().token,
              "held source changed despite reservation");
    }
    check(bytes(a) == a_before && bytes(b) == b_before,"reservation changed project bytes");
    auto d = lmti::load_project(b); d.project.label = "Accepted after release";
    d.topology.revision = lmti::save_project(b,d);
    check(d.topology.revision == expected_b.token.revision+1 && lmti::load_project(b).project.label == d.project.label,
          "RAII release left a lock or damaged ordinary save");
}

void failure_cleanup(const QTemporaryDir &temp) {
    const auto a = temp.filePath("cleanup-a.sqlite"), z = temp.filePath("cleanup-z.sqlite");
    fixture(a); fixture(z,true);
    {
        Sql blocker(z);
        check(blocker.run("BEGIN IMMEDIATE"),"second-lock fixture could not reserve");
        reject([&] { lmti::detail::HeldProjectCopies hold(z,a); },"busy second reservation was accepted");
        Sql released(a);
        check(released.run("BEGIN IMMEDIATE"),"busy second reservation leaked first lock");
        released.run("ROLLBACK"); blocker.run("ROLLBACK");
    }
    {
        Sql sql(z);
        check(sql.run("ALTER TABLE project ADD COLUMN unknown_extra TEXT"),"fixture extension failed");
    }
    const auto a_before = bytes(a), z_before = bytes(z);
    reject([&] { lmti::detail::HeldProjectCopies hold(z,a); },"unsupported second schema accepted");
    { Sql sql(a); check(sql.run("BEGIN IMMEDIATE"),"failed second capture leaked first reservation"); sql.run("ROLLBACK"); }
    { Sql sql(z); check(sql.run("BEGIN IMMEDIATE"),"failed typed capture leaked second reservation"); sql.run("ROLLBACK"); }
    check(bytes(a) == a_before && bytes(z) == z_before,"schema failure modified project data");
    {
        HookScope installed; fail_after_begin = true;
        reject([&] { lmti::detail::HeldProjectCopies hold(a,z); },"injected after-BEGIN failure was ignored");
    }
    { Sql sql(a); check(sql.run("BEGIN IMMEDIATE"),"constructor exception leaked reservation"); sql.run("ROLLBACK"); }
    const auto bad_sidecar = a+"-shm";
    {
        QFile f(bad_sidecar);
        check(f.open(QIODevice::WriteOnly | QIODevice::NewOnly) && f.resize(1024*1024+1),
              "sidecar budget fixture failed");
    }
    reject([&] { lmti::detail::HeldProjectCopies hold(a,z); },"oversized sidecar accepted");
    check(bytes(a) == a_before && bytes(z) == z_before,"sidecar refusal changed a project");
}

void schema_privacy_refusal(const QTemporaryDir &temp) {
    const auto normal = temp.filePath("schema-normal.sqlite"); fixture(normal);
    for (const bool structured : {false,true}) {
        const auto path = temp.filePath(structured ? "schema-extra-v2.sqlite" : "schema-extra-v1.sqlite");
        fixture(path,structured);
        { Sql db(path); check(db.run("CREATE TABLE sqliteXextra(private_value TEXT)"),"extension fixture failed"); }
        const auto before = bytes(path);
        reject_storage([&] { lmti::detail::capture_project_copy(path); },"copy hid sqliteXextra extension data");
        reject([&] { lmti::detail::HeldProjectCopies hold(path,normal); },"held capture hid sqliteXextra extension data");
        check(bytes(path) == before,"extension refusal wrote project bytes");
    }
    const auto flat = temp.filePath("schema-uppercase-flat.sqlite");
    auto flat_document = fixture(flat);
    { Sql db(flat); check(db.run("CREATE TABLE IDENTITY_REGISTRY(private_value TEXT)"),"uppercase fixture failed"); }
    const auto flat_before = bytes(flat);
    reject_storage([&] { lmti::load_project(flat); },"v1 load ignored uppercase reserved table");
    reject_storage([&] { lmti::load_project_metadata(flat); },"v1 metadata ignored uppercase reserved table");
    reject_storage([&] { lmti::save_project(flat,flat_document); },"v1 save ignored uppercase reserved table");
    reject([&] { lmti::detail::HeldProjectCopies hold(flat,normal); },"reservation ignored uppercase reserved table");
    check(bytes(flat) == flat_before,"uppercase reserved-table refusal wrote v1 source");

    const auto downgraded = temp.filePath("schema-uppercase-structured.sqlite");
    auto structured_document = fixture(downgraded,true);
    {
        Sql db(downgraded);
        for (const auto &name : QStringList{"subsystems","component_memberships","sites","areas","environments",
                                           "asset_placements","identity_registry","store_identity"}) {
            check(db.run("ALTER TABLE "+name+" RENAME TO temporary_"+name) &&
                  db.run("ALTER TABLE temporary_"+name+" RENAME TO "+name.toUpper()),
                  "case-only control table fixture rename failed");
        }
        check(db.run("PRAGMA user_version=1"),"downgrade fixture failed");
    }
    const auto structured_before = bytes(downgraded);
    reject_storage([&] { lmti::load_project(downgraded); },"uppercase hierarchy downgrade flattened privacy");
    reject_storage([&] { lmti::load_project_metadata(downgraded); },"metadata accepted uppercase hierarchy downgrade");
    reject_storage([&] { lmti::save_project(downgraded,structured_document); },"save accepted uppercase hierarchy downgrade");
    reject([&] { lmti::detail::HeldProjectCopies hold(downgraded,normal); },"reservation accepted uppercase hierarchy downgrade");
    check(bytes(downgraded) == structured_before,"downgrade refusal changed structured source");
}

int leave_wal(const QString &path,bool structured) {
    // A deliberate child exit leaves committed WAL with NO live keeper from the
    // test itself. The parent must prove the helper prevents last-close rewrite.
    fixture(path,structured);
    Sql db(path);
    if (!db.run("PRAGMA journal_mode=WAL") || !db.run("PRAGMA wal_autocheckpoint=0") ||
        !db.run("BEGIN IMMEDIATE") || !db.run("UPDATE project SET label='Committed only in WAL'") ||
        !db.run("UPDATE project SET revision=revision+1") || !db.run("COMMIT")) return 3;
    std::_Exit(0);
}
void wal_without_other_connections(const QTemporaryDir &temp) {
    const auto a = temp.filePath("wal-a.sqlite"), b = temp.filePath("wal-b.sqlite");
    for (const auto &path : {a,b}) {
        QProcess child;
        child.setProgram(QCoreApplication::applicationFilePath());
        child.setArguments({"--leave-wal",path,path == b ? "structured" : "flat"});
        child.start();
        const bool ended = child.waitForStarted(5000) && child.waitForFinished(30000);
        if (!ended) { child.kill(); child.waitForFinished(5000); }
        check(ended && child.exitStatus() == QProcess::NormalExit && child.exitCode() == 0,
              "committed-WAL child fixture failed");
    }
    const auto main_a = bytes(a), wal_a = bytes(a+"-wal"), main_b = bytes(b), wal_b = bytes(b+"-wal");
    check(!wal_a.isEmpty() && !wal_b.isEmpty(),"fixture did not retain committed WAL");
    {
        lmti::detail::HeldProjectCopies hold(a,b);
        check(hold.first().document.project.label == "Committed only in WAL" &&
              hold.second().document.project.label == "Committed only in WAL" &&
              hold.first().token.revision == 2 && hold.second().token.revision == 3,
              "held capture missed committed WAL rows or revisions");
        hold.check_held();
    }
    check(bytes(a) == main_a && bytes(a+"-wal") == wal_a && bytes(b) == main_b && bytes(b+"-wal") == wal_b,
          "last reservation release checkpointed or changed main/WAL bytes");
    {
        HookScope installed; fail_after_begin = true;
        reject([&] { lmti::detail::HeldProjectCopies hold(a,b); },"WAL constructor fault was ignored");
    }
    check(bytes(a) == main_a && bytes(a+"-wal") == wal_a && bytes(b) == main_b && bytes(b+"-wal") == wal_b,
          "failed WAL reservation cleanup checkpointed or changed main/WAL bytes");
    const auto captured = lmti::detail::capture_project_copy(b);
    check(captured.document.project.label == "Committed only in WAL" &&
          captured.registry.at({"asset","retired-probe"}) == false,
          "release lost committed WAL state or identity history");
}
}
int main(int argc,char **argv) {
    QCoreApplication app(argc,argv);
    try {
        const auto args = app.arguments();
        if (args.size() == 4 && args[1] == "--leave-wal") return leave_wal(args[2],args[3] == "structured");
        QTemporaryDir temp;
        if (!temp.isValid()) throw lmti::Error("Fixture directory unavailable.");
        existing_only_and_aliases(temp);
        capture_and_locking(temp);
        failure_cleanup(temp);
        schema_privacy_refusal(temp);
        wal_without_other_connections(temp);
    } catch (const std::exception &) { check(false,"reservation test stopped with a bounded fixture/owner error"); }
    if (failures) std::cerr << failures << " reservation checks failed\n";
    else std::cout << "project reservation checks passed\n";
    return failures ? 1 : 0;
}
