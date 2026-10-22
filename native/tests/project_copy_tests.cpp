#include "lmti/project_copy.hpp"
#include "lmti/project_store.hpp"
#include "../storage/project_copy_p.hpp"
#include "../common/local_owner_path.hpp"
#include <QCoreApplication>
#include <QDir>
#include <QFile>
#include <QFileInfo>
#include <QJsonDocument>
#include <QJsonObject>
#include <QSqlDatabase>
#include <QSqlQuery>
#include <QTemporaryDir>
#include <QThread>
#include <QUuid>
#include <algorithm>
#include <atomic>
#include <functional>
#include <iostream>
#include <set>

namespace {
int failures = 0;
void check(bool ok, const char *message) {
    if (!ok) { std::cerr << message << '\n'; ++failures; }
}
void rejects(const std::function<void()> &call, const char *message,
             std::optional<lmti::ProjectCopyCode> code = {}) {
    try { call(); check(false,message); }
    catch (const lmti::ProjectCopyError &error) {
        if (code && error.code != *code) {
            std::cerr << "Copy error mismatch for assertion: " << message
                      << "; expected=" << static_cast<int>(*code)
                      << "; actual=" << static_cast<int>(error.code) << '\n';
            ++failures;
        }
        check(QByteArray(error.what()) == "Project copy was refused.","copy error exposed source details");
    } catch (const lmti::Error &) { check(!code,"copy error bypassed its public error contract"); }
}
QByteArray bytes(const QString &path) {
    QFile file(path);
    check(file.open(QIODevice::ReadOnly),"cannot read disposable fixture");
    return file.readAll();
}
void overwrite(const QString &path, const QByteArray &value) {
    QFile file(path);
    check(file.open(QIODevice::WriteOnly | QIODevice::Truncate) && file.write(value) == value.size(),
          "cannot alter disposable fixture");
}
// Every SQL statement and every overwritten/removed file in this test belongs
// to its new QTemporaryDir. Production copies never accept SQL or registry input.
QVariant sql(const QString &path, const QString &statement) {
    const auto connection = QUuid::createUuid().toString();
    QVariant result;
    {
        auto db = QSqlDatabase::addDatabase("QSQLITE",connection);
        db.setDatabaseName(path);
        check(db.open(),"fixture database open failed");
        QSqlQuery query(db);
        check(query.exec(statement),"fixture SQL failed");
        if (query.next()) result = query.value(0);
        query.finish(); db.close();
    }
    QSqlDatabase::removeDatabase(connection);
    return result;
}
QString parent(const QTemporaryDir &temp, const QString &name) {
    check(QDir(temp.path()).mkdir(name),"fixture parent reservation failed");
    return temp.filePath(name);
}
QString child(const QString &parent_path, const lmti::ProjectCopyStatus &status, const QString &name) {
    return QDir(QDir(parent_path).filePath(status.operation_id)).filePath(name);
}
void prepared(const lmti::ProjectCopyStatus &status) {
    check(status.state == lmti::ProjectCopyState::Prepared && status.code == lmti::ProjectCopyCode::None &&
          status.verified_receipt,"copy did not complete independent verification");
}
lmti::ProjectDocument structured_fixture() {
    auto d = lmti::demo_project();
    d.structure.emplace();
    d.structure->sites = {{"factory-demo","Factory",lmti::Privacy::Public},
                         {"retire-site","Old site",lmti::Privacy::Internal}};
    d.structure->subsystems = {{"control","Control","",lmti::Privacy::Internal},
                              {"retire-subsystem","Old subsystem","",lmti::Privacy::Public}};
    d.structure->component_memberships = {{"sensor-firmware","control"}};
    d.structure->areas = {{"cell","Cell","factory-demo","",lmti::Privacy::Public},
                         {"retire-area","Old area","factory-demo","",lmti::Privacy::Public}};
    d.structure->environments = {{"test","Test",lmti::Privacy::Public},
                                {"retire-environment","Old environment",lmti::Privacy::Public}};
    d.structure->asset_placements = {{"machine-a","cell","gateway-b","test",lmti::PhysicalRole::Device},
                                    {"gateway-b","cell","","test",std::nullopt}};
    d.components.push_back({"retire-component","Old component","",lmti::ComponentKind::Library,lmti::Privacy::Public});
    d.topology.assets.push_back({"retire-asset","Old asset","factory-demo",lmti::Kind::Sensor,lmti::Privacy::Public});
    return d;
}
void retire_all(lmti::ProjectDocument &d) {
    const auto remove = [](auto &rows) { std::erase_if(rows,[](const auto &row) { return row.id.starts_with("retire-"); }); };
    remove(d.components); remove(d.topology.assets); remove(d.structure->sites);
    remove(d.structure->subsystems); remove(d.structure->areas); remove(d.structure->environments);
}
void migration_roundtrip(const QTemporaryDir &temp) {
    const auto source = temp.filePath("flat.sqlite"), destination = parent(temp,"migrations");
    auto document = lmti::demo_project();
    document.repositories.front().locator = "private-source-locator";
    document.verification.push_back({"verify","sensor-v020","machine-a","Recorded evidence","operator",17,
                                    lmti::EvidenceResult::Passed,lmti::Privacy::Internal});
    document.knowledge.push_back({"design","Design","sensor-firmware","private-reference","private-fingerprint",
                                 lmti::Privacy::Internal});
    document.topology.revision = lmti::save_project(source,document);
    document.topology.revision = lmti::save_project(source,document);
    const auto before = bytes(source);
    const auto preview = lmti::inspect_project_copy(source,lmti::ProjectCopyMode::MigrateV1);
    check(bytes(source) == before && QDir(destination).entryList(QDir::NoDotAndDotDot | QDir::AllEntries).isEmpty(),
          "preview wrote source or target state");
    check(preview.seeds_internal_sites && preview.source.schema == 1 && preview.source.store_uuid.isEmpty() &&
          preview.source.revision == 2 && preview.target_revision == 3,"migration preview lost policy or revision");
    const auto status = lmti::prepare_project_copy(source,destination,preview);
    prepared(status);
    check(status.source == preview.source && status.target.project_id == preview.source.project_id &&
          status.target.schema == 2 && status.target.revision == 3 && !status.target.store_uuid.isEmpty() &&
          status.target.content_digest == preview.target_content_digest &&
          status.target.registry_digest == preview.target_registry_digest,"migration tokens changed unexpectedly");
    const auto target = child(destination,status,"project.sqlite");
    auto actual = lmti::load_project(target), expected = lmti::load_project(source);
    expected.topology.revision = 3; expected.structure.emplace();
    std::set<std::string> sites;
    for (const auto &asset : expected.topology.assets) sites.insert(asset.site);
    for (const auto &site : sites) expected.structure->sites.push_back({site,site,lmti::Privacy::Internal});
    check(actual.storage_lineage.has_value(),"migration did not initialize native lineage");
    actual.storage_lineage.reset();
    check(actual == expected,"migration dropped or changed owned metadata, desired state, evidence or identities");
    check(sql(target,"SELECT count(*) FROM identity_registry WHERE state='retired'").toInt() == 0,
          "migration invented prior tombstones");
    const auto receipt = bytes(child(destination,status,"intent.json"));
    check(!receipt.contains("private-source-locator") && !receipt.contains("private-reference") &&
          !receipt.contains("private-fingerprint") && receipt.contains("internal_known_sites"),
          "private evidence receipt copied raw content or lost Site policy");
    const auto reread = lmti::inspect_project_copy_operation(destination,status.operation_id);
    prepared(reread);
    check(reread.target == status.target && reread.source == status.source && bytes(source) == before,
          "copy inspection changed the source or captured tokens");
    rejects([&] { lmti::inspect_project_copy(source,lmti::ProjectCopyMode::CloneV2); },
            "v1 accepted clone mode",lmti::ProjectCopyCode::UnsupportedSchema);
    rejects([&] { lmti::inspect_project_copy(target,lmti::ProjectCopyMode::MigrateV1); },
            "v2 accepted migration mode",lmti::ProjectCopyCode::UnsupportedSchema);
}
void clone_history(const QTemporaryDir &temp) {
    const auto source = temp.filePath("history.sqlite"), destination = parent(temp,"clones");
    auto document = structured_fixture(), retired = document;
    document.topology.revision = lmti::save_project(source,document);
    retire_all(document);
    document.topology.revision = lmti::save_project(source,document);
    const auto before = bytes(source);
    const auto preview = lmti::inspect_project_copy(source,lmti::ProjectCopyMode::CloneV2);
    check(!preview.seeds_internal_sites && preview.source.registry_digest == preview.target_registry_digest,
          "clone policy or full registry digest differs");
    const auto status = lmti::prepare_project_copy(source,destination,preview);
    prepared(status);
    const auto target = child(destination,status,"project.sqlite");
    auto copied = lmti::load_project(target), expected = lmti::load_project(source);
    check(copied.storage_lineage->store_uuid != expected.storage_lineage->store_uuid &&
          copied.project.id == expected.project.id,"clone reused store UUID or invented a new project identity");
    copied.storage_lineage.reset(); expected.storage_lineage.reset(); ++expected.topology.revision;
    check(copied == expected && sql(target,"SELECT count(*) FROM identity_registry WHERE state='retired'").toInt() == 6,
          "clone changed hierarchy or discarded retirement history");
    copied = lmti::load_project(target);
    const auto stable_target = bytes(target);
    const auto attempt = [&](const auto &mutate) {
        auto candidate = copied; mutate(candidate);
        rejects([&] { lmti::save_project(target,candidate); },"cloned retired ID was reusable");
        check(bytes(target) == stable_target,"failed reuse mutated clone");
    };
    attempt([&](auto &d) { d.components.push_back(retired.components.back()); });
    attempt([&](auto &d) { d.topology.assets.push_back(retired.topology.assets.back()); });
    attempt([&](auto &d) { d.structure->sites.push_back(retired.structure->sites.back()); });
    attempt([&](auto &d) { d.structure->subsystems.push_back(retired.structure->subsystems.back()); });
    attempt([&](auto &d) { d.structure->areas.push_back(retired.structure->areas.back()); });
    attempt([&](auto &d) { d.structure->environments.push_back(retired.structure->environments.back()); });
    copied.components.push_back({"replacement-component","Old component","",lmti::ComponentKind::Library,lmti::Privacy::Public});
    copied.topology.revision = lmti::save_project(target,copied);
    check(copied.topology.revision == 4 && bytes(source) == before &&
          sql(target,"SELECT count(*) FROM identity_registry WHERE state='retired'").toInt() == 6,
          "new identity failed or erased preserved source/history");
    check(lmti::inspect_project_copy_operation(destination,status.operation_id).code == lmti::ProjectCopyCode::TargetChanged,
          "edited prepared target was incorrectly certified as its original copy");
}
void stale_and_schema(const QTemporaryDir &temp) {
    const auto source = temp.filePath("stale.sqlite"), destination = parent(temp,"stale-copies");
    auto document = lmti::demo_project();
    document.topology.revision = lmti::save_project(source,document);
    const auto preview = lmti::inspect_project_copy(source,lmti::ProjectCopyMode::MigrateV1);
    // Same project/revision replacement is detected by owned content, not solely revision.
    sql(source,"UPDATE repositories SET locator='different-private-location' WHERE id='repo-sensor'");
    auto source_bytes = bytes(source);
    rejects([&] { lmti::prepare_project_copy(source,destination,preview); },"same-revision source change accepted",
            lmti::ProjectCopyCode::SourceChanged);
    check(bytes(source) == source_bytes && QDir(destination).entryList(QDir::NoDotAndDotDot | QDir::AllEntries).isEmpty(),
          "stale preview created artifacts or changed source");
    auto tampered = lmti::inspect_project_copy(source,lmti::ProjectCopyMode::MigrateV1);
    tampered.target_content_digest = QString(64,'0');
    rejects([&] { lmti::prepare_project_copy(source,destination,tampered); },"unreviewed target digest accepted",
            lmti::ProjectCopyCode::SourceChanged);
    const auto typed = lmti::detail::transform_project_copy(lmti::detail::capture_project_copy(source),
                                                           lmti::ProjectCopyMode::MigrateV1);
    rejects([&] { lmti::detail::initialize_project_copy(source,typed,QUuid::createUuid().toString(QUuid::WithoutBraces)); },
            "private initializer overwrote existing file",lmti::ProjectCopyCode::OwnerUnavailable);
    check(bytes(source) == source_bytes,"exclusive initializer changed an existing source");
    const QStringList mutations{
        "PRAGMA user_version=9", "ALTER TABLE assets ADD COLUMN unknown TEXT",
        "CREATE TABLE unknown(value TEXT)", "ALTER TABLE assets RENAME COLUMN label TO unknown",
        "CREATE VIEW unknown AS SELECT * FROM assets", "CREATE TABLE sites(id TEXT)"};
    int index = 0;
    for (const auto &statement : mutations) {
        const auto path = temp.filePath(QString("unsupported-%1.sqlite").arg(++index));
        check(QFile::copy(source,path),"cannot create disposable unknown-schema source");
        sql(path,statement); const auto before = bytes(path);
        rejects([&] { lmti::inspect_project_copy(path,lmti::ProjectCopyMode::MigrateV1); },
                "unsupported schema/column data was silently dropped");
        check(bytes(path) == before,"unsupported source was modified");
    }
    const auto corrupt = temp.filePath("corrupt-registry.sqlite");
    auto structured = structured_fixture(); structured.topology.revision = lmti::save_project(corrupt,structured);
    sql(corrupt,"DELETE FROM identity_registry WHERE entity_id='machine-a'");
    source_bytes = bytes(corrupt);
    rejects([&] { lmti::inspect_project_copy(corrupt,lmti::ProjectCopyMode::CloneV2); },"corrupt registry was copied");
    check(bytes(corrupt) == source_bytes,"copy repaired corrupt history");
    sql(source,"UPDATE project SET revision=9007199254740989");
    auto last_valid = lmti::load_project(source);
    const auto boundary_parent = parent(temp,"revision-boundary-copies");
    const auto boundary_copy = lmti::prepare_project_copy(source,boundary_parent,
        lmti::inspect_project_copy(source,lmti::ProjectCopyMode::MigrateV1));
    prepared(boundary_copy);
    const auto boundary_path = child(boundary_parent,boundary_copy,"project.sqlite");
    auto last_copy = lmti::load_project(boundary_path);
    check(last_copy.topology.revision == 9007199254740990LL &&
          lmti::load_project_metadata(boundary_path).revision == 9007199254740990LL,
          "copy could not produce and reopen last valid revision");
    const auto boundary_bytes = bytes(boundary_path);
    rejects([&] { lmti::inspect_project_copy(boundary_path,lmti::ProjectCopyMode::CloneV2); },
            "last valid clone source was incremented",lmti::ProjectCopyCode::BudgetExceeded);
    rejects([&] { lmti::save_project(boundary_path,last_copy); },"structured save exceeded domain revision bound");
    check(bytes(boundary_path) == boundary_bytes && last_copy.topology.revision == 9007199254740990LL,
          "structured revision exhaustion changed stored or caller state");
    const auto clone_source = temp.filePath("revision-clone-source.sqlite");
    auto clone_document = structured_fixture(); clone_document.topology.revision = lmti::save_project(clone_source,clone_document);
    sql(clone_source,"UPDATE project SET revision=9007199254740989");
    const auto clone_bytes = bytes(clone_source);
    const auto boundary_clone = lmti::prepare_project_copy(clone_source,boundary_parent,
        lmti::inspect_project_copy(clone_source,lmti::ProjectCopyMode::CloneV2));
    prepared(boundary_clone);
    check(lmti::load_project(child(boundary_parent,boundary_clone,"project.sqlite")).topology.revision == 9007199254740990LL &&
          bytes(clone_source) == clone_bytes,"clone could not preserve source and reopen last valid revision");
    last_valid.topology.revision = lmti::save_project(source,last_valid);
    check(last_valid.topology.revision == 9007199254740990LL &&
          lmti::load_project(source).topology.revision == 9007199254740990LL,
          "ordinary save could not produce and reopen last valid revision");
    source_bytes = bytes(source);
    rejects([&] { lmti::inspect_project_copy(source,lmti::ProjectCopyMode::MigrateV1); },"last valid revision was incremented by copy",
            lmti::ProjectCopyCode::BudgetExceeded);
    rejects([&] { lmti::prepare_project_copy(source,destination,preview); },"exhausted revision reserved a copy",
            lmti::ProjectCopyCode::BudgetExceeded);
    rejects([&] { lmti::save_project(source,last_valid); },"ordinary save persisted an invalid next revision");
    check(bytes(source) == source_bytes && last_valid.topology.revision == 9007199254740990LL &&
          QDir(destination).entryList(QDir::NoDotAndDotDot | QDir::AllEntries).isEmpty(),
          "revision exhaustion changed source or reserved a target");
    sql(source,"UPDATE project SET revision=9007199254740991");
    source_bytes = bytes(source);
    rejects([&] { lmti::inspect_project_copy(source,lmti::ProjectCopyMode::MigrateV1); },"already-invalid source revision was accepted",
            lmti::ProjectCopyCode::OwnerUnavailable);
    rejects([&] { lmti::load_project_metadata(source); },"metadata accepted revision outside domain bound");
    check(bytes(source) == source_bytes,"invalid source was repaired by copy inspection");
}
void migration_budget(const QTemporaryDir &temp) {
    lmti::ProjectDocument document;
    document.project = {"budget","Budget fixture","",lmti::Privacy::Public};
    const auto path = temp.filePath("sites.sqlite"), destination = parent(temp,"site-copies");
    for (int i = 0; i < 2000; ++i)
        document.topology.assets.push_back({"asset-"+std::to_string(i),"Asset","site-"+std::to_string(i),
                                           lmti::Kind::Sensor,lmti::Privacy::Public});
    document.topology.revision = lmti::save_project(path,document);
    const auto preview = lmti::inspect_project_copy(path,lmti::ProjectCopyMode::MigrateV1);
    const auto status = lmti::prepare_project_copy(path,destination,preview); prepared(status);
    check(lmti::load_project(child(destination,status,"project.sqlite")).structure->sites.size() == 2000,
          "maximum supported known Site catalog was not preserved");
    document.topology.assets.push_back({"asset-2000","Asset","site-2000",lmti::Kind::Sensor,lmti::Privacy::Public});
    document.topology.revision = lmti::save_project(path,document);
    const auto before = bytes(path);
    const auto entries = QDir(destination).entryList(QDir::NoDotAndDotDot | QDir::AllEntries);
    rejects([&] { lmti::inspect_project_copy(path,lmti::ProjectCopyMode::MigrateV1); },"unsupported Site count accepted",
            lmti::ProjectCopyCode::BudgetExceeded);
    rejects([&] { lmti::prepare_project_copy(path,destination,preview); },"over-budget prepare created target",
            lmti::ProjectCopyCode::BudgetExceeded);
    check(bytes(path) == before && QDir(destination).entryList(QDir::NoDotAndDotDot | QDir::AllEntries) == entries,
          "over-budget migration modified source or reserved an operation");
    lmti::ProjectDocument empty;
    empty.project = {"empty","Empty","",lmti::Privacy::Internal};
    const auto empty_path = temp.filePath("empty.sqlite"); empty.topology.revision = lmti::save_project(empty_path,empty);
    const auto empty_status = lmti::prepare_project_copy(empty_path,destination,
        lmti::inspect_project_copy(empty_path,lmti::ProjectCopyMode::MigrateV1)); prepared(empty_status);
    check(lmti::load_project(child(destination,empty_status,"project.sqlite")).structure->sites.empty(),
          "empty migration inferred a Site");
}
void store_replacement(const QTemporaryDir &temp) {
    const auto source = temp.filePath("identity-source.sqlite"), other = temp.filePath("identity-other.sqlite");
    const auto destination = parent(temp,"identity-copies");
    auto a = structured_fixture(), b = structured_fixture();
    a.topology.revision = lmti::save_project(source,a); retire_all(a);
    a.topology.revision = lmti::save_project(source,a);
    b.topology.revision = lmti::save_project(other,b); retire_all(b);
    b.topology.revision = lmti::save_project(other,b);
    const auto preview = lmti::inspect_project_copy(source,lmti::ProjectCopyMode::CloneV2);
    const auto saved_source = bytes(source), replacement = bytes(other);
    const auto preserved = temp.filePath("identity-source-preserved.sqlite");
    check(QFile::rename(source,preserved) && QFile::rename(other,source),"cannot replace disposable source store");
    const auto changed = lmti::inspect_project_copy(source,lmti::ProjectCopyMode::CloneV2);
    check(changed.source.project_id == preview.source.project_id && changed.source.revision == preview.source.revision &&
          changed.source.canonical_path == preview.source.canonical_path &&
          changed.source.content_digest == preview.source.content_digest &&
          changed.source.registry_digest == preview.source.registry_digest &&
          changed.source.store_uuid != preview.source.store_uuid,"replacement fixture did not isolate store UUID");
    rejects([&] { lmti::prepare_project_copy(source,destination,preview); },"same-content replacement store was accepted",
            lmti::ProjectCopyCode::SourceChanged);
    check(bytes(source) == replacement && bytes(preserved) == saved_source &&
          QDir(destination).entryList(QDir::NoDotAndDotDot | QDir::AllEntries).isEmpty(),
          "replacement refusal changed a store or reserved a copy");
}
void committed_failure(const QTemporaryDir &temp) {
    const auto source = temp.filePath("committed-failure.sqlite"), destination = parent(temp,"failed-copies");
    auto document = lmti::demo_project(); document.topology.revision = lmti::save_project(source,document);
    const auto preview = lmti::inspect_project_copy(source,lmti::ProjectCopyMode::MigrateV1), original = preview;
    const auto source_bytes = bytes(source);
    int count = 0;
    for (const auto fault : {lmti::detail::CopyTestFault::BeforeIndependentVerification,
                             lmti::detail::CopyTestFault::BeforeVerifiedReceipt}) {
        lmti::detail::set_copy_test_fault(fault);
        const auto status = lmti::prepare_project_copy(source,destination,preview);
        check(status.state == lmti::ProjectCopyState::RecoveryRequired && !status.operation_id.isEmpty() &&
              status.code == lmti::ProjectCopyCode::OwnerUnavailable && !status.verified_receipt,
              "post-COMMIT failure lost its recovery-required outcome/operation identity");
        const auto target_path = child(destination,status,"project.sqlite");
        const auto receipt_path = child(destination,status,"verified.json");
        const auto committed = lmti::load_project(target_path);
        check(committed.structure.has_value() && committed.topology.revision == preview.target_revision &&
              committed.project.id == document.project.id && !QFileInfo::exists(receipt_path),
              "failure did not occur after one committed copy before final receipt");
        const auto target_bytes = bytes(target_path);
        ++count;
        check(QDir(destination).entryList(QDir::NoDotAndDotDot | QDir::Dirs).size() == count,
              "failed preparation automatically retried into another operation");
        const auto reconciled = lmti::inspect_project_copy_operation(destination,status.operation_id);
        check(reconciled.state == lmti::ProjectCopyState::Prepared && !reconciled.verified_receipt &&
              reconciled.target == status.target && reconciled.source == original.source &&
              bytes(target_path) == target_bytes && bytes(source) == source_bytes && !QFileInfo::exists(receipt_path) &&
              QDir(destination).entryList(QDir::NoDotAndDotDot | QDir::Dirs).size() == count,
              "read-only reconciliation retried, deleted or modified committed artifacts");
    }
}
void reconciliation(const QTemporaryDir &temp) {
    const auto source = temp.filePath("recovery.sqlite"), destination = parent(temp,"recoveries");
    auto document = lmti::demo_project(); document.topology.revision = lmti::save_project(source,document);
    const auto status = lmti::prepare_project_copy(source,destination,
        lmti::inspect_project_copy(source,lmti::ProjectCopyMode::MigrateV1)); prepared(status);
    const auto intent_path = child(destination,status,"intent.json"), verified_path = child(destination,status,"verified.json");
    const auto target_path = child(destination,status,"project.sqlite");
    const auto intent = bytes(intent_path), verified = bytes(verified_path), target = bytes(target_path), original = bytes(source);
    check(QFile::remove(verified_path),"cannot model interruption after target commit");
    auto inspected = lmti::inspect_project_copy_operation(destination,status.operation_id);
    check(inspected.state == lmti::ProjectCopyState::Prepared && !inspected.verified_receipt &&
          inspected.target == status.target && !QFileInfo::exists(verified_path),
          "read-only recovery replayed write or invented a final receipt");
    // The source is never reread from receipt data: no source grant exists here.
    const auto preserved_source = temp.filePath("recovery-source-preserved.sqlite");
    check(QFile::rename(source,preserved_source),"cannot preserve source fixture");
    inspected = lmti::inspect_project_copy_operation(destination,status.operation_id);
    check(inspected.state == lmti::ProjectCopyState::Prepared && !QFileInfo::exists(source),
          "inspection followed receipt-supplied source path");
    check(QFile::rename(preserved_source,source),"cannot restore source fixture name");
    const auto assert_recovery = [&] {
        check(lmti::inspect_project_copy_operation(destination,status.operation_id).state == lmti::ProjectCopyState::RecoveryRequired,
              "invalid/interrupted artifacts were certified prepared");
        check(bytes(source) == original && bytes(target_path) == target,"reconciliation changed source or target");
    };
    overwrite(verified_path,"{}"); assert_recovery();
    overwrite(verified_path,verified);
    auto object = QJsonDocument::fromJson(intent).object(); object["unexpected"] = true;
    overwrite(intent_path,QJsonDocument(object).toJson(QJsonDocument::Compact)); assert_recovery();
    overwrite(intent_path,"{\"schema\":\"one\",\"schema\":\"two\"}"); assert_recovery();
    overwrite(intent_path,QByteArray(8193,'x')); assert_recovery();
    object = QJsonDocument::fromJson(intent).object();
    auto token = object["target"].toObject(); token["canonicalPath"] = source; object["target"] = token;
    overwrite(intent_path,QJsonDocument(object).toJson(QJsonDocument::Compact)); assert_recovery();
    overwrite(intent_path,intent); overwrite(verified_path,verified);
    const auto retained = child(destination,status,"retained.sqlite");
    check(QFile::rename(target_path,retained),"cannot model missing target");
    check(lmti::inspect_project_copy_operation(destination,status.operation_id).state == lmti::ProjectCopyState::RecoveryRequired &&
          !QFileInfo::exists(target_path),"missing target was retried or reported prepared");
    overwrite(target_path,"partial");
    check(lmti::inspect_project_copy_operation(destination,status.operation_id).state == lmti::ProjectCopyState::RecoveryRequired &&
          bytes(target_path) == "partial" && bytes(retained) == target,"partial target was overwritten during inspection");
    rejects([&] { lmti::inspect_project_copy_operation(destination,"../escape"); },"operation path traversal accepted",
            lmti::ProjectCopyCode::InvalidInput);
    check(QDir(temp.path()).mkdir(".lmti"),"cannot create protected-path fixture");
    const auto preview = lmti::inspect_project_copy(source,lmti::ProjectCopyMode::MigrateV1);
    rejects([&] { lmti::prepare_project_copy(source,temp.filePath(".lmti"),preview); },"copy wrote into reserved owner directory",
            lmti::ProjectCopyCode::InvalidInput);
    check(QDir(temp.filePath(".lmti")).entryList(QDir::NoDotAndDotDot | QDir::AllEntries).isEmpty(),
          "reserved owner directory changed");
}
void committed_wal(const QTemporaryDir &temp) {
    const auto source = temp.filePath("wal.sqlite"), destination = parent(temp,"wal-copies");
    auto document = lmti::demo_project(); document.topology.revision = lmti::save_project(source,document);
    const auto connection = QUuid::createUuid().toString();
    {
        auto db = QSqlDatabase::addDatabase("QSQLITE",connection); db.setDatabaseName(source);
        check(db.open(),"WAL fixture open failed"); QSqlQuery query(db);
        check(query.exec("PRAGMA journal_mode=WAL") && query.next() && query.value(0).toString() == "wal",
              "WAL fixture mode failed"); query.finish();
        check(query.exec("PRAGMA wal_autocheckpoint=0"),"WAL fixture checkpoint policy failed");
        check(query.exec("BEGIN IMMEDIATE") && query.exec("UPDATE project SET label='Committed in WAL',revision=2") &&
              query.exec("UPDATE assets SET poll=2200 WHERE id='machine-a'") && query.exec("COMMIT"),
              "WAL fixture transaction failed"); query.finish();
        check(QFileInfo(source+"-wal").size() > 0,"fixture did not retain committed WAL");
        const auto main_before = bytes(source), wal_before = bytes(source+"-wal");
        const auto status = lmti::prepare_project_copy(source,destination,
            lmti::inspect_project_copy(source,lmti::ProjectCopyMode::MigrateV1)); prepared(status);
        const auto copied = lmti::load_project(child(destination,status,"project.sqlite"));
        const auto asset = std::find_if(copied.topology.assets.begin(),copied.topology.assets.end(),
                                      [](const auto &row) { return row.id == "machine-a"; });
        check(copied.project.label == "Committed in WAL" && copied.topology.revision == 3 &&
              asset != copied.topology.assets.end() && asset->poll_ms == 2200,"copy lost committed WAL state");
        check(bytes(source) == main_before && bytes(source+"-wal") == wal_before,
              "read-only capture checkpointed or changed source database/WAL");
        db.close();
    }
    QSqlDatabase::removeDatabase(connection);
}
void path_boundary(const QTemporaryDir &temp) {
    const auto source = temp.filePath("path-source.sqlite"), destination = parent(temp,"path-copies");
    auto document = lmti::demo_project(); document.topology.revision = lmti::save_project(source,document);
    const auto original = bytes(source);
    const auto preview = lmti::inspect_project_copy(source,lmti::ProjectCopyMode::MigrateV1);
    const QStringList invalid{
        QString("\\\\?\\") + QDir::toNativeSeparators(source),
        QString("\\\\.\\") + QDir::toNativeSeparators(source),
        "\\\\synthetic.invalid\\share\\fixture", "//synthetic.invalid/share/fixture",
        "\\/synthetic.invalid/share/fixture", source + QChar(0), source + QChar(31),
        temp.filePath("NUL.txt"), temp.filePath("sub/../path-source.sqlite"), source+":stream"};
    // Directly exercise the pure helper: these inputs cannot cause any network
    // or filesystem probe even on hosts where their roots happen to exist.
    for (const auto &path : invalid)
        rejects([&] { lmti::detail::local_owner_path_lexical(path); },"unsafe path passed the pre-I/O boundary");
    rejects([&] { lmti::inspect_project_copy(QString("\\\\?\\") + QDir::toNativeSeparators(source),
                                           lmti::ProjectCopyMode::MigrateV1); },
            "valid source device-prefix spelling bypassed copy boundary",lmti::ProjectCopyCode::OwnerUnavailable);
    rejects([&] { lmti::prepare_project_copy(source,QString("\\\\?\\") + QDir::toNativeSeparators(destination),preview); },
            "valid parent device-prefix spelling bypassed copy boundary",lmti::ProjectCopyCode::InvalidInput);
    check(bytes(source) == original && QDir(destination).entryList(QDir::NoDotAndDotDot | QDir::AllEntries).isEmpty(),
          "path refusal touched source or reserved target");
    check(lmti::detail::local_owner_path_lexical(source) == source,"ordinary local path compatibility changed");
    QFile oversized(source+"-shm");
    check(oversized.open(QIODevice::WriteOnly | QIODevice::NewOnly) && oversized.resize(1024*1024+1),
          "cannot create disposable over-budget sidecar"); oversized.close();
    rejects([&] { lmti::inspect_project_copy(source,lmti::ProjectCopyMode::MigrateV1); },
            "physical sidecar budget did not refuse before SQLite open",lmti::ProjectCopyCode::BudgetExceeded);
    check(bytes(source) == original && QFileInfo(source+"-shm").size() == 1024*1024+1,
          "sidecar refusal modified source or sidecar");
}
void concurrent_snapshot(const QTemporaryDir &temp) {
    const auto source = temp.filePath("concurrent.sqlite");
    auto document = lmti::demo_project(); document.project.goal = "pair-0";
    for (auto &asset : document.topology.assets) if (asset.id == "machine-a") asset.label = "pair-0";
    document.topology.revision = lmti::save_project(source,document);
    sql(source,"PRAGMA journal_mode=WAL");
    std::atomic<bool> started = false, writer_ok = true;
    std::atomic<int> commits = 0;
    auto *writer = QThread::create([&] {
        const auto connection = QUuid::createUuid().toString();
        {
            auto db = QSqlDatabase::addDatabase("QSQLITE",connection); db.setDatabaseName(source);
            db.setConnectOptions("QSQLITE_BUSY_TIMEOUT=2000");
            if (!db.open()) writer_ok = false;
            started = true;
            for (int i = 1; writer_ok && i <= 40; ++i) {
                QSqlQuery query(db);
                const auto marker = QString("pair-%1").arg(i);
                writer_ok = query.exec("BEGIN IMMEDIATE") &&
                    query.exec("UPDATE project SET revision=revision+1,goal='"+marker+"'") &&
                    query.exec("UPDATE assets SET label='"+marker+"' WHERE id='machine-a'") && query.exec("COMMIT");
                if (writer_ok) ++commits;
                QThread::msleep(1);
            }
            db.close();
        }
        QSqlDatabase::removeDatabase(connection);
    });
    writer->start();
    while (!started) QThread::msleep(1);
    // Exercise the private reader used by BOTH public preview and preparation.
    // Cross-table fields are updated together while each capture is in progress.
    for (int i = 0; i < 30; ++i) {
        const auto captured = lmti::detail::capture_project_copy(source);
        const auto &d = captured.document;
        const auto asset = std::find_if(d.topology.assets.begin(),d.topology.assets.end(),
                                      [](const auto &row) { return row.id == "machine-a"; });
        check(asset != d.topology.assets.end() && d.project.goal == asset->label &&
              d.project.goal == "pair-"+std::to_string(d.topology.revision-1),
              "capture mixed project/assets from different WAL snapshots");
    }
    check(writer->wait(10000),"concurrent fixture writer did not finish");
    check(writer_ok && commits == 40,"concurrent fixture did not commit all paired states");
    delete writer;
}
}
int main(int argc, char **argv) {
    QCoreApplication app(argc,argv);
    QTemporaryDir temp;
    if (!temp.isValid()) return 1;
    try {
        migration_roundtrip(temp); clone_history(temp); stale_and_schema(temp);
        migration_budget(temp); store_replacement(temp); committed_failure(temp); reconciliation(temp);
        committed_wal(temp); concurrent_snapshot(temp); path_boundary(temp);
    } catch (const std::exception &error) {
        std::cerr << "Unexpected copy test failure: " << error.what() << '\n'; return 1;
    }
    std::cout << "Copy owner: WAL snapshots, migration, six-kind retirement history, stale tokens, budgets and recovery checked\n";
    return failures ? 1 : 0;
}
