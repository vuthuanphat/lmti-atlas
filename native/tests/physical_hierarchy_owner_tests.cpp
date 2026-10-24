#include "lmti/project_store.hpp"
#include <QCoreApplication>
#include <QDir>
#include <QFile>
#include <QFileInfo>
#include <QJsonArray>
#include <QSqlDatabase>
#include <QSqlQuery>
#include <QTemporaryDir>
#include <QUuid>
#include <algorithm>
#include <filesystem>
#include <functional>
#include <iostream>
#include <iterator>
#include <optional>
#include <stdexcept>

#ifndef LMTI_PHYSICAL_HIERARCHY_OWNER_TEST_HOOKS
#error This suite requires the isolated physical hierarchy owner target.
#endif

namespace {
using namespace lmti;
using Code = PhysicalHierarchyCode;
int checks = 0, failures = 0, skips = 0;
void check(bool ok, const char *message) {
    ++checks;
    if (!ok) { ++failures; std::cerr << message << '\n'; }
}
void require(bool ok, const char *message) { if (!ok) throw std::runtime_error(message); }
QByteArray bytes(const QString &path) {
    QFile file(path); require(file.open(QIODevice::ReadOnly), "Fixture read failed.");
    return file.readAll();
}
// Fixed SQL in disposable QTemporaryDir fixtures only. No production request
// accepts SQL, registry content, mutable graph objects or filesystem targets.
class Sql {
    QString name_ = QUuid::createUuid().toString();
public:
    QSqlDatabase db;
    explicit Sql(const QString &path) {
        require(QFileInfo(path).isFile(), "Fixture SQL requires an existing file.");
        db = QSqlDatabase::addDatabase("QSQLITE", name_);
        db.setDatabaseName(path); db.setConnectOptions("QSQLITE_BUSY_TIMEOUT=0");
        require(db.open(), "Fixture SQL open failed.");
    }
    ~Sql() { db.close(); db = {}; QSqlDatabase::removeDatabase(name_); }
    bool run(const QString &text) { QSqlQuery q(db); return q.exec(text); }
    QVariant scalar(const QString &text) {
        QSqlQuery q(db); require(q.exec(text) && q.next(), "Fixture SQL query failed.");
        return q.value(0);
    }
};
void mutate(const QString &path, const QString &text) {
    Sql db(path); require(db.run(text), "Fixture SQL mutation failed.");
}
QVariant scalar(const QString &path, const QString &text) { Sql db(path); return db.scalar(text); }
QByteArray refused(const std::function<void()> &call, Code expected, const char *message) {
    try { call(); check(false, message); }
    catch (const PhysicalHierarchyError &error) {
        check(error.code() == expected, message);
        const QByteArray text(error.what());
        check(text.size() <= 128 && !text.contains(".sqlite") && !text.contains("SELECT") &&
              !text.contains("identity_registry") && !text.contains("fixture-private"),
              "physical refusal leaked owner details");
        return text;
    }
    catch (const std::exception &) { check(false, "physical boundary leaked a different error type"); }
    return {};
}
void ordinary_refused(const std::function<void()> &call, const char *message) {
    try { call(); check(false, message); } catch (const lmti::Error &) { ++checks; }
}
PhysicalHierarchyScope scope(bool internal = true) { return {"factory-monitor", true, internal}; }
template<typename T> const T &find(const std::vector<T> &rows, const std::string &id) {
    auto it = std::find_if(rows.begin(), rows.end(), [&](const auto &r) { return r.id == id; });
    require(it != rows.end(), "Fixture row missing."); return *it;
}
PhysicalAssetAnchor anchor(const ProjectDocument &d, const std::string &id) {
    const auto &a = find(d.topology.assets,id);
    return {a.id,a.label,a.site,a.kind,a.privacy};
}
std::optional<AssetPlacement> placement(const ProjectDocument &d, const std::string &id) {
    for (const auto &p : d.structure->asset_placements) if (p.asset_id == id) return p;
    return std::nullopt;
}
PhysicalHierarchyProposal proposal(const ProjectDocument &d, std::vector<PhysicalHierarchyChange> changes) {
    return {d.project.id,d.topology.revision,std::move(changes)};
}
PhysicalHierarchyProposal rename(const ProjectDocument &d, const std::string &label = "Reviewed factory") {
    return proposal(d,{RenameSite{find(d.structure->sites,"factory-demo"),label}});
}
Asset asset(const std::string &id, const std::string &site = "factory-demo",
            Privacy privacy = Privacy::Public) {
    Asset a; a.id=id; a.label="Synthetic asset "+id; a.site=site; a.privacy=privacy;
    return a;
}
ProjectDocument fixture() {
    auto d = demo_project();
    d.repositories.front().locator = "fixture-private-repository";
    d.knowledge = {{"design","Synthetic design","sensor-firmware","fixture-private-reference",
                    "fixture-private-fingerprint",Privacy::Public}};
    d.verification = {{"checked","sensor-v020","machine-a","Synthetic retained evidence","operator",
                       17,EvidenceResult::Passed,Privacy::Internal}};
    d.releases.front().state = ReleaseState::Approved;
    d.topology.assets.front().enabled = false;
    d.topology.assets.front().poll_ms = 2345;
    d.topology.assets.front().observed = Observation::Online;
    d.topology.assets.front().observed_at = 23;
    d.topology.assets.front().x = 1.25; d.topology.assets.front().y = -2.5;
    d.topology.assets.push_back(asset("loose"));
    d.structure.emplace(); auto &s = *d.structure;
    s.subsystems = {{"software","Software root","",Privacy::Public}};
    s.component_memberships = {{"sensor-firmware","software"}};
    s.sites = {{"factory-demo","Factory",Privacy::Public},{"empty-site","Empty site",Privacy::Public}};
    s.areas = {{"floor","Floor","factory-demo","",Privacy::Public},
               {"cell","Cell","factory-demo","floor",Privacy::Public},
               {"second-floor","Second floor","factory-demo","",Privacy::Public},
               {"empty-area","Empty area","factory-demo","",Privacy::Public}};
    s.environments = {{"live","Live",Privacy::Public},{"empty-env","Empty environment",Privacy::Public}};
    s.asset_placements = {{"machine-a","cell","gateway-b","live",PhysicalRole::Device},
                          {"gateway-b","cell","broker-c","live",PhysicalRole::Gateway},
                          {"broker-c","cell","","live",PhysicalRole::Host}};
    validate(d); return d;
}
ProjectDocument create(const QString &path) {
    auto d=fixture(); d.topology.revision=save_project(path,d); return load_project(path);
}
void normalize(ProjectDocument &d) {
    if (!d.structure) return;
    auto order=[](auto &rows) { std::sort(rows.begin(),rows.end(),[](const auto &a,const auto &b){return a.id<b.id;}); };
    auto &s=*d.structure; order(s.sites); order(s.areas); order(s.environments);
    std::sort(s.asset_placements.begin(),s.asset_placements.end(),[](const auto &a,const auto &b){return a.asset_id<b.asset_id;});
}
void equal_document(ProjectDocument actual, ProjectDocument expected, const char *message) {
    normalize(actual); normalize(expected); check(actual==expected,message);
}
void unchanged(const QString &path,const QByteArray &before,const ProjectDocument &doc,const char *message) {
    check(bytes(path)==before,message); equal_document(load_project(path),doc,message);
}
void committed(const PhysicalHierarchyCommitResult &r,std::int64_t revision) {
    check(r.state==PhysicalHierarchyCommitState::Committed && r.revision==revision,
          "known physical commit lost exact revision");
}
QJsonObject projected(const QJsonObject &v,const char *group,const std::string &id) {
    for (const auto &r:v[group].toArray()) if (r.toObject()["id"]==QString::fromStdString(id)) return r.toObject();
    return {};
}
template<typename T> void erase_id(std::vector<T> &rows,const std::string &id) {
    std::erase_if(rows,[&](const auto &r){return r.id==id;});
}

void eleven_operations(const QTemporaryDir &temp) {
    const auto path=temp.filePath("eleven.sqlite"); const auto d=create(path); const auto before=bytes(path);
    const auto p=proposal(d,{
        AddArea{{"new-area","New area","new-site","",Privacy::Internal}},
        AddSite{{"new-site","New site",Privacy::Internal}},
        RenameSite{find(d.structure->sites,"factory-demo"),"Reviewed factory"},
        RetireEmptySite{find(d.structure->sites,"empty-site")},
        RenameArea{find(d.structure->areas,"floor"),"Reviewed floor"},
        ReparentArea{find(d.structure->areas,"cell"),"second-floor"},
        RetireEmptyArea{find(d.structure->areas,"empty-area")},
        AddEnvironment{{"new-env","New environment",Privacy::Internal}},
        RenameEnvironment{find(d.structure->environments,"live"),"Reviewed environment"},
        RetireEmptyEnvironment{find(d.structure->environments,"empty-env")},
        SetAssetPlacement{anchor(d,"loose"),std::nullopt,AssetPlacement{"loose","","","",std::nullopt}}});
    const auto review=preview_physical_hierarchy(path,scope(),p);
    const auto token=export_physical_hierarchy_review(review);
    check(review.proposal().changes.size()==11 && review.reviewed_revision()==1 &&
          token.domain=="lmti.physical-hierarchy.review.v1","physical review lost domain or batch");
    check(review.diff().sites.size()==3 && review.diff().areas.size()==4 &&
          review.diff().environments.size()==3 && review.diff().placements.size()==1,
          "eleven-operation review omitted changed rows");
    auto reversed=p; std::reverse(reversed.changes.begin(),reversed.changes.end());
    auto second=preview_physical_hierarchy(path,scope(),reversed);
    const auto second_token=export_physical_hierarchy_review(second);
    check(review.proposal()==second.proposal() && review.diff()==second.diff() &&
          token.proposal_digest==second_token.proposal_digest && token.diff_digest==second_token.diff_digest,
          "physical digest depends on caller operation order");
    bool moved_descendant=false; bool kinds[4]={};
    for (const auto &a:review.diff().affected) {
        kinds[static_cast<int>(a.kind)]=true;
        if(a.kind==PhysicalHierarchyEntityKind::Asset && a.id=="machine-a")
            moved_descendant=a.before_path.area_ancestors==std::vector<std::string>{"floor","cell"} &&
                a.after_path.area_ancestors==std::vector<std::string>{"second-floor","cell"} &&
                a.after_path.asset_ancestors==std::vector<std::string>{"broker-c","gateway-b"} &&
                a.after_path.environment_id=="live";
    }
    check(moved_descendant && std::all_of(std::begin(kinds),std::end(kinds),[](bool b){return b;}),
          "complete diff omitted unchanged descendants or a physical kind");
    auto restored=restore_physical_hierarchy_review(path,scope(),token);
    check(restored.diff()==review.diff() && restored.proposal()==review.proposal(),"restore refreshed review");
    unchanged(path,before,d,"inspect/preview/export/restore changed owner bytes");
    const auto copied=restored;
    committed(commit_physical_hierarchy(path,scope(),restored),2);
    auto expected=d; auto &s=*expected.structure;
    s.sites.push_back({"new-site","New site",Privacy::Internal});
    for(auto &r:s.sites)if(r.id=="factory-demo")r.label="Reviewed factory";
    erase_id(s.sites,"empty-site");
    s.areas.push_back({"new-area","New area","new-site","",Privacy::Internal});
    for(auto &r:s.areas){if(r.id=="floor")r.label="Reviewed floor";if(r.id=="cell")r.parent_area_id="second-floor";}
    erase_id(s.areas,"empty-area");
    s.environments.push_back({"new-env","New environment",Privacy::Internal});
    for(auto &r:s.environments)if(r.id=="live")r.label="Reviewed environment";
    erase_id(s.environments,"empty-env");
    s.asset_placements.push_back({"loose","","","",std::nullopt});
    expected.topology.revision=2;
    equal_document(load_project(path),expected,"physical commit altered unrelated metadata/assets/software/layout/observations");
    refused([&]{commit_physical_hierarchy(path,scope(),copied);},Code::Conflict,"copied review replayed");
    refused([&]{export_physical_hierarchy_review(copied);},Code::Conflict,"consumed review exported");
    refused([&]{restore_physical_hierarchy_review(path,scope(),token);},Code::Conflict,"stale transport pins refreshed");
}

void placement_states_and_retirement(const QTemporaryDir &temp) {
    const auto path=temp.filePath("retire.sqlite"); auto d=create(path);
    committed(commit_physical_hierarchy(path,scope(),preview_physical_hierarchy(path,scope(),
        proposal(d,{SetAssetPlacement{anchor(d,"loose"),std::nullopt,AssetPlacement{"loose","","","",std::nullopt}}}))),2);
    d=load_project(path); check(placement(d,"loose").has_value(),"declared-empty placement became absent");
    const auto state=inspect_physical_hierarchy(path,scope());
    const auto loose=std::find_if(state.projection.assets.begin(),state.projection.assets.end(),
        [](const auto &r){return r.value.id=="loose";});
    check(loose!=state.projection.assets.end() && loose->placement && !loose->placement->role,
          "asset kind inferred a role");
    const auto p=proposal(d,{
        SetAssetPlacement{anchor(d,"loose"),placement(d,"loose"),std::nullopt},
        RetireEmptySite{find(d.structure->sites,"empty-site")},
        RetireEmptyArea{find(d.structure->areas,"empty-area")},
        RetireEmptyEnvironment{find(d.structure->environments,"empty-env")}});
    committed(commit_physical_hierarchy(path,scope(),preview_physical_hierarchy(path,scope(),p)),3);
    d=load_project(path); const auto before=bytes(path);
    check(!placement(d,"loose") && scalar(path,"SELECT state FROM identity_registry WHERE kind='asset' AND entity_id='loose'").toString()=="active",
          "placement removal retired the existing asset");
    for(const auto &[kind,id]:std::vector<std::pair<QString,QString>>{{"site","empty-site"},{"area","empty-area"},{"environment","empty-env"}})
        check(scalar(path,"SELECT state FROM identity_registry WHERE kind='"+kind+"' AND entity_id='"+id+"'").toString()=="retired",
              "catalog retirement did not persist private tombstone");
    for(const auto &change:std::vector<PhysicalHierarchyChange>{
        AddSite{{"empty-site","Different site label",Privacy::Internal}},
        AddArea{{"empty-area","Different area label","factory-demo","",Privacy::Internal}},
        AddEnvironment{{"empty-env","Different environment label",Privacy::Internal}}})
        refused([&]{preview_physical_hierarchy(path,scope(),proposal(d,{change}));},Code::Conflict,
                "reopened physical owner reused retired identity");
    auto resurrect=d; resurrect.structure->sites.push_back({"empty-site","Resurrect",Privacy::Internal});
    ordinary_refused([&]{save_project(path,resurrect);},"ordinary save resurrected retired site");
    unchanged(path,before,d,"retirement/reuse refusal changed active graph");
}

void shared_revision_and_old_values(const QTemporaryDir &temp) {
    const auto path=temp.filePath("shared.sqlite"); auto d=create(path); const auto before=bytes(path);
    auto wrong=find(d.structure->sites,"factory-demo"); wrong.label="Wrong old label";
    refused([&]{preview_physical_hierarchy(path,scope(),proposal(d,{RenameSite{wrong,"New label"}}));},
            Code::Conflict,"incorrect original row accepted");
    auto stale=rename(d); stale.expected_revision=2;
    refused([&]{preview_physical_hierarchy(path,scope(),stale);},Code::Conflict,"wrong revision accepted");
    unchanged(path,before,d,"pre-review conflict changed document");
    const auto physical=preview_physical_hierarchy(path,scope(),rename(d));
    LogicalHierarchyScope logical_scope{d.project.id,true,true};
    LogicalHierarchyProposal logical_p{d.project.id,d.topology.revision,{
        RenameSubsystem{find(d.structure->subsystems,"software"),"Logical edit"}}};
    const auto logical=preview_logical_hierarchy(path,logical_scope,logical_p);
    check(commit_logical_hierarchy(path,logical_scope,logical).revision==2,"logical fixture failed");
    refused([&]{commit_physical_hierarchy(path,scope(),physical);},Code::Conflict,"physical review ignored logical change");
    d=load_project(path); logical_p.expected_revision=2;
    logical_p.changes={RenameSubsystem{find(d.structure->subsystems,"software"),"Later logical edit"}};
    const auto old_logical=preview_logical_hierarchy(path,logical_scope,logical_p);
    committed(commit_physical_hierarchy(path,scope(),preview_physical_hierarchy(path,scope(),rename(d))),3);
    try {commit_logical_hierarchy(path,logical_scope,old_logical);check(false,"logical review ignored physical change");}
    catch(const HierarchyError &e){check(e.code()==HierarchyCode::Conflict,"wrong logical conflict code");}
}

void snapshot_drift_and_replacement(const QTemporaryDir &temp) {
    const auto path=temp.filePath("drift.sqlite"); auto d=create(path);
    auto review=preview_physical_hierarchy(path,scope(),rename(d));
    auto token=export_physical_hierarchy_review(review);
    mutate(path,"UPDATE project SET label='Independent same revision edit'");
    const auto changed=bytes(path);
    refused([&]{commit_physical_hierarchy(path,scope(),review);},Code::Conflict,"full graph digest omitted unrelated metadata");
    refused([&]{restore_physical_hierarchy_review(path,scope(),token);},Code::Conflict,"restore refreshed content pins");
    check(bytes(path)==changed,"graph drift refusal wrote data");
    d=load_project(path); review=preview_physical_hierarchy(path,scope(),rename(d));
    token=export_physical_hierarchy_review(review);
    mutate(path,"INSERT INTO identity_registry VALUES('area','historic-area','retired')");
    const auto with_history=bytes(path);
    refused([&]{commit_physical_hierarchy(path,scope(),review);},Code::Conflict,"private registry drift ignored");
    refused([&]{restore_physical_hierarchy_review(path,scope(),token);},Code::Conflict,"restore lost private history pin");
    check(bytes(path)==with_history,"registry drift refusal rewrote history");
    const auto original=temp.filePath("replace.sqlite"), replacement=temp.filePath("replacement.sqlite"),
               retained=temp.filePath("retained-original.sqlite");
    const auto first=create(original); const auto second=create(replacement);
    check(first.storage_lineage->store_uuid!=second.storage_lineage->store_uuid,"replacement fixture reused UUID");
    const auto r=preview_physical_hierarchy(original,scope(),rename(first));
    const auto t=export_physical_hierarchy_review(r);
    // Exact regular files under this owned root; retain the original, do not delete.
    require(QFileInfo(original).canonicalPath()==temp.path() && QFileInfo(replacement).canonicalPath()==temp.path() &&
        !QFileInfo(original).isSymLink() && !QFileInfo(replacement).isSymLink() &&
        !QFileInfo::exists(retained),"Replacement fixture containment failed.");
    require(QFile::rename(original,retained) && QFile::copy(replacement,original),"Replacement fixture failed.");
    const auto after=bytes(original);
    refused([&]{commit_physical_hierarchy(original,scope(),r);},Code::Conflict,"same-path replacement UUID accepted");
    refused([&]{restore_physical_hierarchy_review(original,scope(),t);},Code::Conflict,"restore refreshed replacement UUID");
    check(bytes(original)==after && bytes(retained)!=QByteArray{},"replacement refusal changed or lost retained source");
}

void malformed_tokens_and_scope(const QTemporaryDir &temp) {
    const auto path=temp.filePath("tokens.sqlite");const auto d=create(path);
    const auto token=export_physical_hierarchy_review(preview_physical_hierarchy(path,scope(),rename(d)));
    const auto missing=temp.filePath("never-created.sqlite");
    std::vector<PhysicalHierarchyReviewToken> bad;
    auto add=[&](const std::function<void(PhysicalHierarchyReviewToken &)> &change){auto t=token;change(t);bad.push_back(t);};
    add([](auto &t){t.version=2;});
    add([](auto &t){t.domain="lmti.logical-hierarchy.review.v1";});
    add([](auto &t){t.snapshot.schema=1;});
    add([](auto &t){t.snapshot.store_uuid="{00000000-0000-0000-0000-000000000000}";});
    add([](auto &t){t.snapshot.content_digest="not-a-digest";});
    add([](auto &t){t.diff_digest=QString(64,QLatin1Char('A'));});
    add([](auto &t){t.snapshot.canonical_path="relative.sqlite";});
    add([](auto &t){t.snapshot.revision=0;});
    add([](auto &t){t.proposal.expected_revision+=1;});
    add([](auto &t){t.proposal.changes={RenameSite{{"factory-demo","Wrong pin",Privacy::Public},"Other label"}};});
    for(const auto &t:bad)
        refused([&]{restore_physical_hierarchy_review(missing,scope(),t);},Code::InvalidArgument,
                "malformed token reached missing filesystem before pure validation");
    check(!QFileInfo::exists(missing),"malformed token created a source");
    auto wrong_scope=scope();wrong_scope.allow_physical_write=false;
    refused([&]{restore_physical_hierarchy_review(missing,wrong_scope,token);},Code::ScopeDenied,"logical/read grant authorized physical restore");
    refused([&]{inspect_physical_hierarchy(missing,wrong_scope);},Code::ScopeDenied,"disabled scope probed storage");
    auto changed=token; changed.scope.allow_internal=false;
    refused([&]{restore_physical_hierarchy_review(missing,scope(),changed);},Code::ScopeDenied,"token supplied its own authority");
    changed=token;changed.diff_digest=QString(64,QLatin1Char('0'));
    refused([&]{restore_physical_hierarchy_review(path,scope(),changed);},Code::Conflict,"valid-shape wrong diff pin accepted");
    // Logical digests are not interchangeable even if both reviews use this snapshot.
    const auto lr=preview_logical_hierarchy(path,{d.project.id,true,true},
        {d.project.id,1,{RenameSubsystem{find(d.structure->subsystems,"software"),"Logical"}}});
    changed=token;changed.proposal_digest=export_logical_hierarchy_review(lr).proposal_digest;
    refused([&]{restore_physical_hierarchy_review(missing,scope(),changed);},Code::InvalidArgument,"logical digest accepted in physical token");
}

void missing_legacy_and_alias(const QTemporaryDir &temp) {
    const auto missing=temp.filePath("missing.sqlite");
    refused([&]{inspect_physical_hierarchy(missing,scope());},Code::OwnerUnavailable,"missing source accepted");
    check(!QFileInfo::exists(missing),"read created missing source");
    const auto legacy=temp.filePath("legacy.sqlite");auto flat=demo_project();
    flat.topology.revision=save_project(legacy,flat);const auto before=bytes(legacy);
    refused([&]{inspect_physical_hierarchy(legacy,scope());},Code::Unsupported,"flat store silently migrated");
    refused([&]{preview_physical_hierarchy(legacy,scope(),{flat.project.id,flat.topology.revision,
        {AddSite{{"site","New site",Privacy::Internal}}}});},Code::Unsupported,"legacy preview migrated store");
    check(bytes(legacy)==before,"legacy refusal changed database");
    const auto path=temp.filePath("alias.sqlite");const auto d=create(path);
    const auto r=preview_physical_hierarchy(path,scope(),rename(d));
    const auto alias=temp.path()+"/./alias.sqlite";
    refused([&]{commit_physical_hierarchy(alias,scope(),r);},Code::OwnerUnavailable,"unclean spelling accepted");
    {
        Sql rival(path);require(rival.run("BEGIN IMMEDIATE"),"Rival transaction failed.");
        refused([&]{commit_physical_hierarchy(path,scope(),r);},Code::OwnerUnavailable,"rival writer not refused");
        require(rival.run("ROLLBACK"),"Rival rollback failed.");
    }
    committed(commit_physical_hierarchy(path,scope(),r),2); // Admission refusal did not consume.
}

using Point=PhysicalHierarchyOwnerTestPoint;
QString hook_path;std::optional<Point> throw_at;
bool during_seen=false,during_rows_empty=false,before_seen=false,after_seen=false,rival_refused=false;
void hook(Point p) {
    if(p==Point::DuringRowRewrite){
        during_seen=true;
        // Inspect the actual owner writer connection in this isolated process.
        // The read-only keeper still sees the original graph; only the active
        // non-query-only writer can observe deleted rows and retained registry.
        for(const auto &name:QSqlDatabase::connectionNames()){
            const auto db=QSqlDatabase::database(name,false);
            if(!db.isOpen())continue;
            QSqlQuery info(db);if(!info.exec("PRAGMA database_list"))continue;
            bool same=false;
            while(info.next())if(info.value(1).toString()=="main" &&
                QFileInfo(info.value(2).toString()).canonicalFilePath()==QFileInfo(hook_path).canonicalFilePath())same=true;
            if(!same)continue;
            QSqlQuery mode(db);if(!mode.exec("PRAGMA query_only")||!mode.next()||mode.value(0).toInt()!=0)continue;
            QSqlQuery rows(db);
            if(rows.exec("SELECT (SELECT count(*) FROM project),(SELECT count(*) FROM assets),"
                         "(SELECT count(*) FROM sites),(SELECT count(*) FROM identity_registry)")&&rows.next())
                during_rows_empty=rows.value(0).toInt()==0&&rows.value(1).toInt()==0&&
                    rows.value(2).toInt()==0&&rows.value(3).toInt()>0;
        }
    }else if(p==Point::BeforeCommit){
        before_seen=true;Sql rival(hook_path);bool acquired=rival.run("BEGIN IMMEDIATE");
        rival_refused=!acquired;if(acquired)rival.run("ROLLBACK");
    }else after_seen=true;
    if(throw_at==p)throw lmti::Error("Isolated physical response fault.");
}
struct HookScope {
    HookScope(const QString &path,Point p){hook_path=path;throw_at=p;during_seen=during_rows_empty=before_seen=after_seen=rival_refused=false;set_physical_hierarchy_owner_test_hook(hook);}
    ~HookScope(){set_physical_hierarchy_owner_test_hook(nullptr);hook_path.clear();throw_at.reset();}
};
void transaction_faults(const QTemporaryDir &temp) {
    const auto path=temp.filePath("faults.sqlite");const auto d=create(path);const auto before=bytes(path);
    const auto p=proposal(d,{RetireEmptyArea{find(d.structure->areas,"empty-area")},
        AddArea{{"atomic-area","Atomic area","factory-demo","",Privacy::Internal}}});
    const auto during=preview_physical_hierarchy(path,scope(),p),during_copy=during;
    {
        HookScope installed(path,Point::DuringRowRewrite);
        refused([&]{commit_physical_hierarchy(path,scope(),during);},Code::OwnerUnavailable,
                "injected failure between DELETE and INSERT was not a known rollback");
        check(during_seen&&during_rows_empty&&!before_seen&&!after_seen,
              "row-rewrite fault did not observe actual deleted graph before INSERT");
    }
    unchanged(path,before,d,"mid-rewrite fault failed to restore graph/registry/revision");
    refused([&]{commit_physical_hierarchy(path,scope(),during_copy);},Code::Conflict,
            "mid-rewrite attempted review copy replayed");
    refused([&]{export_physical_hierarchy_review(during_copy);},Code::Conflict,
            "mid-rewrite consumed review exported");
    const auto review=preview_physical_hierarchy(path,scope(),p),copy=review;
    {
        HookScope installed(path,Point::BeforeCommit);
        refused([&]{commit_physical_hierarchy(path,scope(),review);},Code::OwnerUnavailable,"before-COMMIT failure was not known rollback");
        check(before_seen&&!after_seen&&rival_refused,"hook did not hold actual SQLite writer transaction");
    }
    unchanged(path,before,d,"rollback did not restore graph/registry/revision together");
    check(scalar(path,"SELECT count(*) FROM identity_registry WHERE entity_id='atomic-area'").toInt()==0 &&
          scalar(path,"SELECT state FROM identity_registry WHERE kind='area' AND entity_id='empty-area'").toString()=="active",
          "rollback retained partial registry mutation");
    refused([&]{commit_physical_hierarchy(path,scope(),copy);},Code::Conflict,"copied consumed rollback review replayed");
    refused([&]{export_physical_hierarchy_review(copy);},Code::Conflict,"attempted rollback review exported");
    const auto next=preview_physical_hierarchy(path,scope(),p),next_copy=next;
    {
        HookScope installed(path,Point::AfterCommit);
        const auto result=commit_physical_hierarchy(path,scope(),next);
        check(result.state==PhysicalHierarchyCommitState::Unknown&&result.revision==0,
              "actual committed lost-response fault mislabeled success/rollback");
        check(before_seen&&after_seen&&rival_refused,"post-COMMIT fault did not execute expected transaction");
    }
    const auto current=load_project(path);const auto saved=bytes(path);
    check(current.topology.revision==2 &&
          scalar(path,"SELECT state FROM identity_registry WHERE kind='area' AND entity_id='empty-area'").toString()=="retired" &&
          scalar(path,"SELECT state FROM identity_registry WHERE kind='area' AND entity_id='atomic-area'").toString()=="active",
          "post-COMMIT unknown lost exactly-one durable revision");
    refused([&]{commit_physical_hierarchy(path,scope(),next_copy);},Code::Conflict,"unknown review replayed");
    unchanged(path,saved,current,"unknown retry changed durable graph");
    committed(commit_physical_hierarchy(path,scope(),preview_physical_hierarchy(path,scope(),rename(current))),3);
}

void committed_wal(const QTemporaryDir &temp) {
    const auto path=temp.filePath("wal.sqlite");create(path);
    Sql keeper(path);require(keeper.run("PRAGMA journal_mode=WAL")&&keeper.run("PRAGMA wal_autocheckpoint=0"),"WAL setup failed.");
    const auto base=bytes(path);
    require(keeper.run("BEGIN IMMEDIATE")&&keeper.run("UPDATE project SET label='WAL physical fixture',revision=revision+1")&&keeper.run("COMMIT"),"WAL write failed.");
    require(QFileInfo(path+"-wal").size()>0&&bytes(path)==base,"Fixture has no committed WAL-only data.");
    const auto d=load_project(path);const auto wal_before=bytes(path+"-wal");
    const auto state=inspect_physical_hierarchy(path,scope());
    const auto review=preview_physical_hierarchy(path,scope(),rename(d));
    check(state.snapshot.revision==2&&review.reviewed_revision()==2,"physical owner ignored committed WAL");
    check(bytes(path)==base&&bytes(path+"-wal")==wal_before,"read-only preview checkpointed source WAL");
    committed(commit_physical_hierarchy(path,scope(),review),3);
    const auto after=load_project(path);
    check(after.project.label=="WAL physical fixture"&&after.topology.revision==3,"physical write dropped unrelated WAL fields");
}

void privacy_projection_parity(const QTemporaryDir &temp) {
    const auto path=temp.filePath("privacy.sqlite");auto d=fixture();auto &s=*d.structure;
    s.sites.push_back({"hidden-site","Hidden site",Privacy::Internal});
    s.areas.push_back({"hidden-area","Hidden area","factory-demo","",Privacy::Internal});
    s.environments.push_back({"hidden-env","Hidden environment",Privacy::Internal});
    s.environments.push_back({"unused-env","Unused public environment",Privacy::Public});
    d.topology.assets.push_back(asset("site-leaf","hidden-site"));
    d.topology.assets.push_back(asset("area-leaf"));
    d.topology.assets.push_back(asset("environment-leaf"));
    d.topology.assets.push_back(asset("private-parent","factory-demo",Privacy::Internal));
    d.topology.assets.push_back(asset("inherited-leaf"));
    s.asset_placements.push_back({"area-leaf","hidden-area","","",std::nullopt});
    s.asset_placements.push_back({"environment-leaf","","","hidden-env",std::nullopt});
    s.asset_placements.push_back({"private-parent","","","",std::nullopt});
    s.asset_placements.push_back({"inherited-leaf","","private-parent","",std::nullopt});
    d.topology.revision=save_project(path,d);d=load_project(path);
    const auto before=bytes(path);const auto full=inspect_physical_hierarchy(path,scope());
    const auto public_view=inspect_physical_hierarchy(path,scope(false));
    check(full.projection.environments.size()==4&&public_view.projection.environments.size()==3,
          "authoring projection omitted authorized unused environment");
    for(const auto &site:full.projection.sites){
        const auto v3=project_structure_snapshot(path,{d.project.id,site.value.id,false});
        const auto external=project_structure_snapshot(path,{d.project.id,site.value.id,true});
        check(projected(v3,"sites",site.value.id)["privacy"]==QString::fromStdString(name(site.classification)),
              "Site classification differs from v3");
        for(const auto &area:full.projection.areas)if(area.value.site_id==site.value.id){
            check(projected(v3,"areas",area.value.id)["privacy"]==QString::fromStdString(name(area.classification)),
                  "Area classification differs from v3");
            check(projected(external,"areas",area.value.id).isEmpty()==(area.classification==Privacy::Internal),
                  "external v3 Area visibility differs");
        }
        for(const auto &a:full.projection.assets)if(a.value.site==site.value.id){
            const auto row=projected(v3,"assets",a.value.id);
            check(row["privacy"]==QString::fromStdString(name(a.classification)) &&
                  row["placementDeclared"].toBool()==a.placement.has_value(),"Asset classification/declaration differs from v3");
            check(projected(external,"assets",a.value.id).isEmpty()==(a.classification==Privacy::Internal),
                  "external v3 Asset visibility differs");
            if(!a.placement||!a.placement->role)check(row["physicalRole"]=="unknown","physical role inferred from kind");
        }
        for(const auto &env:v3["environments"].toArray()){
            const auto id=env.toObject()["id"].toString().toStdString();
            auto it=std::find_if(full.projection.environments.begin(),full.projection.environments.end(),
                [&](const auto &e){return e.value.id==id;});
            check(it!=full.projection.environments.end()&&env.toObject()["privacy"]==QString::fromStdString(name(it->classification)),
                  "Environment classification differs from v3");
        }
        check(projected(v3,"environments","unused-env").isEmpty(),"v3 fixture unexpectedly emits unused environment");
    }
    for(const auto &a:public_view.projection.assets)
        check(a.value.id!="site-leaf"&&a.value.id!="area-leaf"&&a.value.id!="environment-leaf"&&
              a.value.id!="private-parent"&&a.value.id!="inherited-leaf","hidden ancestor promoted child to visible root");
    auto hidden=find(d.structure->sites,"hidden-site"),missing=hidden;missing.id="missing-site";
    const auto hidden_error=refused([&]{preview_physical_hierarchy(path,scope(false),proposal(d,{RenameSite{hidden,"Hidden edit"}}));},
        Code::ScopeDenied,"hidden site authorized");
    const auto missing_error=refused([&]{preview_physical_hierarchy(path,scope(false),proposal(d,{RenameSite{missing,"Hidden edit"}}));},
        Code::ScopeDenied,"unknown site authorized");
    check(hidden_error==missing_error&&!hidden_error.isEmpty(),"hidden and missing references disclose different evidence");
    refused([&]{preview_physical_hierarchy(path,scope(),proposal(d,{
        SetAssetPlacement{anchor(d,"environment-leaf"),placement(d,"environment-leaf"),std::nullopt}}));},
        Code::ScopeDenied,"clearing environment silently declassified an asset");
    unchanged(path,before,d,"privacy/projection checks changed project");
}

void budget_corruption_and_revision(const QTemporaryDir &temp) {
    const auto path=temp.filePath("budget.sqlite");const auto d=create(path);
    const auto count=scalar(path,"SELECT count(*) FROM identity_registry").toInt();
    require(count>0&&count<50000,"Registry fixture budget invalid.");
    mutate(path,QString("WITH RECURSIVE n(v) AS (VALUES(1) UNION ALL SELECT v+1 FROM n WHERE v<%1) "
        "INSERT INTO identity_registry SELECT 'area','historical-'||v,'retired' FROM n").arg(50000-count));
    const auto before=bytes(path);
    refused([&]{preview_physical_hierarchy(path,scope(),proposal(d,{
        AddArea{{"overflow","Overflow","factory-demo","",Privacy::Internal}}}));},
        Code::BudgetExceeded,"registry budget silently evicted history");
    check(bytes(path)==before&&scalar(path,"SELECT count(*) FROM identity_registry").toInt()==50000,
          "registry budget refusal changed history");
    const auto corrupt=temp.filePath("corrupt.sqlite");const auto c=create(corrupt);
    const auto r=preview_physical_hierarchy(corrupt,scope(),rename(c));
    mutate(corrupt,"DELETE FROM identity_registry WHERE kind='site' AND entity_id='factory-demo'");
    const auto damaged=bytes(corrupt);
    refused([&]{inspect_physical_hierarchy(corrupt,scope());},Code::OwnerUnavailable,"incomplete registry accepted");
    refused([&]{commit_physical_hierarchy(corrupt,scope(),r);},Code::OwnerUnavailable,"writer repaired corrupt registry");
    check(bytes(corrupt)==damaged,"corrupt registry refusal mutated source");
    const auto last=temp.filePath("last-revision.sqlite");create(last);
    mutate(last,"UPDATE project SET revision=9007199254740989");
    auto high=load_project(last);
    committed(commit_physical_hierarchy(last,scope(),preview_physical_hierarchy(last,scope(),rename(high))),9007199254740990LL);
    high=load_project(last);const auto last_bytes=bytes(last);
    check(inspect_physical_hierarchy(last,scope()).projection.revision==9007199254740990LL,
          "valid terminal revision became unreadable");
    refused([&]{preview_physical_hierarchy(last,scope(),rename(high,"Beyond limit"));},
        Code::BudgetExceeded,"last valid revision allowed another write");
    unchanged(last,last_bytes,high,"revision exhaustion changed source");
}

std::filesystem::path native_path(const QString &path) {
#ifdef Q_OS_WIN
    return std::filesystem::path(path.toStdWString());
#else
    return std::filesystem::path(QFile::encodeName(path).constData());
#endif
}
void hardlink_refusal(const QTemporaryDir &temp) {
    const auto path=temp.filePath("hardlink.sqlite"),alias=temp.filePath("hardlink-alias.sqlite");
    const auto d=create(path);const auto review=preview_physical_hierarchy(path,scope(),rename(d));const auto before=bytes(path);
    std::error_code error;std::filesystem::create_hard_link(native_path(path),native_path(alias),error);
    if(error){
        if(error==std::errc::operation_not_permitted||error==std::errc::permission_denied||error==std::errc::not_supported){
            ++skips;std::cout<<"SKIP hardlink fixture unavailable under local filesystem/permission policy\n";
        }else check(false,"unexpected hardlink fixture error");
        return;
    }
    refused([&]{preview_physical_hierarchy(path,scope(),rename(d));},Code::OwnerUnavailable,"hardlinked source accepted");
    refused([&]{commit_physical_hierarchy(path,scope(),review);},Code::OwnerUnavailable,"hardlinked commit accepted");
    check(bytes(path)==before&&bytes(alias)==before,"hardlink refusal wrote source");
    require(QFile::remove(alias),"Exact fixture alias cleanup failed.");
    committed(commit_physical_hierarchy(path,scope(),review),2);
}
}
int main(int argc,char **argv) {
    QCoreApplication app(argc,argv);QTemporaryDir temp;
    if(!temp.isValid()){std::cerr<<"Disposable physical fixture unavailable.\n";return 1;}
    const std::pair<const char *,void(*)(const QTemporaryDir &)> cases[]={
        {"eleven_operations",eleven_operations},{"placement_states_and_retirement",placement_states_and_retirement},
        {"shared_revision_and_old_values",shared_revision_and_old_values},{"snapshot_drift_and_replacement",snapshot_drift_and_replacement},
        {"malformed_tokens_and_scope",malformed_tokens_and_scope},{"missing_legacy_and_alias",missing_legacy_and_alias},
        {"transaction_faults",transaction_faults},{"committed_wal",committed_wal},
        {"privacy_projection_parity",privacy_projection_parity},{"budget_corruption_and_revision",budget_corruption_and_revision},
        {"hardlink_refusal",hardlink_refusal}};
    int passed=0;
    for(const auto &[name,call]:cases){
        const auto failed=failures,skipped=skips;
        try{call(temp);}catch(const std::exception &){++failures;std::cerr<<name<<": bounded fixture/owner exception.\n";}
        if(failures==failed&&skips==skipped)++passed;
        std::cout<<name<<": "<<(failures!=failed?"FAIL":skips!=skipped?"SKIP":"PASS")<<'\n';
    }
    std::cout<<passed<<'/'<<std::size(cases)<<" physical owner cases passed; "<<checks
             <<" behavioral checks; "<<failures<<" failures; "<<skips<<" skipped\n";
    return failures?1:0;
}
