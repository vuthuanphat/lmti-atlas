#include "lmti/project_library.hpp"
#include "lmti/project_store.hpp"
#include "lmti/storage.hpp"
#include <QCoreApplication>
#include <QFile>
#include <QJsonArray>
#include <QJsonDocument>
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
    if (!ok) {
        std::cerr << message << '\n';
        ++failures;
    }
}
void rejects(const std::function<void()> &fn, const char *message) {
    try {
        fn();
        check(false, message);
    } catch (const lmti::Error &) {
    }
}
QByteArray bytes(const QString &path) {
    QFile f(path);
    if (!f.open(QIODevice::ReadOnly))
        return {};
    return f.readAll();
}
void mutate_fixture(const QString &path, const QString &sql) {
    const auto connection = QUuid::createUuid().toString();
    {
        auto db = QSqlDatabase::addDatabase("QSQLITE", connection);
        db.setDatabaseName(path);
        check(db.open(), "cannot open snapshot corruption fixture");
        QSqlQuery query(db);
        // Corrupt only this disposable fixture deliberately, so the reader's own
        // validation is exercised even for values the normal schema cannot store.
        check(query.exec("PRAGMA ignore_check_constraints=ON"), "cannot configure corruption fixture");
        check(query.exec(sql), "cannot mutate snapshot corruption fixture");
        db.close();
    }
    QSqlDatabase::removeDatabase(connection);
}
QJsonObject snapshot_row(const QJsonObject &snapshot, const char *category, const char *id) {
    for (const auto &value : snapshot[category].toArray())
        if (value.toObject()["id"] == id)
            return value.toObject();
    return {};
}
void reference_snapshot_tests(const QTemporaryDir &temp) {
    const auto path = temp.filePath("reference-snapshot.sqlite");
    auto document = lmti::demo_project();
    document.knowledge.push_back({"ref-public", "Firmware design", "sensor-firmware",
                                  "private-reference-location", "declared-document-revision", lmti::Privacy::Public});
    document.knowledge.push_back({"ref-internal", "Internal design", "sensor-firmware",
                                  "private-internal-location", "declared-private-revision", lmti::Privacy::Internal});
    document.topology.revision = lmti::save_project(path, document);
    const auto before = bytes(path);
    const lmti::ProjectScope scope{document.project.id, "factory-demo", true};
    const auto snapshot = lmti::project_snapshot(path, scope, true);
    check(snapshot["schema"] == "lmti.project.snapshot.v2", "reference snapshot schema missing");
    check(snapshot_row(snapshot, "components", "sensor-firmware")["repositoryId"] == "repo-sensor",
          "reference snapshot lost component repository identity");
    check(snapshot_row(snapshot, "knowledge", "ref-public")["componentId"] == "sensor-firmware" &&
              snapshot_row(snapshot, "knowledge", "ref-internal").isEmpty(),
          "reference snapshot lost knowledge mapping or exposed internal knowledge");
    const auto encoded = QJsonDocument(snapshot).toJson(QJsonDocument::Compact);
    check(!encoded.contains("private-reference-location") && !encoded.contains("private-internal-location") &&
              !encoded.contains("declared-document-revision") && !encoded.contains("\"locator\"") &&
              !encoded.contains("\"reference\""), "reference snapshot exported raw locations or fingerprints");
    check(bytes(path) == before && lmti::project_snapshot(path, scope, true) == snapshot,
          "reference read changed storage or ordering");
    const QJsonValue fingerprint = snapshot_row(snapshot, "knowledge", "ref-public")["referenceFingerprint"];
    document.knowledge.back().privacy = lmti::Privacy::Public;
    document.knowledge[document.knowledge.size() - 2].reference = "changed-private-reference";
    document.topology.revision = lmti::save_project(path, document);
    check(snapshot_row(lmti::project_snapshot(path, scope, true), "knowledge", "ref-public")["referenceFingerprint"] != fingerprint,
          "changed reference did not change its opaque binding fingerprint");
    document.repositories.front().privacy = lmti::Privacy::Internal;
    document.topology.revision = lmti::save_project(path, document);
    const auto hidden = lmti::project_snapshot(path, scope, true);
    check(snapshot_row(hidden, "repositories", "repo-sensor").isEmpty() &&
              snapshot_row(hidden, "components", "sensor-firmware").isEmpty() &&
              snapshot_row(hidden, "knowledge", "ref-public").isEmpty(),
          "reference snapshot failed inherited repository/component privacy");
    const auto local = lmti::project_snapshot(path, {document.project.id, "factory-demo", false}, true);
    check(snapshot_row(local, "knowledge", "ref-public")["privacy"] == "internal",
          "local knowledge reference did not inherit private parent classification");
}
void metadata_tests(const QTemporaryDir &temp) {
    const auto path=temp.filePath("metadata.sqlite");
    auto document=lmti::demo_project();document.topology.revision=lmti::save_project(path,document);
    const auto before=bytes(path);const auto info=lmti::load_project_metadata(path);
    check(info.project==document.project && info.revision==document.topology.revision,"metadata projection differs from saved document");
    check(bytes(path)==before,"metadata read modified storage");
    const auto corruption=[&](const QString &name,const QString &sql,const char *message){
        const auto dest=temp.filePath(name);check(QFile::copy(path,dest),"metadata fixture copy failed");
        mutate_fixture(dest,sql);const auto corrupt_before=bytes(dest);
        rejects([&]{lmti::load_project_metadata(dest);},message);check(bytes(dest)==corrupt_before,"rejected metadata read modified source");
    };
    corruption("metadata-revision.sqlite","UPDATE project SET revision=0","invalid revision exposed through metadata");
    corruption("metadata-label.sqlite","UPDATE project SET label='a'||char(10)||'b'","control character metadata accepted");
    corruption("metadata-privacy.sqlite","UPDATE project SET privacy='secret'","unsupported project privacy exposed");
    corruption("metadata-table.sqlite","DROP TABLE knowledge","partial project container treated as supported metadata");
    corruption("metadata-version.sqlite","PRAGMA user_version=2","unknown metadata version accepted");
    corruption("metadata-view.sqlite","CREATE VIEW untrusted AS SELECT id FROM project","view-bearing container accepted");
    corruption("metadata-type.sqlite","UPDATE project SET label=x'41'","blob accepted as project text");
    const auto graph=temp.filePath("metadata-invalid-graph.sqlite");check(QFile::copy(path,graph),"graph fixture copy failed");
    mutate_fixture(graph,"UPDATE work SET state='unsupported'");
    check(lmti::load_project_metadata(graph).project==document.project,"metadata cannot be independently projected");
    rejects([&]{lmti::load_project(graph);},"metadata optimization bypassed full graph validation");
}
void snapshot_tests(const QTemporaryDir &temp) {
    auto document = lmti::demo_project();
    for (int i = 0; i < 220; ++i) {
        document.components.push_back({"component-" + std::to_string(i), "Synthetic component", "",
                                       lmti::ComponentKind::Library, lmti::Privacy::Public});
        document.topology.assets.push_back({"device-" + std::to_string(i), "Synthetic device", "factory-demo",
                                            lmti::Kind::Sensor, lmti::Privacy::Public});
    }
    document.repositories[0].locator = "https://example.invalid/nonexported-repository";
    document.knowledge.push_back({"local-knowledge", "Local reference", "sensor-firmware",
                                  "private-reference", "nonexported-fingerprint", lmti::Privacy::Public});
    document.topology.assets[0].observed = lmti::Observation::Online;
    document.topology.assets[0].observed_at = 1700000000;
    const auto path = temp.filePath("snapshot.sqlite");
    document.topology.revision = lmti::save_project(path, document);
    const auto before = bytes(path);
    const lmti::ProjectScope external{document.project.id, "factory-demo", true, 1};
    const auto snapshot = lmti::project_snapshot(path, external);
    check(snapshot["schema"] == "lmti.project.snapshot.v1" && snapshot["semantics"] == "declared" &&
              snapshot["projectId"] == QString::fromStdString(document.project.id) &&
              snapshot["revision"].toInteger() == 1 && snapshot["complete"] == true &&
              snapshot["external"] == true && !snapshot.contains("truncated"),
          "snapshot identity or complete declared semantics missing");
    check(snapshot["components"].toArray().size() == 223 && snapshot["assets"].toArray().size() == 223,
          "full snapshot reused the bounded context or dropped records after 200");
    check(snapshot["connections"].toArray().size() == 2 &&
              snapshot_row(snapshot, "bindings", "sensor-binding")["desiredReleaseId"] == "sensor-v020",
          "snapshot lost stable declared relationship IDs");
    const auto encoded = QJsonDocument(snapshot).toJson(QJsonDocument::Compact);
    for (const auto *excluded : {"nonexported-repository", "repo-sensor", "board-b", "private-reference",
                                 "nonexported-fingerprint", "observed", "poll", "enabled", "sourceRevision",
                                 "repositories", "knowledge", "work", "verification"})
        check(!encoded.contains(excluded), "snapshot exported data outside its declared metadata allowlist");
    check(bytes(path) == before && lmti::project_snapshot(path, external) == snapshot,
          "snapshot read changed storage or was nondeterministic");
    std::reverse(document.components.begin(), document.components.end());
    std::reverse(document.topology.assets.begin(), document.topology.assets.end());
    document.topology.revision = lmti::save_project(path, document);
    const auto reordered = lmti::project_snapshot(path, external);
    check(reordered["revision"].toInteger() == 2 && reordered["components"] == snapshot["components"] &&
              reordered["assets"] == snapshot["assets"],
          "snapshot identities/order changed with source row order or revision was stale");
    rejects([&] { lmti::project_snapshot(path, {"another-project", "factory-demo", true}); },
            "snapshot accepted a foreign project");
    const auto other_site = lmti::project_snapshot(path, {document.project.id, "other-site", true});
    check(other_site["assets"].toArray().isEmpty() && other_site["bindings"].toArray().isEmpty() &&
              other_site["connections"].toArray().isEmpty() &&
              other_site["components"] == snapshot["components"],
          "snapshot leaked cross-site device data or lost project-wide software scope");

    auto scoped = lmti::demo_project();
    scoped.repositories[0].privacy = lmti::Privacy::Internal;
    scoped.topology.assets[1].privacy = lmti::Privacy::Internal;
    scoped.topology.assets[2].site = "other-site";
    const auto scoped_path = temp.filePath("snapshot-scope.sqlite");
    scoped.topology.revision = lmti::save_project(scoped_path, scoped);
    const auto filtered = lmti::project_snapshot(scoped_path, external);
    const auto filtered_bytes = QJsonDocument(filtered).toJson(QJsonDocument::Compact);
    check(filtered["components"].toArray().size() == 2 && filtered["assets"].toArray().size() == 1 &&
              filtered["releases"].toArray().isEmpty() && filtered["bindings"].toArray().isEmpty() &&
              filtered["dependencies"].toArray().size() == 1 && filtered["connections"].toArray().isEmpty(),
          "snapshot did not filter parent privacy or scoped relationships");
    for (const auto *denied : {"sensor-firmware", "sensor-v020", "sensor-binding", "sensor-gateway",
                               "gateway-b", "broker-c", "link-ab", "link-bc"})
        // Match a complete JSON string: "gateway-b" is denied, while the distinct
        // allowed dependency ID "gateway-backend" must not produce a false positive.
        check(!filtered_bytes.contains(QByteArray("\"") + denied + '"'),
              "denied native ID escaped through a snapshot relationship");
    const auto local = lmti::project_snapshot(scoped_path, {document.project.id, "factory-demo", false});
    check(local["assets"].toArray().size() == 2 && local["connections"].toArray().size() == 1 &&
              snapshot_row(local, "components", "sensor-firmware")["privacy"] == "internal" &&
              snapshot_row(local, "releases", "sensor-v020")["privacy"] == "internal" &&
              snapshot_row(local, "bindings", "sensor-binding")["privacy"] == "internal" &&
              snapshot_row(local, "dependencies", "sensor-gateway")["privacy"] == "internal" &&
              snapshot_row(local, "connections", "link-ab")["privacy"] == "internal",
          "local snapshot did not inherit parent or endpoint privacy");
    scoped.repositories[0].privacy = lmti::Privacy::Public;
    scoped.targets[0].privacy = lmti::Privacy::Internal;
    scoped.topology.revision = lmti::save_project(scoped_path, scoped);
    const auto hidden_target = lmti::project_snapshot(scoped_path, external);
    check(hidden_target["components"].toArray().size() == 3 &&
              hidden_target["releases"].toArray().isEmpty() && hidden_target["bindings"].toArray().isEmpty(),
          "internal hardware target leaked its release or binding");
    scoped.project.privacy = lmti::Privacy::Internal;
    scoped.topology.revision = lmti::save_project(scoped_path, scoped);
    rejects([&] { lmti::project_snapshot(scoped_path, external); },
            "internal project snapshot escaped externally");
    const auto internal = lmti::project_snapshot(scoped_path, {document.project.id, "factory-demo", false});
    for (const auto *category :
         {"components", "assets", "releases", "bindings", "dependencies", "connections"})
        for (const auto &row : internal[category].toArray())
            check(row.toObject()["privacy"] == "internal", "project privacy did not propagate into snapshot");

    const auto missing = temp.filePath("missing-snapshot.sqlite");
    rejects([&] { lmti::project_snapshot(missing, external); }, "missing snapshot source accepted");
    check(!QFile::exists(missing), "snapshot reader initialized missing storage");
    mutate_fixture(path, "UPDATE project SET revision=0");
    rejects([&] { lmti::project_snapshot(path, external); }, "unsaved revision exported");
    mutate_fixture(path, "UPDATE project SET revision=9007199254740992");
    rejects([&] { lmti::project_snapshot(path, external); }, "unsafe JSON revision exported");
    mutate_fixture(path, "UPDATE project SET revision=2");
    mutate_fixture(
        path, "UPDATE components SET label='password=synthetic-invalid-value' WHERE id='sensor-firmware'");
    rejects([&] { lmti::project_snapshot(path, external); }, "unsafe saved metadata exported");

    lmti::ProjectDocument oversized;
    oversized.project = {"oversized", "Synthetic large graph", "", lmti::Privacy::Public};
    for (int i = 0; i < 160; ++i)
        oversized.topology.assets.push_back({"asset-" + std::string(52, 'a') + std::to_string(i), "Synthetic",
                                             "factory-demo", lmti::Kind::Sensor, lmti::Privacy::Public});
    for (int i = 0; i < 160 && oversized.topology.links.size() < 20000; ++i)
        for (int j = 0; j < 160 && oversized.topology.links.size() < 20000; ++j)
            if (i != j)
                oversized.topology.links.push_back(
                    {"link-" + std::string(50, 'b') + std::to_string(oversized.topology.links.size()),
                     oversized.topology.assets[i].id, oversized.topology.assets[j].id,
                     lmti::Protocol::Dependency});
    const auto oversized_path = temp.filePath("oversized-snapshot.sqlite");
    lmti::save_project(oversized_path, oversized);
    const auto oversized_before = bytes(oversized_path);
    rejects([&] { lmti::project_snapshot(oversized_path, {"oversized", "factory-demo", true}); },
            "oversized snapshot was truncated or emitted beyond byte budget");
    check(bytes(oversized_path) == oversized_before, "rejected oversized snapshot changed source");
}
} // namespace
int main(int argc, char **argv) {
    QCoreApplication app(argc, argv);
    QTemporaryDir temp;
    if (!temp.isValid())
        return 1;
    auto path = temp.filePath("project.sqlite");
    auto d = lmti::demo_project();
    d.topology.revision = lmti::save_project(path, d);
    check(d.topology.revision == 1 && lmti::load_project(path) == d, "full document roundtrip lost fields");
    auto source = bytes(path);
    auto context = lmti::project_context(d, {d.project.id, "factory-demo", true, 200});
    check(context["bindings"].toArray().size() == 1, "binding context missing");
    check(context["bindings"].toArray()[0].toObject()["observedVersion"] == "unknown",
          "desired release reported observed");
    check(!QJsonDocument(context).toJson().contains("locator"), "repository locator escaped");
    auto changed = d;
    changed.work[0].state = lmti::WorkState::Review;
    changed.topology.revision = lmti::save_project(path, changed);
    rejects([&] { lmti::save_project(path, d); }, "stale project overwrite accepted");
    check(lmti::load_project(path) == changed, "conflict damaged project");
    auto bad = changed;
    bad.bindings[0].component_id = "monitor-backend";
    rejects([&] { lmti::save_project(path, bad); }, "mismatched binding accepted");
    bad = changed;
    bad.work[0].state = lmti::WorkState::Done;
    rejects([&] { lmti::validate(bad); }, "validation marked Done without evidence");
    bad = changed;
    bad.milestones[0].accepted = true;
    rejects([&] { lmti::validate(bad); }, "milestone accepted without evidence or completed tasks");
    bad.milestones[0].evidence = "synthetic operator review";
    for (auto &w : bad.work) {
        w.state = lmti::WorkState::Done;
        w.evidence = "synthetic result";
    }
    lmti::validate(bad);
    auto accepted_project = bad;
    accepted_project.topology.revision = 0;
    const auto accepted_path = temp.filePath("accepted.sqlite");
    accepted_project.topology.revision = lmti::save_project(accepted_path, accepted_project);
    check(lmti::load_project(accepted_path) == accepted_project,
          "accepted milestone evidence lost on save/open");
    bad = changed;
    bad.milestones[0].due_date = "2026-02-30";
    rejects([&] { lmti::validate(bad); }, "invalid calendar date accepted");
    bad = changed;
    bad.components[0].label = std::string("\xff");
    rejects([&] { lmti::validate(bad); }, "invalid UTF-8 accepted");
    bad = changed;
    bad.repositories[0].locator = "https://user:placeholder@example.invalid/repo";
    rejects([&] { lmti::validate(bad); }, "URL credentials accepted");
    bad = changed;
    bad.repositories[0].privacy = lmti::Privacy::Internal;
    auto filtered = lmti::project_context(bad, {d.project.id, "factory-demo", true, 200});
    check(filtered["bindings"].toArray().isEmpty(), "hidden repository parent leaked bindings");
    bad = changed;
    bad.topology.assets[0].site = "other-site";
    filtered = lmti::project_context(bad, {d.project.id, "factory-demo", true, 200});
    check(filtered["bindings"].toArray().isEmpty() && filtered["work"].toArray().size() == 1,
          "cross-site record leaked");
    rejects([&] { lmti::project_context(d, {"other-project", "factory-demo", true, 200}); },
            "cross-project access accepted");
    bad = changed;
    bad.project.privacy = lmti::Privacy::Internal;
    rejects([&] { lmti::project_context(bad, {d.project.id, "factory-demo", true, 200}); },
            "internal project exposed externally");
    lmti::WorkProposal proposal{d.project.id, "validate-sampling", 2, lmti::WorkState::Review,
                                lmti::WorkState::Blocked};
    auto proposed = lmti::apply_proposal(changed, proposal);
    check(proposed.work[0].state == lmti::WorkState::Blocked && lmti::load_project(path) == changed,
          "proposal persisted itself");
    proposal.revision = 1;
    rejects([&] { lmti::apply_proposal(changed, proposal); }, "stale proposal accepted");
    proposal.revision = 2;
    proposal.desired = lmti::WorkState::Done;
    rejects([&] { lmti::apply_proposal(changed, proposal); }, "Agent could claim completion");
    auto json = lmti::work_proposal_json(
        {d.project.id, "validate-sampling", 2, lmti::WorkState::Review, lmti::WorkState::Blocked});
    json["command"] = "unused";
    rejects([&] { lmti::parse_work_proposal(json); }, "arbitrary proposal field accepted");
    changed.releases[0].state = lmti::ReleaseState::Approved;
    changed.topology.revision = lmti::save_project(path, changed);
    bad = changed;
    bad.releases[0].source_revision = "modified";
    rejects([&] { lmti::save_project(path, bad); }, "approved release altered");
    check(lmti::load_project(path) == changed, "rejected edit changed saved project");
    const auto legacy = temp.filePath("legacy.sqlite");
    auto topology = lmti::demo_topology();
    topology.revision = lmti::save(legacy, topology);
    auto original = bytes(legacy);
    rejects([&] { lmti::load_project(legacy); }, "legacy schema mistaken for project");
    rejects([&] { lmti::load(path); }, "project schema silently loaded by legacy reader");
    rejects([&] { lmti::save(legacy, changed.topology); }, "legacy stale revision unexpectedly written");
    auto imported = lmti::demo_project();
    imported.topology = lmti::load(legacy);
    imported.topology.revision = 0;
    imported.topology.revision = lmti::save_project(temp.filePath("import.sqlite"), imported);
    check(bytes(legacy) == original, "project import changed legacy source");
    const auto catalog = temp.filePath("catalog.sqlite");
    lmti::remember_project(catalog, {QString::fromStdString(d.project.id), "Demo", path});
    lmti::remember_project(catalog,
                           {QString::fromStdString(d.project.id), "Renamed", temp.filePath("copy.sqlite")});
    check(lmti::recent_projects(catalog).size() == 1,
          "Save as created duplicate project identity in catalog");
    const auto library = temp.filePath("library.sqlite");
    const auto catalog_before = bytes(catalog);
    lmti::import_recent_library(catalog, library);
    check(bytes(catalog) == catalog_before && lmti::project_library(library).size() == 1,
          "legacy library import changed its source or lost entries");
    // Imported missing locators remain repairable; importing again never revives removed refs.
    lmti::forget_library_project(library, QString::fromStdString(d.project.id));
    lmti::import_recent_library(catalog, library);
    check(lmti::project_library(library).empty(), "removed reference was revived by legacy import");
    for (int i = 0; i < 35; ++i)
        lmti::remember_library_project(library,
                                       {"library-" + QString::number(i), "Synthetic project", path, {}});
    lmti::pin_library_project(library, "library-0", true);
    lmti::link_library_folder(library, "library-0", temp.path());
    lmti::remember_library_project(library, {"library-0", "Updated label", path, {}});
    auto entries = lmti::project_library(library);
    check(entries.size() == 35 && entries.front().id == "library-0" && entries.front().pinned &&
              entries.front().folder == lmti::checked_project_folder(temp.path()),
          "library truncated projects or lost pin/folder on save");
    rejects([&] { lmti::link_library_folder(library, "library-1", temp.path()); },
            "folder owned by two project identities");
#ifdef Q_OS_WIN
    rejects([&] { lmti::link_library_folder(library, "library-1", temp.path().toUpper()); },
            "case alias bypassed folder uniqueness");
#endif
    auto document_before_forget = bytes(path);
    lmti::forget_library_project(library, "library-0");
    check(bytes(path) == document_before_forget && QDir(temp.path()).exists(),
          "forget deleted document/folder");
    rejects([&] { lmti::project_library(catalog); }, "legacy catalog silently upgraded by library reader");
    check(bytes(catalog) == catalog_before, "unsupported library read changed source");
    rejects([&] { lmti::remember_library_project(library, {"unsafe", "Name", "relative.sqlite", {}}); },
            "relative library path accepted");
    auto dense = lmti::demo_project();
    for (int i = 0; i < 220; ++i)
        dense.components.push_back({"component-" + std::to_string(i), "Synthetic component", "",
                                    lmti::ComponentKind::Library, lmti::Privacy::Public});
    auto bounded = lmti::project_context(dense, {dense.project.id, "factory-demo", true, 100});
    check(bounded["truncated"].toBool() && bounded["components"].toArray().size() == 100,
          "component output not bounded");
    dense.dependencies.push_back(
        {"cycle", "monitor-backend", "sensor-firmware", "declared", lmti::Privacy::Public});
    check(lmti::project_impact(dense, {dense.project.id, "factory-demo", true, 200},
                               "sensor-firmware")["affectedComponentIds"]
                  .toArray()
                  .size() == 3,
          "cyclic dependency query failed");
    check(!source.isEmpty(), "fixture not written");
    snapshot_tests(temp);
    reference_snapshot_tests(temp);
    metadata_tests(temp);
    return failures ? 1 : 0;
}
