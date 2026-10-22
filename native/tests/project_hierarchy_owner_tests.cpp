#include "lmti/project_store.hpp"
#include "lmti/project_copy.hpp"
#include <QCoreApplication>
#include <QDir>
#include <QFile>
#include <QFileInfo>
#include <QJsonArray>
#include <QJsonDocument>
#include <QSqlDatabase>
#include <QSqlQuery>
#include <QUuid>
#include <QTemporaryDir>
#include <algorithm>
#include <filesystem>
#include <functional>
#include <iostream>
#include <iterator>
#include <optional>
#include <stdexcept>
#include <string>

#ifndef LMTI_HIERARCHY_OWNER_TEST_HOOKS
#error This suite requires the isolated hierarchy owner test target.
#endif

namespace {
using namespace lmti;
int failures = 0;
int checks = 0;
int skips = 0;
void check(bool ok, const char *message) {
    ++checks;
    if (!ok) { ++failures; std::cerr << message << '\n'; }
}
void require(bool ok, const char *message) {
    if (!ok) throw std::runtime_error(message);
}
QByteArray bytes(const QString &path) {
    QFile file(path);
    require(file.open(QIODevice::ReadOnly), "Disposable fixture read failed.");
    return file.readAll();
}
// Every SQL statement and file mutation below applies only to this test's
// QTemporaryDir. Production hierarchy requests never accept SQL or registry rows.
class Sql {
    QString name_ = QUuid::createUuid().toString();
  public:
    QSqlDatabase db;
    explicit Sql(const QString &path) {
        require(QFileInfo::exists(path), "Disposable SQL fixture must already exist.");
        db = QSqlDatabase::addDatabase("QSQLITE", name_);
        db.setDatabaseName(path);
        db.setConnectOptions("QSQLITE_BUSY_TIMEOUT=0");
        require(db.open(), "Disposable SQL fixture open failed.");
    }
    ~Sql() { db.close(); db = {}; QSqlDatabase::removeDatabase(name_); }
    bool run(const QString &statement) { QSqlQuery q(db); return q.exec(statement); }
    QVariant scalar(const QString &statement) {
        QSqlQuery q(db);
        require(q.exec(statement) && q.next(), "Disposable SQL fixture query failed.");
        return q.value(0);
    }
};
QVariant sql(const QString &path, const QString &statement) {
    Sql db(path); return db.scalar(statement);
}
void mutate(const QString &path, const QString &statement) {
    Sql db(path); require(db.run(statement), "Disposable SQL fixture mutation failed.");
}
QByteArray reject(const std::function<void()> &call, HierarchyCode expected, const char *message) {
    try { call(); check(false, message); }
    catch (const HierarchyError &error) {
        ++checks;
        if (error.code() != expected) {
            ++failures;
            std::cerr << message << "; expected=" << static_cast<int>(expected)
                      << "; actual=" << static_cast<int>(error.code()) << '\n';
        }
        const QByteArray text(error.what());
        check(text.size() <= 128 && !text.contains("fixture-private") && !text.contains(".sqlite") &&
                  !text.contains("SELECT") && !text.contains("identity_registry"),
              "hierarchy refusal exposed private storage details");
        return text;
    }
    catch (const lmti::Error &) { check(false, "owner refusal bypassed HierarchyError"); }
    return {};
}
void storage_reject(const std::function<void()> &call, const char *message) {
    try { call(); check(false, message); } catch (const lmti::Error &) {}
}
LogicalHierarchyScope scope(bool internal = true) { return {"factory-monitor", true, internal}; }
const Subsystem &subsystem(const ProjectDocument &d, const std::string &id) {
    const auto &rows = d.structure.value().subsystems;
    const auto it = std::find_if(rows.begin(), rows.end(), [&](const auto &row) { return row.id == id; });
    require(it != rows.end(), "Fixture subsystem missing."); return *it;
}
const SoftwareComponent &component(const ProjectDocument &d, const std::string &id) {
    const auto it = std::find_if(d.components.begin(), d.components.end(), [&](const auto &row) { return row.id == id; });
    require(it != d.components.end(), "Fixture component missing."); return *it;
}
std::optional<ComponentMembership> membership(const ProjectDocument &d, const std::string &id) {
    for (const auto &row : d.structure.value().component_memberships)
        if (row.component_id == id) return row;
    return std::nullopt;
}
LogicalHierarchyProposal proposal(const ProjectDocument &d, std::vector<LogicalHierarchyChange> changes) {
    return {d.project.id, d.topology.revision, std::move(changes)};
}
LogicalHierarchyProposal rename(const ProjectDocument &d, const std::string &label = "Reviewed label") {
    return proposal(d, {RenameSubsystem{subsystem(d, "public-child"), label}});
}
ProjectDocument fixture() {
    auto d = demo_project();
    d.repositories.front().locator = "fixture-private-repository";
    d.releases.front().state = ReleaseState::Approved;
    d.verification = {{"checked", "sensor-v020", "machine-a", "Synthetic retained evidence", "operator",
                       17, EvidenceResult::Passed, Privacy::Internal}};
    d.knowledge = {{"design", "Design", "sensor-firmware", "fixture-private-reference",
                    "fixture-private-fingerprint", Privacy::Public}};
    d.components[1].privacy = Privacy::Internal;
    // Valid dependency cycles do not imply containment cycles or membership.
    d.dependencies.push_back({"return-contract", "gateway-agent", "sensor-firmware", "response", Privacy::Public});
    d.structure.emplace();
    auto &s = *d.structure;
    s.subsystems = {
        {"public-child", "Visible leaf", "public-root", Privacy::Public},
        {"private-child", "Private inherited leaf", "private-root", Privacy::Public},
        {"empty-retire", "Reusable label", "", Privacy::Public},
        {"private-second", "Private second root", "", Privacy::Internal},
        {"private-root", "Private root", "", Privacy::Internal},
        {"public-root", "Visible root", "", Privacy::Public},
        {"public-second", "Visible second root", "", Privacy::Public}};
    s.component_memberships = {{"sensor-firmware", "public-child"}, {"gateway-agent", "private-child"}};
    s.sites = {{"factory-demo", "Factory", Privacy::Public}};
    s.areas = {{"cell", "Cell", "factory-demo", "floor", Privacy::Public},
               {"floor", "Floor", "factory-demo", "", Privacy::Public}};
    s.environments = {{"test", "Test", Privacy::Public}};
    s.asset_placements = {{"machine-a", "cell", "gateway-b", "test", PhysicalRole::Device},
                          {"gateway-b", "cell", "broker-c", "test", PhysicalRole::Gateway},
                          {"broker-c", "cell", "", "test", PhysicalRole::Host}};
    validate(d);
    return d;
}
ProjectDocument create(const QString &path) {
    auto d = fixture();
    d.topology.revision = save_project(path, d);
    return load_project(path);
}
void normalize_rows(ProjectDocument &d) {
    if (!d.structure) return;
    auto &s = *d.structure;
    std::sort(s.subsystems.begin(), s.subsystems.end(), [](const auto &a, const auto &b) { return a.id < b.id; });
    std::sort(s.component_memberships.begin(), s.component_memberships.end(),
              [](const auto &a, const auto &b) { return a.component_id < b.component_id; });
}
void equal_document(ProjectDocument actual, ProjectDocument expected, const char *message) {
    normalize_rows(actual); normalize_rows(expected);
    check(actual == expected, message);
}
void unchanged(const QString &path, const QByteArray &before, const ProjectDocument &d, const char *message) {
    check(bytes(path) == before, message);
    equal_document(load_project(path), d, message);
}
void committed(const HierarchyCommitResult &r, std::int64_t revision) {
    check(r.state == HierarchyCommitState::Committed && r.revision == revision,
          "known hierarchy commit did not return its one new revision");
}
QJsonObject row(const QJsonObject &snapshot, const char *group, const char *id) {
    for (const auto &value : snapshot[group].toArray())
        if (value.toObject()["id"] == id) return value.toObject();
    return {};
}

void mixed_batch(const QTemporaryDir &temp) {
    const auto path = temp.filePath("mixed.sqlite");
    auto d = create(path);
    const auto original = bytes(path);
    const auto p = proposal(d, {
        // Child deliberately precedes its newly added parent.
        AddSubsystem{{"new-child", "New child", "new-parent", Privacy::Internal}},
        RenameSubsystem{subsystem(d, "public-child"), "Renamed visible leaf"},
        ReparentSubsystem{subsystem(d, "private-child"), "private-second"},
        SetComponentMembership{component(d, "monitor-backend"), std::nullopt, std::string("new-child")},
        RetireEmptySubsystem{subsystem(d, "empty-retire")},
        AddSubsystem{{"new-parent", "New parent", "", Privacy::Internal}}});
    const auto review = preview_logical_hierarchy(path, scope(), p);
    check(review.reviewed_revision() == 1 && review.proposal().expected_revision == 1 &&
              review.proposal().changes.size() == 6, "review lost pinned revision or normalized batch");
    check(review.diff().subsystems.size() == 5 && review.diff().memberships.size() == 1,
          "review diff omitted one of the five typed operation kinds");
    bool descendant_reviewed = false;
    for (const auto &a : review.diff().affected)
        if (a.kind == HierarchyEntityKind::Component && a.id == "gateway-agent") {
            descendant_reviewed = a.before_classification == Privacy::Internal &&
                a.after_classification == Privacy::Internal &&
                a.before_ancestors == std::vector<std::string>{"private-root", "private-child"} &&
                a.after_ancestors == std::vector<std::string>{"private-second", "private-child"};
        }
    check(descendant_reviewed, "reparent review omitted unchanged-classification descendant paths");
    auto reversed = p; std::reverse(reversed.changes.begin(), reversed.changes.end());
    const auto reordered = preview_logical_hierarchy(path, scope(), reversed);
    check(review.proposal() == reordered.proposal() && review.diff() == reordered.diff(),
          "normalized review depends on input operation order");
    unchanged(path, original, d, "preview or discarded review wrote graph/registry");
    const auto copied_review = review;
    committed(commit_logical_hierarchy(path, scope(), review), 2);
    auto expected = d;
    auto &s = *expected.structure;
    s.subsystems.push_back({"new-parent", "New parent", "", Privacy::Internal});
    s.subsystems.push_back({"new-child", "New child", "new-parent", Privacy::Internal});
    for (auto &item : s.subsystems) {
        if (item.id == "public-child") item.label = "Renamed visible leaf";
        if (item.id == "private-child") item.parent_subsystem_id = "private-second";
    }
    std::erase_if(s.subsystems, [](const auto &item) { return item.id == "empty-retire"; });
    s.component_memberships.push_back({"monitor-backend", "new-child"});
    expected.topology.revision = 2;
    equal_document(load_project(path), expected, "typed batch changed unrelated fields, privacy or lineage");
    check(sql(path, "SELECT state FROM identity_registry WHERE kind='subsystem' AND entity_id='empty-retire'").toString() == "retired" &&
              sql(path, "SELECT state FROM identity_registry WHERE kind='subsystem' AND entity_id='new-child'").toString() == "active",
          "batch graph and identity registry did not commit together");
    const auto saved = bytes(path);
    reject([&] { commit_logical_hierarchy(path, scope(), copied_review); }, HierarchyCode::Conflict,
           "copied review replayed a known successful commit");
    unchanged(path, saved, expected, "replayed review changed committed state");
}

void expected_values_and_rival(const QTemporaryDir &temp) {
    const auto path = temp.filePath("expected.sqlite");
    auto d = create(path);
    const auto before = bytes(path);
    auto wrong = subsystem(d, "public-child"); wrong.label = "Not the saved label";
    reject([&] { preview_logical_hierarchy(path, scope(), proposal(d, {RenameSubsystem{wrong, "New"}})); },
           HierarchyCode::Conflict, "wrong expected subsystem row accepted");
    auto wrong_component = component(d, "sensor-firmware"); wrong_component.label = "Old component changed";
    reject([&] { preview_logical_hierarchy(path, scope(), proposal(d, {
        SetComponentMembership{wrong_component, membership(d, "sensor-firmware"), std::string("public-root")}})); },
        HierarchyCode::Conflict, "inexact expected component row accepted");
    reject([&] { preview_logical_hierarchy(path, scope(), proposal(d, {
        SetComponentMembership{component(d, "sensor-firmware"), std::nullopt, std::string("public-root")}})); },
        HierarchyCode::Conflict, "wrong expected optional membership accepted");
    auto wrong_revision = rename(d); ++wrong_revision.expected_revision;
    reject([&] { preview_logical_hierarchy(path, scope(), wrong_revision); }, HierarchyCode::Conflict,
           "stale expected revision accepted at preview");
    unchanged(path, before, d, "expected-value refusal wrote source");
    const auto first = preview_logical_hierarchy(path, scope(), rename(d, "First owner"));
    const auto rival = preview_logical_hierarchy(path, scope(), rename(d, "Second owner"));
    committed(commit_logical_hierarchy(path, scope(), first), 2);
    const auto winner = load_project(path);
    const auto won_bytes = bytes(path);
    reject([&] { commit_logical_hierarchy(path, scope(), rival); }, HierarchyCode::Conflict,
           "second reviewed writer overwrote winning revision");
    unchanged(path, won_bytes, winner, "stale writer modified winner");
    auto changed_scope = scope(); changed_scope.allow_internal = false;
    const auto fresh = preview_logical_hierarchy(path, scope(), rename(winner));
    reject([&] { commit_logical_hierarchy(path, changed_scope, fresh); }, HierarchyCode::ScopeDenied,
           "commit silently substituted a different trusted scope");
    // Refusal before DML does not consume a valid review.
    committed(commit_logical_hierarchy(path, scope(), fresh), 3);
}

void same_path_replacement_and_graph_drift(const QTemporaryDir &temp) {
    const auto a = temp.filePath("identity-a.sqlite"), b = temp.filePath("identity-b.sqlite");
    const auto original = create(a), other = create(b);
    require(original.storage_lineage->store_uuid != other.storage_lineage->store_uuid, "Independent store UUID fixture failed.");
    const auto review = preview_logical_hierarchy(a, scope(), rename(original));
    const auto retained = temp.filePath("identity-a-retained.sqlite");
    require(QFile::rename(a, retained) && QFile::copy(b, a), "Disposable same-path replacement failed.");
    const auto replacement = load_project(a);
    const auto before = bytes(a), retained_bytes = bytes(retained);
    reject([&] { commit_logical_hierarchy(a, scope(), review); }, HierarchyCode::Conflict,
           "same project/revision/graph with different store UUID accepted");
    unchanged(a, before, replacement, "same-path identity refusal changed replacement");
    check(bytes(retained) == retained_bytes, "identity refusal changed retained original");

    const auto path = temp.filePath("graph-drift.sqlite");
    auto d = create(path);
    const auto stale = preview_logical_hierarchy(path, scope(), rename(d));
    mutate(path, "UPDATE knowledge SET fingerprint='fixture-changed-fingerprint' WHERE id='design'");
    const auto drifted = load_project(path);
    const auto drift_bytes = bytes(path);
    check(drifted.topology.revision == d.topology.revision && drifted.storage_lineage == d.storage_lineage,
          "graph drift fixture accidentally changed token revision/UUID");
    reject([&] { commit_logical_hierarchy(path, scope(), stale); }, HierarchyCode::Conflict,
           "same-revision unrelated owned graph drift was ignored");
    unchanged(path, drift_bytes, drifted, "graph digest refusal changed current source");
}

void registry_drift_and_corruption(const QTemporaryDir &temp) {
    const auto path = temp.filePath("registry-drift.sqlite");
    auto d = create(path);
    const auto review = preview_logical_hierarchy(path, scope(), rename(d));
    mutate(path, "INSERT INTO identity_registry VALUES('subsystem','retired-outside-review','retired')");
    equal_document(load_project(path), d, "retired-only registry fixture changed public graph");
    const auto before = bytes(path);
    reject([&] { commit_logical_hierarchy(path, scope(), review); }, HierarchyCode::Conflict,
           "private registry-only drift was ignored");
    unchanged(path, before, d, "registry-token refusal changed tombstone history");
    reject([&] { preview_logical_hierarchy(path, scope(), proposal(d, {
        AddSubsystem{{"retired-outside-review", "New label", "", Privacy::Internal}}})); },
        HierarchyCode::Conflict, "fresh review reused a retired-only identity");
    const auto fresh = preview_logical_hierarchy(path, scope(), rename(d));
    mutate(path, "DELETE FROM identity_registry WHERE kind='subsystem' AND entity_id='public-child'");
    const auto corrupt = bytes(path);
    reject([&] { commit_logical_hierarchy(path, scope(), fresh); }, HierarchyCode::OwnerUnavailable,
           "commit repaired malformed registry instead of refusing");
    check(bytes(path) == corrupt, "malformed registry refusal changed source bytes");
}

void missing_schema_and_paths(const QTemporaryDir &temp) {
    auto d = fixture(); d.topology.revision = 1;
    const auto missing = temp.filePath("missing.sqlite");
    reject([&] { preview_logical_hierarchy(missing, scope(), rename(d)); }, HierarchyCode::OwnerUnavailable,
           "missing store accepted");
    auto malformed = rename(d); malformed.changes.clear();
    reject([&] { preview_logical_hierarchy(missing, scope(), malformed); }, HierarchyCode::InvalidArgument,
           "invalid typed request was not rejected before filesystem access");
    check(!QFileInfo::exists(missing) && !QFileInfo::exists(missing + "-journal"),
          "preview created a missing store or journal");
    const auto flat_path = temp.filePath("flat.sqlite");
    auto flat = demo_project(); flat.topology.revision = save_project(flat_path, flat);
    const auto flat_before = bytes(flat_path);
    reject([&] { preview_logical_hierarchy(flat_path, scope(), rename(d)); }, HierarchyCode::Unsupported,
           "schema1 silently gained hierarchy");
    check(bytes(flat_path) == flat_before && sql(flat_path, "PRAGMA user_version").toInt() == 1,
          "schema1 refusal upgraded or changed source");
    const auto path = temp.filePath("path-source.sqlite");
    d = create(path);
    const auto pristine = bytes(path);
    reject([&] { preview_logical_hierarchy(temp.path() + "/../path-source.sqlite", scope(), rename(d)); },
           HierarchyCode::OwnerUnavailable, "lexical parent traversal reached storage");
    reject([&] { preview_logical_hierarchy(path + ":stream", scope(), rename(d)); },
           HierarchyCode::OwnerUnavailable, "alternate stream spelling reached storage");
    unchanged(path, pristine, d, "path refusal changed valid source");
    const auto review = preview_logical_hierarchy(path, scope(), rename(d));
    reject([&] { commit_logical_hierarchy(missing, scope(), review); }, HierarchyCode::OwnerUnavailable,
           "review retargeted to a missing file");
    check(!QFileInfo::exists(missing), "retargeted commit created destination");
    auto no_grant = scope(); no_grant.allow_logical_write = false;
    reject([&] { preview_logical_hierarchy(path, no_grant, rename(d)); }, HierarchyCode::ScopeDenied,
           "read/copy capability implicitly authorized logical write");
    auto wrong_project = scope(); wrong_project.project_id = "other-project";
    reject([&] { preview_logical_hierarchy(path, wrong_project, rename(d)); }, HierarchyCode::ScopeDenied,
           "other-project trusted scope authorized edit");
    mutate(path, "CREATE TABLE sqliteXextra(value TEXT)");
    const auto before = bytes(path);
    reject([&] { preview_logical_hierarchy(path, scope(), rename(d)); }, HierarchyCode::OwnerUnavailable,
           "snapshot hid unsupported extension data");
    check(bytes(path) == before, "unsupported schema refusal wrote source");
}

void retirement_reopen_and_clone(const QTemporaryDir &temp) {
    const auto path = temp.filePath("retirement.sqlite");
    auto d = create(path);
    // Public stored row inherits Internal; its Internal component may explicitly
    // become unassigned without reducing that component's classification.
    const auto p = proposal(d, {
        RetireEmptySubsystem{subsystem(d, "private-child")},
        SetComponentMembership{component(d, "gateway-agent"), membership(d, "gateway-agent"), std::nullopt}});
    committed(commit_logical_hierarchy(path, scope(), preview_logical_hierarchy(path, scope(), p)), 2);
    const auto reopened = load_project(path);
    const auto before = bytes(path);
    check(!membership(reopened, "gateway-agent") &&
              sql(path, "SELECT state FROM identity_registry WHERE kind='subsystem' AND entity_id='private-child'").toString() == "retired",
          "detach+retire did not atomically persist tombstone and unassignment");
    const auto reuse = proposal(reopened, {AddSubsystem{{"private-child", "Same label", "", Privacy::Internal}}});
    reject([&] { preview_logical_hierarchy(path, scope(), reuse); }, HierarchyCode::Conflict,
           "reopened owner reused retired identity");
    d.topology.revision = reopened.topology.revision;
    storage_reject([&] { save_project(path, d); }, "rebased old document resurrected committed retirement");
    unchanged(path, before, reopened, "retired-ID refusal changed graph/history");
    const auto copy_parent = temp.filePath("clones");
    require(QDir(temp.path()).mkdir("clones"), "Disposable clone parent failed.");
    const auto copy = prepare_project_copy(path, copy_parent, inspect_project_copy(path, ProjectCopyMode::CloneV2));
    require(copy.state == ProjectCopyState::Prepared && copy.verified_receipt, "Real native clone did not prepare.");
    const auto copy_path = QDir(QDir(copy_parent).filePath(copy.operation_id)).filePath("project.sqlite");
    const auto cloned = load_project(copy_path);
    const auto copy_before = bytes(copy_path);
    check(cloned.topology.revision == 3 && cloned.storage_lineage->store_uuid != reopened.storage_lineage->store_uuid,
          "clone did not retain project revision lineage with a new store UUID");
    reject([&] { preview_logical_hierarchy(copy_path, scope(), proposal(cloned, reuse.changes)); },
           HierarchyCode::Conflict, "hierarchy owner reused retired identity after native clone");
    check(bytes(copy_path) == copy_before && bytes(path) == before,
          "clone reuse refusal changed copy or source");
    committed(commit_logical_hierarchy(path, scope(), preview_logical_hierarchy(path, scope(),
        proposal(reopened, {AddSubsystem{{"replacement-child", "Private inherited leaf", "", Privacy::Internal}}}))), 3);
    check(sql(path, "SELECT state FROM identity_registry WHERE kind='subsystem' AND entity_id='private-child'").toString() == "retired",
          "same-label new-ID replacement erased tombstone");
}

void policy_and_noops(const QTemporaryDir &temp) {
    const auto path = temp.filePath("policy.sqlite");
    auto d = create(path);
    const auto before = bytes(path);
    reject([&] { preview_logical_hierarchy(path, scope(), rename(d, subsystem(d, "public-child").label)); },
           HierarchyCode::InvalidArgument, "no-op rename accepted");
    reject([&] { preview_logical_hierarchy(path, scope(), proposal(d, {
        ReparentSubsystem{subsystem(d, "public-root"), "public-child"}})); },
        HierarchyCode::InvalidArgument, "containment cycle accepted");
    reject([&] { preview_logical_hierarchy(path, scope(), proposal(d, {
        RetireEmptySubsystem{subsystem(d, "public-root")}})); },
        HierarchyCode::Conflict, "nonempty parent retired implicitly");
    reject([&] { preview_logical_hierarchy(path, scope(), proposal(d, {
        ReparentSubsystem{subsystem(d, "private-child"), "public-root"}})); },
        HierarchyCode::ScopeDenied, "reparent silently lowered inherited classification");
    reject([&] { preview_logical_hierarchy(path, scope(), proposal(d, {
        SetComponentMembership{component(d, "sensor-firmware"), membership(d, "sensor-firmware"), std::string("missing")}})); },
        HierarchyCode::ScopeDenied, "missing destination accepted");
    const auto hidden = reject([&] { preview_logical_hierarchy(path, scope(false), proposal(d, {
        RenameSubsystem{subsystem(d, "private-child"), "Hidden change"}})); },
        HierarchyCode::ScopeDenied, "hidden ancestor allowed review");
    auto absent = subsystem(d, "private-child"); absent.id = "missing";
    const auto missing = reject([&] { preview_logical_hierarchy(path, scope(false), proposal(d, {
        RenameSubsystem{absent, "Hidden change"}})); },
        HierarchyCode::ScopeDenied, "missing row accepted");
    check(!hidden.isEmpty() && hidden == missing, "missing and denied hierarchy refusals differ");
    unchanged(path, before, d, "policy/no-op refusal changed source");
    // A visible root has an Internal descendant; reviewing only the selected
    // public row must not authorize moving that complete subtree.
    auto hidden_tree = d;
    hidden_tree.structure->subsystems.push_back({"hidden-descendant", "Hidden leaf", "public-root", Privacy::Internal});
    hidden_tree.topology.revision = save_project(path, hidden_tree);
    const auto hidden_before = bytes(path);
    reject([&] { preview_logical_hierarchy(path, scope(false), proposal(hidden_tree, {
        ReparentSubsystem{subsystem(hidden_tree, "public-root"), "public-second"}})); },
        HierarchyCode::ScopeDenied, "hidden descendant omitted from affected authorization");
    unchanged(path, hidden_before, hidden_tree, "hidden descendant refusal changed subtree");
}

void v3_after_membership_change(const QTemporaryDir &temp) {
    const auto path = temp.filePath("projection.sqlite");
    const auto d = create(path);
    const auto initial = project_structure_snapshot(path, {d.project.id, "factory-demo", true});
    check(!row(initial, "components", "sensor-firmware").isEmpty(), "fixture public component unexpectedly hidden");
    const auto p = proposal(d, {SetComponentMembership{component(d, "sensor-firmware"),
        membership(d, "sensor-firmware"), std::string("private-child")}});
    const auto review = preview_logical_hierarchy(path, scope(), p);
    bool complete_paths = false;
    for (const auto &a : review.diff().affected)
        if (a.id == "sensor-firmware" && a.kind == HierarchyEntityKind::Component)
            complete_paths = a.before_classification == Privacy::Public && a.after_classification == Privacy::Internal &&
                a.before_ancestors == std::vector<std::string>{"public-root", "public-child"} &&
                a.after_ancestors == std::vector<std::string>{"private-root", "private-child"};
    check(complete_paths, "membership review omitted inherited old/new paths");
    committed(commit_logical_hierarchy(path, scope(), review), 2);
    const auto external = project_structure_snapshot(path, {d.project.id, "factory-demo", true});
    const auto local = project_structure_snapshot(path, {d.project.id, "factory-demo", false});
    check(external["revision"] == 2 && local["revision"] == 2 &&
              row(external, "components", "sensor-firmware").isEmpty() &&
              row(external, "knowledge", "design").isEmpty() &&
              row(external, "bindings", "sensor-binding").isEmpty() &&
              row(external, "releases", "sensor-v020").isEmpty(),
          "v3 read after hierarchy commit leaked inherited component/reference endpoints");
    check(row(local, "components", "sensor-firmware")["subsystemId"] == "private-child" &&
              row(local, "components", "sensor-firmware")["privacy"] == "internal" &&
              row(local, "subsystems", "private-child")["parentSubsystemId"] == "private-root" &&
              row(local, "knowledge", "design")["privacy"] == "internal",
          "v3 local read lost saved path or inherited privacy");
    const auto after = load_project(path);
    const auto before = bytes(path);
    reject([&] { preview_logical_hierarchy(path, scope(), proposal(after, {
        SetComponentMembership{component(after, "sensor-firmware"), membership(after, "sensor-firmware"), std::nullopt}})); },
        HierarchyCode::ScopeDenied, "membership unassignment silently declassified Public component");
    const auto encoded = QJsonDocument(local).toJson(QJsonDocument::Compact);
    check(!encoded.contains(after.storage_lineage->store_uuid.c_str()) &&
              !encoded.contains(path.toUtf8()) && !encoded.contains("identity_registry") &&
              !encoded.contains("fixture-private"),
          "new hierarchy write caused projection to leak private owner state");
    unchanged(path, before, after, "declassification refusal changed saved component membership");
}

void repository_privacy_agrees_with_v3(const QTemporaryDir &temp) {
    const auto path = temp.filePath("repository-privacy.sqlite");
    auto d = fixture();
    d.repositories.front().privacy = Privacy::Internal;
    d.topology.revision = save_project(path, d);
    d = load_project(path);
    const auto before = bytes(path);
    const auto external = project_structure_snapshot(path, {d.project.id, "factory-demo", true});
    const auto local = project_structure_snapshot(path, {d.project.id, "factory-demo", false});
    check(row(external, "components", "sensor-firmware").isEmpty() &&
              row(local, "components", "sensor-firmware")["privacy"] == "internal",
          "private repository fixture does not exercise existing v3 inheritance");
    const auto p = proposal(d, {SetComponentMembership{component(d, "sensor-firmware"),
        membership(d, "sensor-firmware"), std::string("public-root")}});
    reject([&] { preview_logical_hierarchy(path, scope(false), p); }, HierarchyCode::ScopeDenied,
           "public-only hierarchy review exposed component hidden by private repository");
    const auto review = preview_logical_hierarchy(path, scope(), p);
    bool inherited_repository = false;
    for (const auto &a : review.diff().affected)
        if (a.kind == HierarchyEntityKind::Component && a.id == "sensor-firmware")
            inherited_repository = a.before_classification == Privacy::Internal &&
                a.after_classification == Privacy::Internal;
    check(inherited_repository, "hierarchy review mislabeled private-repository component as Public");
    unchanged(path, before, d, "repository authorization preview changed source");
    committed(commit_logical_hierarchy(path, scope(), review), 2);
    const auto current = project_structure_snapshot(path, {d.project.id, "factory-demo", false});
    check(row(current, "components", "sensor-firmware")["subsystemId"] == "public-root" &&
              row(current, "components", "sensor-firmware")["privacy"] == "internal",
          "reviewed owner and v3 projection disagree after private-repository membership edit");
}

using Point = HierarchyOwnerTestPoint;
QString hook_path;
std::optional<Point> throw_at;
bool before_seen = false, after_seen = false, rival_was_refused = false;
void hook(Point point) {
    if (point == Point::BeforeCommit) {
        before_seen = true;
        Sql rival(hook_path);
        const bool locked = rival.run("BEGIN IMMEDIATE");
        rival_was_refused = !locked;
        if (locked) rival.run("ROLLBACK");
    } else after_seen = true;
    if (throw_at == point) throw lmti::Error("Injected isolated hierarchy failure.");
}
struct HookScope {
    explicit HookScope(const QString &path, std::optional<Point> fault) {
        hook_path = path; throw_at = fault;
        before_seen = after_seen = rival_was_refused = false;
        set_hierarchy_owner_test_hook(hook);
    }
    ~HookScope() {
        set_hierarchy_owner_test_hook(nullptr); hook_path.clear(); throw_at.reset();
    }
};
void transaction_faults_and_locks(const QTemporaryDir &temp) {
    const auto path = temp.filePath("transaction.sqlite");
    const auto d = create(path), before_doc = d;
    const auto before = bytes(path);
    const auto p = proposal(d, {RetireEmptySubsystem{subsystem(d, "empty-retire")},
        AddSubsystem{{"atomic-new", "Atomic new", "", Privacy::Internal}}});
    const auto rollback_review = preview_logical_hierarchy(path, scope(), p);
    const auto copied_rollback_review = rollback_review;
    {
        HookScope installed(path, Point::BeforeCommit);
        reject([&] { commit_logical_hierarchy(path, scope(), rollback_review); }, HierarchyCode::OwnerUnavailable,
               "before-COMMIT injected failure did not report bounded known refusal");
        check(before_seen && !after_seen && rival_was_refused,
              "before-COMMIT hook did not execute under actual SQLite writer reservation");
    }
    unchanged(path, before, before_doc, "pre-COMMIT fault did not roll back graph/revision/registry together");
    check(sql(path, "SELECT count(*) FROM identity_registry WHERE entity_id='atomic-new'").toInt() == 0 &&
              sql(path, "SELECT state FROM identity_registry WHERE kind='subsystem' AND entity_id='empty-retire'").toString() == "active",
          "rollback left added/retired registry rows");
    reject([&] { commit_logical_hierarchy(path, scope(), copied_rollback_review); }, HierarchyCode::Conflict,
           "copied attempted review replayed after known rollback");
    const auto unknown_review = preview_logical_hierarchy(path, scope(), p);
    const auto copied_review = unknown_review;
    {
        HookScope installed(path, Point::AfterCommit);
        const auto result = commit_logical_hierarchy(path, scope(), unknown_review);
        check(result.state == HierarchyCommitState::Unknown && result.revision == 0,
              "actual post-COMMIT fault was mislabeled rollback or known success");
        check(before_seen && after_seen && rival_was_refused, "post-COMMIT fault fixture missed real transaction path");
    }
    const auto after = load_project(path);
    const auto saved = bytes(path);
    check(after.topology.revision == 2 &&
              sql(path, "SELECT state FROM identity_registry WHERE kind='subsystem' AND entity_id='empty-retire'").toString() == "retired" &&
              sql(path, "SELECT state FROM identity_registry WHERE kind='subsystem' AND entity_id='atomic-new'").toString() == "active",
          "post-COMMIT unknown did not retain exactly one durable graph/registry revision");
    reject([&] { commit_logical_hierarchy(path, scope(), copied_review); }, HierarchyCode::Conflict,
           "unknown review copy automatically replayed");
    unchanged(path, saved, after, "unknown retry changed committed graph");
    // A separate fresh review is deliberate new work and proves lock cleanup.
    committed(commit_logical_hierarchy(path, scope(), preview_logical_hierarchy(path, scope(), rename(after))), 3);
}

void wal_capture_and_revision_limit(const QTemporaryDir &temp) {
    const auto path = temp.filePath("wal.sqlite");
    auto d = create(path);
    {
        Sql keeper(path);
        require(keeper.run("PRAGMA journal_mode=WAL") && keeper.run("PRAGMA wal_autocheckpoint=0"),
                "WAL fixture setup failed.");
        const auto base = bytes(path);
        require(keeper.run("BEGIN IMMEDIATE") &&
                    keeper.run("UPDATE project SET label='Committed WAL label',revision=revision+1") &&
                    keeper.run("COMMIT"), "Committed WAL fixture failed.");
        require(QFileInfo(path + "-wal").size() > 0 && bytes(path) == base, "Fixture did not retain rows only in WAL.");
        d = load_project(path);
        check(d.project.label == "Committed WAL label" && d.topology.revision == 2,
              "typed fixture reader missed committed WAL state");
        const auto review = preview_logical_hierarchy(path, scope(), rename(d));
        check(review.reviewed_revision() == 2, "hierarchy preview ignored current committed WAL revision");
        committed(commit_logical_hierarchy(path, scope(), review), 3);
        const auto after = load_project(path);
        check(after.project.label == "Committed WAL label" && after.topology.revision == 3,
              "hierarchy commit dropped committed WAL-owned fields");
    }
    const auto limit_path = temp.filePath("revision-limit.sqlite");
    create(limit_path);
    mutate(limit_path, "UPDATE project SET revision=9007199254740989");
    auto at_limit = load_project(limit_path);
    committed(commit_logical_hierarchy(limit_path, scope(),
        preview_logical_hierarchy(limit_path, scope(), rename(at_limit))), 9007199254740990LL);
    at_limit = load_project(limit_path);
    const auto before = bytes(limit_path);
    reject([&] { preview_logical_hierarchy(limit_path, scope(), rename(at_limit, "Overflow")); },
           HierarchyCode::BudgetExceeded, "last valid revision allowed overflowing hierarchy preview");
    unchanged(limit_path, before, at_limit, "revision exhaustion changed source");
}

void registry_budget(const QTemporaryDir &temp) {
    const auto path = temp.filePath("registry-budget.sqlite");
    const auto d = create(path);
    const auto count = sql(path, "SELECT count(*) FROM identity_registry").toInt();
    require(count > 0 && count < 50000, "Registry budget fixture invalid.");
    mutate(path, QString("WITH RECURSIVE n(v) AS (VALUES(1) UNION ALL SELECT v+1 FROM n WHERE v<%1) "
                         "INSERT INTO identity_registry SELECT 'subsystem','historic-'||v,'retired' FROM n")
                     .arg(50000 - count));
    equal_document(load_project(path), d, "Registry budget fixture changed active graph.");
    const auto before = bytes(path);
    reject([&] { preview_logical_hierarchy(path, scope(), proposal(d, {
        AddSubsystem{{"one-too-many", "New record", "", Privacy::Internal}}})); },
        HierarchyCode::BudgetExceeded, "full private registry evicted history or accepted another identity");
    unchanged(path, before, d, "registry exhaustion changed graph or history");
    check(sql(path, "SELECT count(*) FROM identity_registry").toInt() == 50000,
          "registry exhaustion evicted private tombstones");
}
std::filesystem::path native_path(const QString &path) {
#ifdef Q_OS_WIN
    return std::filesystem::path(path.toStdWString());
#else
    return std::filesystem::path(QFile::encodeName(path).constData());
#endif
}
void hardlink_refusal(const QTemporaryDir &temp) {
    const auto path = temp.filePath("hardlink-source.sqlite");
    const auto alias = temp.filePath("hardlink-alias.sqlite");
    const auto d = create(path);
    const auto review = preview_logical_hierarchy(path, scope(), rename(d));
    const auto before = bytes(path);
    std::error_code error;
    std::filesystem::create_hard_link(native_path(path), native_path(alias), error);
    if (error) {
        if (error == std::errc::operation_not_permitted || error == std::errc::permission_denied ||
            error == std::errc::not_supported) {
            ++skips;
            std::cout << "hardlink fixture unavailable under host filesystem/permission policy\n";
        } else check(false, "unexpected disposable hardlink fixture failure");
        return;
    }
    reject([&] { preview_logical_hierarchy(path, scope(), rename(d)); }, HierarchyCode::OwnerUnavailable,
           "hierarchy preview accepted main-file hardlink alias");
    reject([&] { commit_logical_hierarchy(path, scope(), review); }, HierarchyCode::OwnerUnavailable,
           "reviewed commit followed main-file hardlink alias");
    check(bytes(path) == before && bytes(alias) == before, "hardlink refusal changed source or alias");
    require(QFile::remove(alias), "Disposable alias cleanup failed.");
    committed(commit_logical_hierarchy(path, scope(), review), 2);
}
}

