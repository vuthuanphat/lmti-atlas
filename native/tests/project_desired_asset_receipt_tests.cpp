#include "lmti/project_desired_asset_store.hpp"
#include "lmti/project_store.hpp"
#include <QCoreApplication>
#include <QCryptographicHash>
#include <QDir>
#include <QFile>
#include <QFileInfo>
#include <QJsonArray>
#include <QJsonDocument>
#include <QSqlDatabase>
#include <QSqlQuery>
#include <QStringList>
#include <QTemporaryDir>
#include <QUuid>
#include <algorithm>
#include <functional>
#include <iostream>
#include <memory>
#include <string>
#include <utility>
#include <vector>
#ifdef Q_OS_WIN
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#endif
#ifndef LMTI_DESIRED_ASSET_OWNER_TEST_HOOKS
#error Build only the isolated native desired receipt test target.
#endif

namespace {
using namespace lmti;
using Code = DesiredAssetCode;
using Point = DesiredAssetOwnerTestPoint;
int checks = 0, failures = 0;
void check(bool value, const char *message) {
    ++checks;
    if (!value) { ++failures; std::cerr << "FAIL: " << message << '\n'; }
}
void need(bool value, const char *message = "Controlled desired receipt fixture failed.") {
    if (!value) throw Error(message);
}
QString s(const std::string &value) { return QString::fromStdString(value); }
QString at(const QString &root, const QString &leaf) { return QDir(root).filePath(leaf); }
QString uuid() { return QUuid::createUuid().toString(QUuid::WithoutBraces); }
QByteArray bytes(const QString &path) {
    QFile file(path); need(file.open(QIODevice::ReadOnly)); return file.readAll();
}
QByteArray hash(const QString &path) {
    return QCryptographicHash::hash(bytes(path), QCryptographicHash::Sha256).toHex();
}
template<class T> T &find(std::vector<T> &rows, const std::string &id) {
    const auto found = std::find_if(rows.begin(), rows.end(), [&](const auto &row) { return row.id == id; });
    need(found != rows.end()); return *found;
}
class Sql {
    QString name_ = uuid();
public:
    QSqlDatabase db;
    explicit Sql(const QString &path) {
        need(QFileInfo(path).isFile());
        db = QSqlDatabase::addDatabase("QSQLITE", name_);
        db.setDatabaseName(path); db.setConnectOptions("QSQLITE_BUSY_TIMEOUT=1000");
        need(db.open());
    }
    ~Sql() { db.close(); db = {}; QSqlDatabase::removeDatabase(name_); }
    void exec(const QString &text, const QVariantList &values = {}) {
        QSqlQuery q(db); need(q.prepare(text));
        for (const auto &value : values) q.addBindValue(value);
        need(q.exec());
    }
    QVariant scalar(const QString &text) {
        QSqlQuery q(db); need(q.exec(text) && q.next()); return q.value(0);
    }
    std::vector<QVariantList> rows(const QString &text, int columns) {
        QSqlQuery q(db); need(q.exec(text)); std::vector<QVariantList> result;
        while (q.next()) {
            QVariantList row;
            for (int i = 0; i < columns; ++i) row.push_back(q.value(i));
            result.push_back(std::move(row));
        }
        return result;
    }
};
QVariant scalar(const QString &path, const QString &query) { Sql db(path); return db.scalar(query); }
std::vector<QVariantList> registry(const QString &path) {
    Sql db(path); return db.rows("SELECT kind,entity_id,state FROM identity_registry ORDER BY kind,entity_id", 3);
}
std::vector<QVariantList> ledger(const QString &path) {
    Sql db(path); return db.rows("SELECT * FROM desired_asset_receipts ORDER BY origin_store_uuid,operation_id", 24);
}
void refused(const std::function<void()> &call, Code expected) {
    try { call(); check(false, "Expected desired owner refusal was missing."); }
    catch (const DesiredAssetError &error) {
        check(error.code == expected, "Desired owner used an unexpected refusal code.");
        const QByteArray message(error.what());
        check(message.size() <= 128 && !message.contains(".sqlite") &&
              !message.contains("SELECT") && !message.contains("fixture-private"),
              "Desired owner refusal exposed private details.");
    } catch (...) { check(false, "Desired owner escaped its bounded error type."); }
}
void typed_refused(const std::function<void()> &call) {
    try { call(); check(false, "Expected typed refusal was missing."); }
    catch (const DesiredAssetError &) { ++checks; }
    catch (...) { check(false, "Unexpected exception instead of typed refusal."); }
}
void old_owner_refused(const std::function<void()> &call) {
    try { call(); check(false, "Legacy owner accepted an unsupported schema3 operation."); }
    catch (const Error &) { ++checks; }
    catch (...) { check(false, "Legacy owner escaped its documented error boundary."); }
}
std::function<void(Point)> callback;
void dispatch(Point point) { if (callback) callback(point); }
class Hook {
public:
    explicit Hook(std::function<void(Point)> fn) {
        need(!callback); callback = std::move(fn); set_desired_asset_owner_test_hook(dispatch);
    }
    ~Hook() { set_desired_asset_owner_test_hook(nullptr); callback = {}; }
};

// Independent Windows metadata capture; never calls the production lease code.
OriginalPhysicalTarget physical(const QString &path) {
    OriginalPhysicalTarget result; result.path = QDir::cleanPath(path);
    QStringList parts;
    auto cursor = result.path;
    while (true) {
        parts.prepend(cursor);
        const auto parent = QFileInfo(cursor).dir().absolutePath();
        if (parent == cursor) break;
        cursor = parent;
    }
#ifdef Q_OS_WIN
    for (qsizetype i = 0; i < parts.size(); ++i) {
        const bool directory = i + 1 < parts.size();
        const auto h = CreateFileW(reinterpret_cast<LPCWSTR>(parts[i].utf16()), FILE_READ_ATTRIBUTES,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING,
            FILE_FLAG_OPEN_REPARSE_POINT | (directory ? FILE_FLAG_BACKUP_SEMANTICS : 0), nullptr);
        need(h != INVALID_HANDLE_VALUE);
        BY_HANDLE_FILE_INFORMATION info{};
        const auto ok = GetFileInformationByHandle(h, &info), closed = CloseHandle(h);
        need(ok && closed && !(info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) &&
             bool(info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) == directory &&
             (directory || info.nNumberOfLinks == 1));
        const auto ticks = (quint64(info.ftCreationTime.dwHighDateTime) << 32) | info.ftCreationTime.dwLowDateTime;
        need(ticks > 116444736000000000ULL);
        result.chain.push_back({QString::number(info.dwVolumeSerialNumber),
            QString::number((quint64(info.nFileIndexHigh) << 32) | info.nFileIndexLow),
            QString::number(ticks - 116444736000000000ULL) + "00"});
    }
#else
    throw Error("Windows identity fixture is required.");
#endif
    return result;
}

ProjectDocument graph() {
    auto d = demo_project();
    d.project.privacy = Privacy::Public;
    for (auto &a : d.topology.assets) a.privacy = Privacy::Public;
    auto &target = find(d.topology.assets, "machine-a");
    target.enabled = false; target.poll_ms = 2345; target.observed = Observation::Online;
    target.observed_at = 23; target.x = 1.25; target.y = -2.5;
    d.repositories.front().locator = "fixture-private-repository";
    d.knowledge = {{"design", "Synthetic design", "sensor-firmware", "fixture-private-reference",
                    "fixture-private-fingerprint", Privacy::Public}};
    d.structure.emplace();
    auto &st = *d.structure;
    st.subsystems = {{"software", "Software", "", Privacy::Public}};
    st.component_memberships = {{"sensor-firmware", "software"}};
    st.sites = {{"factory-demo", "Factory", Privacy::Public}, {"unused-site", "Unused", Privacy::Internal}};
    st.areas = {{"floor", "Floor", "factory-demo", "", Privacy::Public},
                {"cell", "Cell", "factory-demo", "floor", Privacy::Public},
                {"empty-area", "Empty", "factory-demo", "", Privacy::Public}};
    st.environments = {{"live", "Live", Privacy::Public}, {"unused-env", "Unused", Privacy::Internal}};
    st.asset_placements = {{"machine-a", "cell", "gateway-b", "live", std::nullopt},
        {"gateway-b", "cell", "broker-c", "live", PhysicalRole::Gateway},
        {"broker-c", "cell", "", "live", PhysicalRole::Host}};
    validate(d);
    return d;
}
struct Fixture {
    QTemporaryDir temp{QDir(QDir::tempPath()).filePath("lmti-desired-receipt-XXXXXX")};
    QString path, backups;
    ProjectDocument initial;
    std::string store_uuid;
    DesiredAssetOriginalExpected original2;
    ProjectFormatMaintenanceScope maintenance;
    Fixture() {
        need(temp.isValid());
        path = temp.filePath("project.sqlite"); backups = temp.filePath("backups");
        need(QDir(temp.path()).mkdir("backups"));
        auto d = graph(); d.topology.revision = save_project(path, d);
        initial = load_project(path); need(initial.storage_lineage.has_value());
        store_uuid = initial.storage_lineage->store_uuid;
        original2 = {2, store_uuid, physical(path)};
        maintenance = {initial.project.id, store_uuid, "fixture-operator", std::string(64, 'a'), true};
    }
    DesiredAssetScope scope(bool internal = false) const {
        return {initial.project.id, store_uuid, "fixture-operator", std::string(64, 'b'),
                "factory-demo", "live", internal, true};
    }
    DesiredAssetOriginalExpected original() const { return {3, store_uuid, original2.physical}; }
    DesiredAssetProposal proposal() const {
        auto d = load_project(path);
        const auto &a = find(d.topology.assets, "machine-a");
        return {"machine-a", d.topology.revision, {a.enabled, a.poll_ms}, {!a.enabled, a.poll_ms + 100},
                std::string(64, 'c')};
    }
    ProjectReceiptUpgradeToken preview_upgrade() const {
        return preview_project_receipt_upgrade(path, backups, maintenance, original2);
    }
    ProjectReceiptUpgradeToken upgrade() {
        const auto token = preview_upgrade();
        const auto result = commit_project_receipt_upgrade(path, backups, maintenance, token);
        need(result.state == ProjectReceiptUpgradeState::Confirmed && result.format.has_value());
        return token;
    }
    QString backup(const ProjectReceiptUpgradeToken &token) const {
        return at(at(backups, s(token.operation_id)), "project-v2.sqlite");
    }
};
void same_graph(ProjectDocument actual, ProjectDocument expected, const char *message) {
    // Storage path/version are separately asserted; they are not graph content.
    actual.storage_lineage.reset(); expected.storage_lineage.reset();
    check(actual == expected, message);
}

void explicit_upgrade_preserves_graph_and_backup() {
    Fixture f;
    const auto empty = find(f.initial.structure->areas, "empty-area");
    const PhysicalHierarchyScope physical_scope{f.initial.project.id, true, true};
    const PhysicalHierarchyProposal retirement{f.initial.project.id, f.initial.topology.revision,
                                               {RetireEmptyArea{empty}}};
    const auto retired = commit_physical_hierarchy(f.path, physical_scope,
        preview_physical_hierarchy(f.path, physical_scope, retirement));
    need(retired.state == PhysicalHierarchyCommitState::Committed);
    f.initial = load_project(f.path);
    check(scalar(f.path, "SELECT count(*) FROM identity_registry WHERE state='retired'").toInt() == 1,
          "Backup fixture did not contain a real retired registry identity.");
    const auto before = bytes(f.path);
    const auto old_registry = registry(f.path);
    const auto token = f.preview_upgrade();
    check(bytes(f.path) == before && QDir(f.backups).entryList(QDir::Dirs | QDir::NoDotAndDotDot).isEmpty(),
          "Upgrade preview wrote source or backup.");
    auto denied = f.maintenance; denied.allow_upgrade = false;
    refused([&] { preview_project_receipt_upgrade(f.path, f.backups, denied, f.original2); }, Code::ScopeDenied);
    check(bytes(f.path) == before, "Maintenance denial changed original bytes.");
    const auto result = commit_project_receipt_upgrade(f.path, f.backups, f.maintenance, token);
    need(result.state == ProjectReceiptUpgradeState::Confirmed && result.format);
    const auto current = load_project(f.path);
    check(current.storage_lineage && current.storage_lineage->schema_version == 3 &&
          current.storage_lineage->store_uuid == f.store_uuid && current.topology.revision == f.initial.topology.revision,
          "Explicit upgrade changed immutable identity or graph revision.");
    same_graph(current, f.initial, "Upgrade changed graph data.");
    check(registry(f.path) == old_registry && ledger(f.path).empty(), "Upgrade changed registry or invented receipts.");
    const auto backup = load_project(f.backup(token));
    check(backup.storage_lineage && backup.storage_lineage->schema_version == 2 &&
          backup.storage_lineage->store_uuid == f.store_uuid, "Backup lost format2/original UUID.");
    same_graph(backup, f.initial, "Backup omitted typed graph data.");
    check(registry(f.backup(token)) == old_registry &&
          result.format->backup_sha256 == hash(f.backup(token)).toStdString(), "Backup registry or byte proof mismatch.");
    const auto inspection = inspect_project_receipt_upgrade(f.path, f.backups, f.maintenance, token);
    check(inspection.state == ProjectReceiptUpgradeCondition::Upgraded && inspection.backup_verified &&
          inspection.format && inspection.format->upgrade_operation_id == token.operation_id,
          "Exact upgrade inspection did not recover confirmed operation.");
}
void native_edit_is_atomic_and_replay_is_historical() {
    Fixture f; f.upgrade();
    const auto original = f.original();
    const auto scope = f.scope();
    const auto before = load_project(f.path);
    const auto old_registry = registry(f.path);
    const auto p = f.proposal();
    const auto old_bytes = bytes(f.path);
    auto review = preview_desired_asset(f.path, scope, original, p);
    const auto token = export_desired_asset_review(review);
    check(bytes(f.path) == old_bytes && ledger(f.path).empty(), "Preview wrote native state.");
    const auto result = commit_desired_asset(f.path, scope, original, review);
    need(result.state == DesiredAssetCommitState::Confirmed && result.receipt);
    const auto receipt = *result.receipt;
    auto expected = before;
    auto &asset = find(expected.topology.assets, p.asset_id);
    asset.enabled = p.desired.enabled; asset.poll_ms = p.desired.poll_ms;
    ++expected.topology.revision;
    check(load_project(f.path) == expected && registry(f.path) == old_registry && ledger(f.path).size() == 1,
          "Desired commit changed unrelated graph/registry or did not advance exactly once.");
    check(!result.replayed && receipt.operation_id == token.operation_id &&
          receipt.request_digest == token.request_digest && receipt.base_revision == p.expected_revision &&
          receipt.committed_revision == p.expected_revision + 1 && receipt.expected == p.expected &&
          receipt.desired == p.desired, "Receipt did not identify the exact reviewed change.");
    const auto committed_bytes = bytes(f.path);
    auto replay = restore_desired_asset_review(f.path, scope, original, token);
    check(!replay.reviewed_state(), "Historical replay pretended to be a fresh state preview.");
    const auto replayed = commit_desired_asset(f.path, scope, original, replay);
    check(replayed.state == DesiredAssetCommitState::Confirmed && replayed.replayed &&
          replayed.receipt && *replayed.receipt == receipt && bytes(f.path) == committed_bytes,
          "Exact receipt replay mutated or lost the original receipt.");
    auto later = load_project(f.path);
    later.project.label = "Later unrelated operator edit";
    later.topology.revision = save_project(f.path, later);
    const auto later_bytes = bytes(f.path);
    const auto stored = ledger(f.path);
    replay = restore_desired_asset_review(f.path, scope, original, token);
    const auto historical = commit_desired_asset(f.path, scope, original, replay);
    check(historical.receipt && *historical.receipt == receipt && historical.replayed &&
          bytes(f.path) == later_bytes && ledger(f.path) == stored,
          "Replay after ordinary save reapplied stale values or lost durable history.");
    const auto read = inspect_desired_asset_receipt(f.path, scope, original, token.operation_id, token.request_digest);
    check(read && *read == receipt, "Independent exact receipt inspection disagreed.");
    refused([&] { inspect_desired_asset_receipt(f.path, scope, original, token.operation_id, std::string(64, 'd')); },
            Code::OperationConflict);
}
void rollback_and_lost_ack_faults() {
    for (const auto point : {Point::AfterAssetUpdateBeforeReceipt, Point::BeforeCommit, Point::AfterCommit}) {
        Fixture f; f.upgrade();
        const auto original = f.original();
        const auto scope = f.scope();
        const auto before = load_project(f.path);
        const auto old_bytes = bytes(f.path);
        auto review = preview_desired_asset(f.path, scope, original, f.proposal());
        const auto token = export_desired_asset_review(review);
        bool reached = false;
        {
            Hook hook([&](Point observed) {
                if (observed == point) { reached = true; throw Error("Controlled native commit interruption."); }
            });
            if (point == Point::AfterCommit) {
                const auto result = commit_desired_asset(f.path, scope, original, review);
                check(result.state == DesiredAssetCommitState::Unknown && !result.receipt &&
                      result.operation_id == token.operation_id, "Lost commit ACK became false refusal/success.");
            } else typed_refused([&] { commit_desired_asset(f.path, scope, original, review); });
        }
        check(reached, "Expected isolated commit fault point was not reached.");
        const auto recovered = inspect_desired_asset_receipt(f.path, scope, original, token.operation_id, token.request_digest);
        if (point == Point::AfterCommit) {
            check(recovered && ledger(f.path).size() == 1 &&
                  load_project(f.path).topology.revision == before.topology.revision + 1,
                  "Post-COMMIT lost ACK lacked one durable native receipt.");
            const auto after = bytes(f.path);
            const auto replay = restore_desired_asset_review(f.path, scope, original, token);
            const auto result = commit_desired_asset(f.path, scope, original, replay);
            check(result.replayed && result.receipt && recovered && *result.receipt == *recovered &&
                  bytes(f.path) == after, "Recovery of lost ACK duplicated the write.");
        } else {
            check(!recovered && ledger(f.path).empty() && load_project(f.path) == before && bytes(f.path) == old_bytes,
                  "Rollback left a changed Asset/revision or receipt.");
            typed_refused([&] { commit_desired_asset(f.path, scope, original, review); });
            check(bytes(f.path) == old_bytes, "Consumed in-process review wrote after rollback.");
        }
    }
}
void upgrade_faults_keep_truthful_outcomes() {
    for (const auto point : {Point::UpgradeAfterBackupVerified, Point::UpgradeBeforeCommit, Point::UpgradeAfterCommit}) {
        Fixture f;
        const auto before = bytes(f.path);
        const auto old_registry = registry(f.path);
        const auto token = f.preview_upgrade();
        bool reached = false;
        {
            Hook hook([&](Point observed) {
                if (observed == point) { reached = true; throw Error("Controlled format interruption."); }
            });
            // The maintenance operation has already reserved a durable artifact;
            // even a known source rollback requires explicit reconciliation.
            const auto result = commit_project_receipt_upgrade(f.path, f.backups, f.maintenance, token);
            check(result.state == ProjectReceiptUpgradeState::Unknown && !result.format &&
                  result.operation_id == token.operation_id, "Post-reservation upgrade failure was guessed.");
        }
        check(reached && QFileInfo(f.backup(token)).isFile(), "Upgrade fault lost its verified backup.");
        same_graph(load_project(f.backup(token)), f.initial, "Interrupted upgrade left invalid backup graph.");
        check(registry(f.backup(token)) == old_registry, "Interrupted upgrade lost backup registry.");
        const auto inspection = inspect_project_receipt_upgrade(f.path, f.backups, f.maintenance, token);
        if (point == Point::UpgradeAfterCommit)
            check(inspection.state == ProjectReceiptUpgradeCondition::Upgraded && inspection.backup_verified &&
                  inspection.format && scalar(f.path, "PRAGMA user_version").toInt() == 3,
                  "Exact upgrade recovery failed after real COMMIT.");
        else
            check(inspection.state != ProjectReceiptUpgradeCondition::Upgraded && bytes(f.path) == before &&
                  scalar(f.path, "PRAGMA user_version").toInt() == 2,
                  "Orphan backup was misreported as committed upgrade.");
    }
}
void live_wal_backup_and_write_refusal() {
    Fixture f;
    Sql live(f.path);
    need(live.scalar("PRAGMA journal_mode=WAL").toString().compare("wal", Qt::CaseInsensitive) == 0);
    live.exec("PRAGMA wal_autocheckpoint=0");
    const auto main_before = bytes(f.path);
    live.exec("UPDATE project SET label=?,revision=revision+1 WHERE id=?",
              {"Committed only in controlled WAL", s(f.initial.project.id)});
    need(QFileInfo(f.path + "-wal").size() > 32);
    check(bytes(f.path) == main_before, "WAL fixture checkpointed before the backup test.");
    f.initial = load_project(f.path);
    const auto token = f.upgrade();
    check(load_project(f.backup(token)).project.label == "Committed only in controlled WAL",
          "Upgrade backup copied stale main bytes and lost committed WAL data.");
    same_graph(load_project(f.backup(token)), f.initial, "Live WAL backup changed graph/revision.");
    const auto original = f.original();
    const auto scope = f.scope();
    auto review = preview_desired_asset(f.path, scope, original, f.proposal());
    // Commit an unrelated edit while the original reviewed snapshot is retained.
    live.exec("UPDATE project SET label=?,revision=revision+1 WHERE id=?",
              {"Later controlled WAL edit", s(f.initial.project.id)});
    const auto source_main = bytes(f.path);
    const auto source_wal = bytes(f.path + "-wal");
    typed_refused([&] { commit_desired_asset(f.path, scope, original, review); });
    check(bytes(f.path) == source_main && bytes(f.path + "-wal") == source_wal && ledger(f.path).empty(),
          "Stale writer refusal changed or checkpointed the existing WAL.");
    auto fresh = preview_desired_asset(f.path, scope, original, f.proposal());
    const auto result = commit_desired_asset(f.path, scope, original, fresh);
    check(result.state == DesiredAssetCommitState::Confirmed && result.receipt &&
          ledger(f.path).size() == 1 && scalar(f.path, "PRAGMA journal_mode").toString() == "wal",
          "Legitimate live WAL write was refused or changed journal policy.");
}
void authorization_provenance_and_history() {
    for (const bool local : {false, true}) {
        Fixture f; f.upgrade();
        const auto scope = f.scope(local);
        const auto original = f.original();
        const auto review = preview_desired_asset(f.path, scope, original, f.proposal());
        const auto token = export_desired_asset_review(review);
        const auto result = commit_desired_asset(f.path, scope, original, review);
        need(result.receipt.has_value());
        const auto copy = f.temp.filePath("same-uuid-copy.sqlite");
        need(QFile::copy(f.path, copy));
        const DesiredAssetOriginalExpected copied{3, f.store_uuid, physical(copy)};
        // Newly supplied physical pins cannot transfer historical provenance.
        check(!inspect_desired_asset_receipt(copy, scope, copied, token.operation_id, std::string(64, 'd')),
              "Copied same-UUID file disclosed receipt existence or request conflict.");
        refused([&] { restore_desired_asset_review(copy, scope, copied, token); }, Code::ScopeDenied);
        auto other = scope; other.grant_fingerprint = std::string(64, 'd');
        check(!inspect_desired_asset_receipt(f.path, other, original, token.operation_id, std::string(64, 'd')),
              "Changed grant fingerprint disclosed historical receipt conflict.");
        auto later = load_project(f.path);
        // A different public ancestry is not proof of the original ancestry.
        find(later.structure->areas, "cell").parent_area_id.clear();
        later.topology.revision = save_project(f.path, later);
        const auto historical = inspect_desired_asset_receipt(f.path, scope, original,
                                                             token.operation_id, token.request_digest);
        check(historical.has_value() == local, "Historical ancestry reparenting bypassed external policy.");
        if (!local)
            refused([&] { restore_desired_asset_review(f.path, scope, original, token); }, Code::ScopeDenied);
        // Remove all live references through the ordinary whole-project owner.
        std::erase_if(later.topology.assets, [](const auto &a) { return a.id == "machine-a"; });
        std::erase_if(later.topology.links, [](const auto &r) { return r.from == "machine-a" || r.to == "machine-a"; });
        std::erase_if(later.bindings, [](const auto &r) { return r.asset_id == "machine-a"; });
        std::erase_if(later.verification, [](const auto &r) { return r.asset_id == "machine-a"; });
        for (auto &r : later.work) if (r.asset_id == "machine-a") r.asset_id.clear();
        std::erase_if(later.structure->asset_placements, [](const auto &r) { return r.asset_id == "machine-a"; });
        later.topology.revision = save_project(f.path, later);
        check(scalar(f.path, "SELECT state FROM identity_registry WHERE kind='asset' AND entity_id='machine-a'").toString() ==
              "retired", "Ordinary retirement lost durable target registry history.");
        const auto retired = inspect_desired_asset_receipt(f.path, scope, original, token.operation_id, token.request_digest);
        check(retired.has_value() == local && (!retired || *retired == *result.receipt),
              "Retired history was lost locally or disclosed externally.");
        auto stale = token.proposal; stale.expected_revision = 1;
        refused([&] { preview_desired_asset(f.path, scope, original, stale); }, Code::ScopeDenied);
        stale.asset_id = "missing";
        refused([&] { preview_desired_asset(f.path, scope, original, stale); }, Code::ScopeDenied);
        if (local) {
            const auto retired_bytes = bytes(f.path);
            const auto replay = restore_desired_asset_review(f.path, scope, original, token);
            const auto recovered = commit_desired_asset(f.path, scope, original, replay);
            check(recovered.replayed && recovered.receipt && *recovered.receipt == *result.receipt &&
                  bytes(f.path) == retired_bytes, "Local historical replay recreated a retired Asset.");
        }
    }
}
void hidden_scope_precedes_conflicts() {
    const std::vector<std::function<void(ProjectDocument &)>> hide{
        [](auto &d) { d.project.privacy = Privacy::Internal; },
        [](auto &d) { find(d.topology.assets, "machine-a").privacy = Privacy::Internal; },
        [](auto &d) { find(d.topology.assets, "broker-c").privacy = Privacy::Internal; },
        [](auto &d) { find(d.structure->sites, "factory-demo").privacy = Privacy::Internal; },
        [](auto &d) { find(d.structure->areas, "floor").privacy = Privacy::Internal; },
        [](auto &d) { find(d.structure->environments, "live").privacy = Privacy::Internal; },
    };
    for (const auto &change : hide) {
        Fixture f; f.upgrade();
        const auto original = f.original();
        const auto scope = f.scope();
        auto proposal = f.proposal();
        const auto review = preview_desired_asset(f.path, scope, original, proposal);
        const auto token = export_desired_asset_review(review);
        auto d = load_project(f.path); change(d);
        d.topology.revision = save_project(f.path, d);
        proposal.expected.enabled = !proposal.expected.enabled;
        proposal.desired.poll_ms += 1;
        const auto before = bytes(f.path);
        refused([&] { preview_desired_asset(f.path, scope, original, proposal); }, Code::ScopeDenied);
        refused([&] { commit_desired_asset(f.path, scope, original, review); }, Code::ScopeDenied);
        refused([&] { restore_desired_asset_review(f.path, scope, original, token); }, Code::ScopeDenied);
        check(bytes(f.path) == before && ledger(f.path).empty(), "Hidden scope refusal mutated the native store.");
    }
    Fixture f; f.upgrade();
    const auto original = f.original();
    auto wrong = f.scope(); wrong.site_id = "unused-site";
    refused([&] { preview_desired_asset(f.path, wrong, original, f.proposal()); }, Code::ScopeDenied);
    wrong = f.scope(); wrong.environment_id = "unused-env";
    refused([&] { preview_desired_asset(f.path, wrong, original, f.proposal()); }, Code::ScopeDenied);
    wrong = f.scope(); wrong.allow_desired_write = false;
    check(inspect_desired_asset(f.path, wrong, original, "machine-a").asset_id == "machine-a",
          "Read authority incorrectly required the desired-write capability.");
    refused([&] { preview_desired_asset(f.path, wrong, original, f.proposal()); }, Code::ScopeDenied);
}
void stale_values_snapshots_and_original_replacement() {
    Fixture f; f.upgrade();
    const auto original = f.original();
    const auto scope = f.scope();
    auto wrong = f.proposal(); wrong.expected.poll_ms += 5;
    refused([&] { preview_desired_asset(f.path, scope, original, wrong); }, Code::ConfigConflict);
    wrong = f.proposal(); ++wrong.expected_revision;
    refused([&] { preview_desired_asset(f.path, scope, original, wrong); }, Code::RevisionConflict);
    auto review = preview_desired_asset(f.path, scope, original, f.proposal());
    auto saved = load_project(f.path);
    saved.project.label = "Unrelated graph content";
    saved.topology.revision = save_project(f.path, saved);
    const auto after_save = bytes(f.path);
    typed_refused([&] { commit_desired_asset(f.path, scope, original, review); });
    check(bytes(f.path) == after_save && ledger(f.path).empty(), "Whole-snapshot conflict wrote an old proposal.");
    review = preview_desired_asset(f.path, scope, original, f.proposal());
    const auto replaced = f.temp.filePath("original-kept.sqlite");
    need(QFile::rename(f.path, replaced) && QFile::copy(replaced, f.path));
    const auto replacement_bytes = bytes(f.path);
    typed_refused([&] { commit_desired_asset(f.path, scope, original, review); });
    check(bytes(f.path) == replacement_bytes && ledger(f.path).empty(),
          "Same-path replacement acquired original write authority.");
    const DesiredAssetOriginalExpected replacement{3, f.store_uuid, physical(f.path)};
    auto fresh = preview_desired_asset(f.path, scope, replacement, f.proposal());
    bool observed = false;
    {
        Hook hook([&](Point point) {
            if (point == Point::BeforeCommit) {
                observed = true;
                check(!QFile::rename(f.path, f.temp.filePath("must-not-move.sqlite")),
                      "Held Windows main-file namespace allowed replacement before COMMIT.");
            }
        });
        const auto result = commit_desired_asset(f.path, scope, replacement, fresh);
        check(result.state == DesiredAssetCommitState::Confirmed, "Pinned ordinary DELETE-journal write failed.");
    }
    check(observed && !QFileInfo::exists(f.path + "-journal"), "Writer journal lifecycle or fault point failed.");
}
void schema_corruption_and_legacy_boundaries() {
    const std::vector<QString> corruption{
        "CREATE INDEX unexpected ON assets(label)",
        "CREATE VIEW unexpected AS SELECT id FROM assets",
        "CREATE TRIGGER unexpected AFTER UPDATE ON assets BEGIN SELECT 1; END",
        "ALTER TABLE desired_asset_receipts ADD COLUMN unexpected TEXT",
        "UPDATE proposal_format SET format_digest='invalid'",
        "DELETE FROM proposal_format",
        "PRAGMA user_version=2",
    };
    for (const auto &sql : corruption) {
        Fixture f; f.upgrade();
        { Sql db(f.path); db.exec(sql); }
        const auto before = bytes(f.path);
        typed_refused([&] { inspect_desired_asset(f.path, f.scope(), f.original(), "machine-a"); });
        check(bytes(f.path) == before, "Schema refusal repaired or modified an untrusted container.");
    }
    {
        Fixture corrupt; corrupt.upgrade();
        const auto review = preview_desired_asset(corrupt.path, corrupt.scope(), corrupt.original(), corrupt.proposal());
        need(commit_desired_asset(corrupt.path, corrupt.scope(), corrupt.original(), review).receipt.has_value());
        { Sql db(corrupt.path); db.exec("UPDATE desired_asset_receipts SET desired_poll_ms=desired_poll_ms+1"); }
        const auto before = bytes(corrupt.path);
        typed_refused([&] { inspect_desired_asset(corrupt.path, corrupt.scope(), corrupt.original(), "machine-a"); });
        check(bytes(corrupt.path) == before, "Corrupt receipt digest was accepted or silently repaired.");
    }
    Fixture f;
    const PhysicalHierarchyScope physical_scope{f.initial.project.id, true, true};
    const PhysicalHierarchyProposal change{f.initial.project.id, f.initial.topology.revision,
        {RenameArea{find(f.initial.structure->areas, "empty-area"), "Renamed empty area"}}};
    const auto old_review = preview_physical_hierarchy(f.path, physical_scope, change);
    f.upgrade();
    const auto before = bytes(f.path);
    old_owner_refused([&] { commit_physical_hierarchy(f.path, physical_scope, old_review); });
    old_owner_refused([&] { inspect_project_copy(f.path, ProjectCopyMode::CloneV2); });
    const auto document = load_project(f.path);
    const auto destination = f.temp.filePath("forbidden-fresh-copy.sqlite");
    old_owner_refused([&] { save_project(destination, document); });
    check(!QFileInfo::exists(destination), "Ordinary save created a downgraded receipt-less copy.");
    auto downgrade = document; downgrade.storage_lineage->schema_version = 2;
    old_owner_refused([&] { save_project(f.path, downgrade); });
    auto changed_uuid = document; changed_uuid.storage_lineage->store_uuid = uuid().toStdString();
    old_owner_refused([&] { save_project(f.path, changed_uuid); });
    check(bytes(f.path) == before, "Legacy/copy/lineage refusal changed schema3 bytes.");
}

// Direct SQL below constructs only disposable capacity fixtures. These rows are
// synthetic history; the test does not claim thousands of real owner commits.
QByteArray row_digest(const QVariantList &row) {
    QJsonArray tuple;
    for (int i = 0; i < 23; ++i) {
        if (i == 9 || i == 14 || i == 16) tuple.append(row[i].toInt() == 1);
        else if (i == 12 || i == 13 || i == 15 || i == 17) tuple.append(row[i].toLongLong());
        else tuple.append(row[i].toString());
    }
    return QCryptographicHash::hash(QByteArrayLiteral("lmti.project.desired-asset-receipt.v1\n") +
        QJsonDocument(tuple).toJson(QJsonDocument::Compact), QCryptographicHash::Sha256).toHex();
}
void capacity_and_ledger_snapshot() {
    Fixture f; f.upgrade();
    const auto original = f.original();
    const auto scope = f.scope();
    const auto review = preview_desired_asset(f.path, scope, original, f.proposal());
    const auto token = export_desired_asset_review(review);
    const auto committed = commit_desired_asset(f.path, scope, original, review);
    need(committed.receipt.has_value());
    const auto retained = ledger(f.path).front();
    need(row_digest(retained) == retained[23].toByteArray(), "Independent receipt digest framing disagreed.");
    {
        Sql db(f.path);
        db.exec("BEGIN IMMEDIATE");
        for (int i = 1; i < 4096; ++i) {
            auto row = retained;
            row[1] = uuid();
            row[12] = retained[12].toLongLong() + i;
            row[13] = retained[13].toLongLong() + i;
            row[23] = QString::fromLatin1(row_digest(row));
            db.exec("INSERT INTO desired_asset_receipts VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", row);
        }
        db.exec("UPDATE project SET revision=? WHERE id=?",
                {retained[13].toLongLong() + 4095, s(f.initial.project.id)});
        db.exec("COMMIT");
    }
    const auto full = bytes(f.path);
    const auto fresh_proposal = f.proposal();
    refused([&] {
        const auto fresh = preview_desired_asset(f.path, scope, original, fresh_proposal);
        commit_desired_asset(f.path, scope, original, fresh);
    }, Code::BudgetExceeded);
    check(bytes(f.path) == full && ledger(f.path).size() == 4096,
          "Full ledger accepted a new operation or changed native state.");
    const auto replay = restore_desired_asset_review(f.path, scope, original, token);
    const auto historical = commit_desired_asset(f.path, scope, original, replay);
    check(historical.replayed && historical.receipt && *historical.receipt == *committed.receipt &&
          bytes(f.path) == full, "Capacity limit prevented exact existing historical replay.");
    // A ledger-only mutation at an unchanged graph revision invalidates a new
    // review even though graph and registry digests remain identical.
    Fixture g; g.upgrade();
    const auto first = preview_desired_asset(g.path, g.scope(), g.original(), g.proposal());
    need(commit_desired_asset(g.path, g.scope(), g.original(), first).receipt.has_value());
    auto later = load_project(g.path); later.project.label = "Gap before ledger-only fixture";
    later.topology.revision = save_project(g.path, later);
    const auto pending = preview_desired_asset(g.path, g.scope(), g.original(), g.proposal());
    auto added = ledger(g.path).front();
    added[1] = uuid(); added[12] = later.topology.revision - 1; added[13] = later.topology.revision;
    added[23] = QString::fromLatin1(row_digest(added));
    { Sql db(g.path); db.exec("INSERT INTO desired_asset_receipts VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", added); }
    const auto changed = bytes(g.path);
    typed_refused([&] { commit_desired_asset(g.path, g.scope(), g.original(), pending); });
    check(bytes(g.path) == changed && ledger(g.path).size() == 2,
          "Ledger-only whole-snapshot drift was ignored.");
    Fixture exhausted; exhausted.upgrade();
    { Sql db(exhausted.path); db.exec("UPDATE project SET revision=9007199254740990"); }
    const auto at_limit = bytes(exhausted.path);
    check(inspect_desired_asset(exhausted.path, exhausted.scope(), exhausted.original(), "machine-a").revision ==
          9007199254740990LL, "Maximum saved native revision became unreadable.");
    refused([&] { preview_desired_asset(exhausted.path, exhausted.scope(), exhausted.original(), exhausted.proposal()); },
            Code::BudgetExceeded);
    check(bytes(exhausted.path) == at_limit, "Exhausted revision preview changed the native store.");
}
} // namespace

