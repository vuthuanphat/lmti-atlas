#include "lmti/project_library.hpp"
#include "lmti/storage.hpp"
#include <QCoreApplication>
#include <QFile>
#include <QFileInfo>
#include <QJsonDocument>
#include <QProcess>
#include <QSqlDatabase>
#include <QSqlQuery>
#include <QTemporaryDir>
#include <QUuid>
#include <algorithm>
#include <functional>
#include <iostream>

namespace {
int failures = 0;
void check(bool ok, const char *message) {
    if (!ok) { std::cerr << message << '\n'; ++failures; }
}
void rejects(const std::function<void()> &operation, const char *message) {
    try { operation(); check(false, message); } catch (const lmti::Error &) {}
}
QByteArray bytes(const QString &path) {
    QFile file(path);
    check(file.open(QIODevice::ReadOnly), "cannot read disposable fixture");
    return file.readAll();
}
QVariant sql(const QString &path, const QString &statement) {
    const auto connection = QUuid::createUuid().toString();
    QVariant result;
    {
        auto db = QSqlDatabase::addDatabase("QSQLITE", connection);
        db.setDatabaseName(path);
        check(db.open(), "cannot open disposable SQL fixture");
        QSqlQuery query(db);
        // Only test-owned temporary databases are deliberately corrupted.
        check(query.exec("PRAGMA ignore_check_constraints=ON"), "fixture pragma failed");
        check(query.exec(statement), "fixture SQL failed");
        if (query.next()) result = query.value(0);
        query.finish();
        db.close();
    }
    QSqlDatabase::removeDatabase(connection);
    return result;
}
lmti::ProjectDocument fixture() {
    lmti::ProjectDocument d;
    d.project = {"factory-monitor", "Structured fixture", "", lmti::Privacy::Public};
    d.topology = lmti::demo_topology();
    d.components = {{"firmware", "Firmware", "", lmti::ComponentKind::Firmware, lmti::Privacy::Public},
                    {"retire-component", "Reusable label", "", lmti::ComponentKind::Library, lmti::Privacy::Public}};
    d.topology.assets.push_back({"retire-asset", "Reusable label", "factory-demo", lmti::Kind::Sensor, lmti::Privacy::Public});
    d.structure.emplace();
    auto &s = *d.structure;
    // Children deliberately precede parents: storage must not depend on UI ordering.
    s.subsystems = {{"sensors", "Sensors", "control", lmti::Privacy::Public},
                    {"control", "Private logical ancestor", "", lmti::Privacy::Internal},
                    {"retire-subsystem", "Reusable label", "", lmti::Privacy::Public}};
    s.component_memberships = {{"firmware", "sensors"}};
    s.sites = {{"factory-demo", "Factory", lmti::Privacy::Public},
               {"retire-site", "Reusable label", lmti::Privacy::Public}};
    s.areas = {{"cell", "Private physical ancestor", "factory-demo", "floor", lmti::Privacy::Internal},
               {"floor", "Floor", "factory-demo", "", lmti::Privacy::Public},
               {"retire-area", "Reusable label", "factory-demo", "", lmti::Privacy::Public}};
    s.environments = {{"test", "Test", lmti::Privacy::Public},
                      {"retire-environment", "Reusable label", lmti::Privacy::Public}};
    s.asset_placements = {{"machine-a", "cell", "gateway-b", "test", lmti::PhysicalRole::Device},
                          {"gateway-b", "cell", "broker-c", "test", lmti::PhysicalRole::Gateway},
                          {"broker-c", "cell", "", "test", std::nullopt}};
    return d;
}
void roundtrip(const QTemporaryDir &temp) {
    const auto path = temp.filePath("roundtrip.sqlite");
    auto d = fixture();
    d.topology.revision = lmti::save_project(path, d);
    check(d.storage_lineage.has_value(), "first structured save did not retain native lineage");
    const auto before = bytes(path);
    check(sql(path, "PRAGMA user_version").toInt() == 2, "fresh structure did not use schema 2");
    check(lmti::load_project(path) == d, "typed hierarchy or optional role changed on roundtrip");
    const auto metadata = lmti::load_project_metadata(path);
    check(metadata.project == d.project && metadata.revision == 1, "schema-2 metadata differs");
    check(bytes(path) == before, "schema-2 read changed database bytes");
    check(sql(path, "SELECT count(*) FROM identity_registry WHERE state='active'").toInt() == 16,
          "initial active registry does not match typed identities");
    const auto library = temp.filePath("library.sqlite");
    lmti::remember_library_project(library, {"factory-monitor", "Structured fixture", path, "", false});
    const auto entries = lmti::project_library(library);
    check(entries.size() == 1 && entries.front().path == path &&
              lmti::load_project(entries.front().path) == d, "known schema-2 library reopen failed");
    d.structure->areas.front().label = "Renamed cell";
    d.structure->subsystems.front().parent_subsystem_id.clear();
    d.topology.revision = lmti::save_project(path, d);
    check(d.topology.revision == 2 && lmti::load_project(path) == d, "same-file hierarchy edit lost data");
    check(sql(path, "SELECT count(*) FROM identity_registry WHERE state='retired'").toInt() == 0,
          "rename or move retired stable identities");
    auto empty = lmti::ProjectDocument{};
    empty.project = {"empty", "Explicitly empty", "", lmti::Privacy::Internal};
    empty.structure.emplace();
    const auto empty_path = temp.filePath("empty.sqlite");
    empty.topology.revision = lmti::save_project(empty_path, empty);
    check(lmti::load_project(empty_path) == empty && lmti::load_project(empty_path).structure.has_value(),
          "explicitly empty structure was flattened");
}
void retire_one(lmti::ProjectDocument &d, const std::string &kind) {
    const auto id = "retire-" + kind;
    const auto remove = [&](auto &rows) { std::erase_if(rows, [&](const auto &r) { return r.id == id; }); };
    if (kind == "component") remove(d.components);
    else if (kind == "asset") remove(d.topology.assets);
    else if (kind == "subsystem") remove(d.structure->subsystems);
    else if (kind == "site") remove(d.structure->sites);
    else if (kind == "area") remove(d.structure->areas);
    else remove(d.structure->environments);
}
void replacement(lmti::ProjectDocument &d, const std::string &kind) {
    const auto id = "retire-" + kind;
    const auto rename = [&](auto &rows) { for (auto &r : rows) if (r.id == id) r.id = "replacement-" + kind; };
    if (kind == "component") rename(d.components);
    else if (kind == "asset") rename(d.topology.assets);
    else if (kind == "subsystem") rename(d.structure->subsystems);
    else if (kind == "site") rename(d.structure->sites);
    else if (kind == "area") rename(d.structure->areas);
    else rename(d.structure->environments);
}
void lifecycle(const QTemporaryDir &temp) {
    for (const std::string kind : {"component", "asset", "subsystem", "site", "area", "environment"}) {
        const auto path = temp.filePath(QString::fromStdString(kind) + ".sqlite");
        auto d = fixture();
        d.topology.revision = lmti::save_project(path, d);
        auto before_deletion = d;
        retire_one(d, kind);
        d.topology.revision = lmti::save_project(path, d);
        const auto saved = bytes(path);
        check(sql(path, "SELECT state FROM identity_registry WHERE kind='" + QString::fromStdString(kind) +
                  "' AND entity_id='retire-" + QString::fromStdString(kind) + "'").toString() == "retired",
              "committed deletion did not retain a tombstone");
        // Same-session stale undo is rejected even after rebasing its revision.
        before_deletion.topology.revision = d.topology.revision;
        rejects([&] { lmti::save_project(path, before_deletion); }, "committed retired identity was reused");
        check(bytes(path) == saved && lmti::load_project(path) == d, "failed reuse changed saved graph/registry");
        replacement(before_deletion, kind);
        before_deletion.topology.revision = lmti::save_project(path, before_deletion);
        check(before_deletion.topology.revision == 3 && lmti::load_project(path) == before_deletion,
              "new identity at same label/site was refused");
        check(sql(path, "SELECT count(*) FROM identity_registry WHERE state='retired'").toInt() == 1,
              "replacement erased prior identity history");
        auto copy = before_deletion;
        copy.topology.revision = 0;
        const auto destination = temp.filePath(QString::fromStdString(kind) + "-copy.sqlite");
        rejects([&] { lmti::save_project(destination, copy); }, "same-session save/delete/save/copy lost tombstones");
        check(!QFileInfo::exists(destination), "refused same-session copy created a file");
    }
}
void conflicts_and_lineage(const QTemporaryDir &temp) {
    const auto path = temp.filePath("conflict.sqlite");
    auto d = fixture();
    d.topology.revision = lmti::save_project(path, d);
    auto stale = d;
    retire_one(d, "asset");
    d.topology.revision = lmti::save_project(path, d);
    const auto before = bytes(path);
    stale.project.label = "Stale writer";
    rejects([&] { lmti::save_project(path, stale); }, "stale writer overwrote a committed retirement");
    check(bytes(path) == before, "revision conflict modified data or registry");
    auto invalid = d;
    invalid.structure->areas[0].parent_area_id = "missing";
    rejects([&] { lmti::save_project(path, invalid); }, "invalid hierarchy was saved");
    check(bytes(path) == before, "invalid hierarchy changed database bytes");
    auto loaded = lmti::load_project(path);
    loaded.topology.revision = 0;
    const auto copy_path = temp.filePath("loaded-copy.sqlite");
    rejects([&] { lmti::save_project(copy_path, loaded); }, "loaded reset-revision copied without registry");
    check(!QFileInfo::exists(copy_path), "loaded copy refusal created file");
    rejects([&] { lmti::save_project(path, loaded); }, "loaded reset-revision overwrote same file");
    loaded = d;
    loaded.project.id = "different-project";
    loaded.topology.revision = 0;
    rejects([&] { lmti::save_project(copy_path, loaded); }, "lineage allowed project identity change");
    loaded = d;
    loaded.structure.reset();
    rejects([&] { lmti::save_project(path, loaded); }, "schema-2 structure silently downgraded");
    loaded = d;
    loaded.storage_lineage->schema_version = 1;
    rejects([&] { lmti::save_project(path, loaded); }, "invalid lineage schema accepted");
    check(bytes(path) == before && !QFileInfo::exists(copy_path), "lineage refusal modified source/target");
    const auto const_document = fixture();
    rejects([&] { lmti::save_project(copy_path, const_document); }, "const structured save cannot retain lineage");
    check(!QFileInfo::exists(copy_path), "const structured refusal created file");
    // Force a real SQL failure after DELETE/INSERT work has begun. This extra
    // fixture-only index is stricter than the domain and trips on a valid label.
    sql(path, "CREATE UNIQUE INDEX fixture_unique_asset_label ON assets(label)");
    const auto before_sql_failure = bytes(path);
    auto failed = d;
    failed.topology.assets[1].label = failed.topology.assets[0].label;
    retire_one(failed, "component");
    rejects([&] { lmti::save_project(path, failed); }, "SQL constraint failure did not abort save");
    check(bytes(path) == before_sql_failure && lmti::load_project(path) == d &&
              sql(path, "SELECT state FROM identity_registry WHERE entity_id='retire-component'").toString() == "active",
          "mid-transaction failure partially changed graph or identity retirement");
}
void store_identity(const QTemporaryDir &temp) {
    const auto a = temp.filePath("lineage-a.sqlite"), b = temp.filePath("lineage-b.sqlite");
    auto source = fixture();
    source.topology.revision = lmti::save_project(a, source);
    retire_one(source, "asset");
    source.topology.revision = lmti::save_project(a, source);
    auto other = fixture();
    retire_one(other, "asset"); // B never owned this ID, so has no tombstone.
    other.topology.revision = lmti::save_project(b, other);
    other.topology.revision = lmti::save_project(b, other);
    check(source.project == other.project && source.topology.revision == other.topology.revision &&
              source.structure == other.structure && source.topology.assets == other.topology.assets &&
              source.storage_lineage->store_uuid != other.storage_lineage->store_uuid,
          "two-store divergent-history fixture is invalid");
    const auto original_a = bytes(a), original_b = bytes(b);
    auto loaded = lmti::load_project(a);
    rejects([&] { lmti::save_project(b, loaded); }, "loaded document saved into a different existing store");
    check(bytes(a) == original_a && bytes(b) == original_b, "cross-store refusal changed source/destination");
    // Simulate external replacement of a disposable fixture at the SAME path;
    // project ID and revision alone would not detect its different history.
    const auto preserved = temp.filePath("lineage-a-preserved.sqlite");
    check(QFile::copy(a, preserved), "cannot preserve replacement-test source");
    check(QFile::remove(a) && QFile::copy(b, a), "cannot replace disposable same-path fixture");
    const auto replaced = bytes(a);
    rejects([&] { lmti::save_project(a, loaded); }, "same-path different store UUID was overwritten");
    check(bytes(a) == replaced && bytes(preserved) == original_a && bytes(b) == original_b,
          "store-identity refusal changed replacement or preserved source");
}
void corruption(const QTemporaryDir &temp) {
    const auto path = temp.filePath("corruption-source.sqlite");
    auto d = fixture();
    d.topology.revision = lmti::save_project(path, d);
    int index = 0;
    const auto corrupt = [&](const QString &statement, bool metadata_refuses) {
        const auto dest = temp.filePath(QString("corrupt-%1.sqlite").arg(++index));
        check(QFile::copy(path, dest), "cannot copy corruption fixture");
        auto candidate = lmti::load_project(dest);
        sql(dest, statement);
        const auto before = bytes(dest);
        rejects([&] { lmti::load_project(dest); }, "corrupt schema/registry/graph was accepted");
        if (metadata_refuses)
            rejects([&] { lmti::load_project_metadata(dest); }, "metadata accepted unsupported schema/columns");
        else
            check(lmti::load_project_metadata(dest).project == d.project, "metadata must not certify graph health");
        rejects([&] { lmti::save_project(dest, candidate); }, "writer erased corrupt registry instead of refusing");
        check(bytes(dest) == before, "corruption refusal repaired or modified source");
    };
    corrupt("DELETE FROM identity_registry WHERE entity_id='machine-a'", false);
    corrupt("INSERT INTO identity_registry VALUES('asset','ghost','active')", false);
    corrupt("UPDATE identity_registry SET state='retired' WHERE entity_id='machine-a'", false);
    corrupt("UPDATE identity_registry SET state='invalid' WHERE entity_id='machine-a'", false);
    corrupt("UPDATE identity_registry SET kind='unknown' WHERE entity_id='machine-a'", false);
    corrupt("UPDATE identity_registry SET entity_id='../unsafe' WHERE entity_id='machine-a'", false);
    corrupt("UPDATE store_identity SET store_uuid='not-a-store-uuid'", false);
    corrupt("DELETE FROM store_identity", false);
    corrupt("INSERT INTO store_identity VALUES(2,'11111111-1111-4111-8111-111111111111')", false);
    corrupt("UPDATE asset_placements SET parent_asset_id='absent' WHERE asset_id='machine-a'", false);
    corrupt("UPDATE asset_placements SET role='inferred' WHERE asset_id='machine-a'", false);
    corrupt("UPDATE areas SET parent_area_id='cell' WHERE id='floor'", false);
    corrupt("ALTER TABLE areas ADD COLUMN unsupported TEXT", true);
    corrupt("ALTER TABLE sites RENAME COLUMN label TO unsupported", true);
    corrupt("CREATE TABLE unsupported(value TEXT)", true);
    corrupt("DROP TABLE identity_registry", true);
    corrupt("PRAGMA user_version=3", true);
    corrupt("PRAGMA user_version=1", true);
    corrupt("CREATE VIEW unsupported AS SELECT * FROM areas", true);
    // Registry history has its own finite budget, independent of active graph.
    corrupt("WITH RECURSIVE n(v) AS (VALUES(1) UNION ALL SELECT v+1 FROM n WHERE v<50001) "
            "INSERT INTO identity_registry SELECT 'asset','retired-'||v,'retired' FROM n", false);
}
struct ProcessResult { int exit; QByteArray output, error; };
ProcessResult run(const QString &binary, const QStringList &args, const QByteArray &input = {}) {
    QProcess process;
    process.start(binary, args);
    check(process.waitForStarted(10000), "legacy owner did not start");
    if (!input.isEmpty()) check(process.write(input) == input.size(), "owner stdin failed");
    process.closeWriteChannel();
    const bool done = process.waitForFinished(10000);
    check(done, "legacy owner did not finish");
    if (!done) { process.kill(); process.waitForFinished(3000); }
    check(process.exitStatus() == QProcess::NormalExit, "legacy owner crashed");
    return {process.exitCode(), process.readAllStandardOutput(), process.readAllStandardError()};
}
void legacy_boundaries(const QTemporaryDir &temp, const QString &binary) {
    const auto path = temp.filePath("privacy.sqlite");
    auto d = fixture();
    d.topology.revision = lmti::save_project(path, d);
    const auto before = bytes(path);
    for (const QString target : {"local", "external"}) {
        const QStringList grant{path, "factory-monitor", "factory-demo", target};
        for (const QString operation : {"snapshot", "agent-snapshot", "context", "impact"}) {
            auto args = QStringList{operation} + grant;
            if (operation == "context") args << "100";
            if (operation == "impact") args << "firmware";
            const auto result = run(binary, args);
            check(result.exit == 1 && result.output.isEmpty() &&
                      result.error.size() <= 100 && result.error.trimmed() ==
                          "Project runtime rejected the request; check schema, trusted scope and metadata.",
                  "legacy context/snapshot/impact exposed structured state or raw error");
        }
        const lmti::ConfigProposal proposal{1, "machine-a", "factory-demo", true, false, 1000, 2000};
        const auto body = QJsonDocument(QJsonObject{{"expectedProjectRevision", 1},
                       {"proposal", lmti::proposal_json(proposal)}}).toJson(QJsonDocument::Compact);
        for (const QString operation : {"proposal-asset", "review-proposal", "commit-proposal"}) {
            auto args = QStringList{operation} + grant;
            if (operation == "proposal-asset") args << "machine-a";
            const auto result = run(binary, args, operation == "proposal-asset" ? QByteArray{} : body);
            check(result.exit == 1 && result.error.isEmpty() && result.output.size() <= 128 &&
                    QJsonDocument::fromJson(result.output).object() == QJsonObject{{"ok", false},
                        {"error", QJsonObject{{"code", "SCOPE_DENIED"}}}},
                  "legacy proposal owner bypassed ancestor privacy");
        }
    }
    check(bytes(path) == before && lmti::load_project(path) == d, "legacy refusal changed structured store");
}
}
int main(int argc, char **argv) {
    QCoreApplication app(argc, argv);
    QTemporaryDir temp;
    if (!temp.isValid() || app.arguments().size() != 2) return 1;
    try {
        roundtrip(temp);
        lifecycle(temp);
        conflicts_and_lineage(temp);
        store_identity(temp);
        corruption(temp);
        legacy_boundaries(temp, app.arguments()[1]);
    } catch (const std::exception &error) { std::cerr << "Unexpected test failure: " << error.what() << '\n'; return 1; }
    std::cout << "Schema-2 hierarchy, durable identities, atomic conflicts and legacy privacy refusal checked\n";
    return failures ? 1 : 0;
}