int main(int argc, char **argv) {
    QCoreApplication app(argc, argv);
    QTemporaryDir temp;
    if (!temp.isValid()) { std::cerr << "Disposable hierarchy fixture unavailable.\n"; return 1; }
    const std::pair<const char *, void (*)(const QTemporaryDir &)> cases[] = {
        {"mixed_batch", mixed_batch}, {"expected_values_and_rival", expected_values_and_rival},
        {"same_path_replacement_and_graph_drift", same_path_replacement_and_graph_drift},
        {"registry_drift_and_corruption", registry_drift_and_corruption},
        {"missing_schema_and_paths", missing_schema_and_paths},
        {"retirement_reopen_and_clone", retirement_reopen_and_clone},
        {"policy_and_noops", policy_and_noops}, {"v3_after_membership_change", v3_after_membership_change},
        {"repository_privacy_agrees_with_v3", repository_privacy_agrees_with_v3},
        {"transaction_faults_and_locks", transaction_faults_and_locks},
        {"wal_capture_and_revision_limit", wal_capture_and_revision_limit}, {"registry_budget", registry_budget},
        {"hardlink_refusal", hardlink_refusal}};
    int passed_cases = 0;
    for (const auto &[name, call] : cases) {
        const auto before = failures, skipped_before = skips;
        try { call(temp); }
        catch (const std::exception &) { ++failures; std::cerr << name << ": bounded fixture/owner exception.\n"; }
        if (failures == before && skips == skipped_before) ++passed_cases;
        std::cout << name << ": " << (failures != before ? "FAIL" : skips != skipped_before ? "SKIP" : "PASS") << '\n';
    }
    std::cout << passed_cases << '/' << std::size(cases) << " hierarchy owner cases passed; "
              << checks << " behavioral checks; " << failures << " failures; " << skips << " skipped\n";
    return failures ? 1 : 0;
}