int main(int argc, char **argv) {
    QCoreApplication app(argc, argv);
    const std::vector<std::pair<const char *, std::function<void()>>> cases{
        {"explicit format upgrade and complete independent backup", explicit_upgrade_preserves_graph_and_backup},
        {"atomic narrow edit and historical replay after ordinary save", native_edit_is_atomic_and_replay_is_historical},
        {"rollback and actual post-COMMIT lost ACK", rollback_and_lost_ack_faults},
        {"upgrade failures and orphan backup truthfulness", upgrade_faults_keep_truthful_outcomes},
        {"live WAL backup and unchanged refusal", live_wal_backup_and_write_refusal},
        {"original provenance and external/local historical authorization", authorization_provenance_and_history},
        {"inherited privacy and fixed scope before stale conflicts", hidden_scope_precedes_conflicts},
        {"stale snapshots and pinned original namespace", stale_values_snapshots_and_original_replacement},
        {"exact schema validation and legacy compatibility refusal", schema_corruption_and_legacy_boundaries},
        {"synthetic ledger capacity and ledger-only snapshot drift", capacity_and_ledger_snapshot},
    };
    int passed = 0;
    for (const auto &[name, run] : cases) {
        const auto before = failures;
        try { run(); }
        catch (const std::exception &) { check(false, "Unexpected desired receipt test setup/owner exception."); }
        if (failures == before) { ++passed; std::cout << "PASS " << name << '\n'; }
        else std::cout << "FAIL " << name << '\n';
    }
    std::cout << "Desired Asset receipts: " << passed << '/' << cases.size() << " cases passed; "
              << checks << " behavioral checks; " << failures << " failures; 0 skipped.\n";
    return failures == 0 ? 0 : 1;
}
