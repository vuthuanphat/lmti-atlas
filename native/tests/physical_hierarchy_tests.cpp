#include "lmti/project_physical_hierarchy.hpp"
#include <algorithm>
#include <functional>
#include <iostream>
#include <set>
#include <stdexcept>
#include <string>
#include <utility>

namespace {
using namespace lmti;
using Code = PhysicalHierarchyCode;
using Entity = PhysicalHierarchyEntityKind;
int checks = 0, failures = 0;
void check(bool value, const char *message) {
    ++checks;
    if (!value) { ++failures; std::cerr << message << '\n'; }
}
void refuses(const std::function<void()> &call, Code code, const char *message) {
    try { call(); check(false, message); }
    catch (const PhysicalHierarchyError &error) {
        check(error.code() == code, message);
        check(std::string(error.what()) == "Physical hierarchy operation was refused.",
              "physical error disclosed nonconstant details");
    } catch (...) { check(false, "physical refusal escaped its typed error contract"); }
}
template<class Row> Row &find(std::vector<Row> &rows, const std::string &id) {
    const auto it = std::find_if(rows.begin(), rows.end(), [&](const auto &r) { return r.id == id; });
    if (it == rows.end()) throw std::runtime_error("invalid synthetic fixture identity");
    return *it;
}
template<class Row> const Row &find(const std::vector<Row> &rows, const std::string &id) {
    const auto it = std::find_if(rows.begin(), rows.end(), [&](const auto &r) { return r.id == id; });
    if (it == rows.end()) throw std::runtime_error("invalid synthetic fixture identity");
    return *it;
}
template<class Row> const Row *projected(const std::vector<Row> &rows, const std::string &id) {
    const auto it = std::find_if(rows.begin(), rows.end(), [&](const auto &r) { return r.value.id == id; });
    return it == rows.end() ? nullptr : &*it;
}
template<class Row> bool ordered(const std::vector<Row> &rows) {
    for (std::size_t i = 1; i < rows.size(); ++i) if (!(rows[i-1].id < rows[i].id)) return false;
    return true;
}
PhysicalHierarchyScope scope(const ProjectDocument &d, bool internal = true) {
    return {d.project.id, true, internal};
}
PhysicalHierarchyProposal proposal(const ProjectDocument &d, std::vector<PhysicalHierarchyChange> changes) {
    return {d.project.id, d.topology.revision, std::move(changes)};
}
PhysicalAssetAnchor anchor(const ProjectDocument &d, const std::string &id) {
    const auto &a = find(d.topology.assets, id);
    return {a.id, a.label, a.site, a.kind, a.privacy};
}
std::optional<AssetPlacement> placement(const ProjectDocument &d, const std::string &id) {
    const auto &rows = d.structure->asset_placements;
    const auto it = std::find_if(rows.begin(), rows.end(), [&](const auto &p) { return p.asset_id == id; });
    return it == rows.end() ? std::nullopt : std::optional<AssetPlacement>(*it);
}
SetAssetPlacement set(const ProjectDocument &d, const std::string &id, std::optional<AssetPlacement> desired) {
    return {anchor(d,id), placement(d,id), std::move(desired)};
}
const PhysicalHierarchyAffectedIdentity *affected(const PhysicalHierarchyDiff &diff, Entity kind, const std::string &id) {
    const auto it = std::find_if(diff.affected.begin(), diff.affected.end(),
        [&](const auto &r) { return r.kind == kind && r.id == id; });
    return it == diff.affected.end() ? nullptr : &*it;
}
void preserved(const ProjectDocument &before, const ProjectDocument &after) {
    auto restored = after;
    restored.structure->sites = before.structure->sites;
    restored.structure->areas = before.structure->areas;
    restored.structure->environments = before.structure->environments;
    restored.structure->asset_placements = before.structure->asset_placements;
    check(restored == before, "physical transition changed unrelated typed fields, revision or lineage");
}
ProjectDocument fixture() {
    auto d = demo_project();
    d.topology.revision = 7;
    d.topology.assets[0].enabled = false;
    d.topology.assets[0].poll_ms = 2200;
    d.topology.assets[0].observed = Observation::Online;
    d.topology.assets[0].observed_at = 1700000000;
    d.topology.assets[0].x = -13.5; d.topology.assets[0].y = 27.25;
    d.topology.assets.insert(d.topology.assets.end(), {
        {"free", "Unplaced", "factory-demo", Kind::Machine, Privacy::Public},
        {"area-hidden", "Hidden by area", "factory-demo", Kind::Sensor, Privacy::Public},
        {"env-hidden", "Hidden by environment", "factory-demo", Kind::Sensor, Privacy::Public},
        {"private-parent", "Internal parent", "factory-demo", Kind::Gateway, Privacy::Internal},
        {"parent-hidden", "Public child", "factory-demo", Kind::Sensor, Privacy::Public},
        {"site-hidden", "Unplaced private site", "private-site", Kind::Sensor, Privacy::Public},
        {"remote", "Remote", "remote-site", Kind::Sensor, Privacy::Public},
    });
    d.structure.emplace();
    auto &s = *d.structure;
    s.sites = {{"remote-site","Remote",Privacy::Public},{"factory-demo","Factory",Privacy::Public},
               {"private-site","Private",Privacy::Internal},{"empty-site","Empty",Privacy::Public}};
    s.areas = {{"cell","Cell","factory-demo","floor",Privacy::Public},
               {"private-child","Private path child","factory-demo","private-area",Privacy::Public},
               {"floor","Floor","factory-demo","",Privacy::Public},
               {"spare","Spare","factory-demo","",Privacy::Public},
               {"private-area","Private area","factory-demo","floor",Privacy::Internal},
               {"remote-area","Remote area","remote-site","",Privacy::Public},
               {"empty-area","Empty area","factory-demo","",Privacy::Public}};
    s.environments = {{"test-env","Test",Privacy::Public},{"private-env","Private",Privacy::Internal},
                      {"empty-env","Empty",Privacy::Public}};
    s.asset_placements = {
        {"machine-a","cell","gateway-b","test-env",PhysicalRole::Device},
        {"gateway-b","cell","broker-c","test-env",PhysicalRole::Gateway},
        {"broker-c","cell","","test-env",PhysicalRole::Host},
        {"area-hidden","private-child","","test-env",std::nullopt},
        {"env-hidden","floor","","private-env",std::nullopt},
        {"private-parent","floor","","test-env",PhysicalRole::Host},
        {"parent-hidden","floor","private-parent","test-env",std::nullopt},
        {"remote","remote-area","","test-env",std::nullopt},
    };
    s.subsystems = {{"logical-root","Logical root","",Privacy::Public},
                    {"logical-child","Logical child","logical-root",Privacy::Internal}};
    s.component_memberships = {{"sensor-firmware","logical-child"}};
    d.dependencies.push_back({"backend-sensor","monitor-backend","sensor-firmware","cycle allowed",Privacy::Public});
    d.releases[0].state = ReleaseState::Approved;
    d.verification = {{"validation","sensor-v020","machine-a","Synthetic evidence","Synthetic owner",1700000000,
                       EvidenceResult::OperatorDeclared,Privacy::Internal}};
    d.knowledge = {{"design","Design","sensor-firmware","declared-doc","synthetic-revision",Privacy::Internal}};
    d.storage_lineage = ProjectDocument::StorageLineage{d.project.id,2,"native-private-lineage",
        "11111111-1111-4111-8111-111111111111"};
    validate(d);
    return d;
}
ProjectDocument minimal() {
    ProjectDocument d;
    d.project = {"physical-project","Physical project","",Privacy::Public};
    d.topology.revision = 1; d.structure.emplace();
    d.structure->sites = {{"site","Site",Privacy::Public}};
    return d;
}
void projection_privacy() {
    const auto d = fixture(), copy = d;
    const auto public_view = project_physical_hierarchy(d,scope(d,false));
    check(public_view.project_id == d.project.id && public_view.revision == 7, "projection identity/revision");
    for (const auto &id : {"area-hidden","env-hidden","parent-hidden","private-parent","site-hidden"})
        check(!projected(public_view.assets,id), "hidden asset promoted or leaked");
    check(!projected(public_view.sites,"private-site") && !projected(public_view.areas,"private-area") &&
          !projected(public_view.areas,"private-child") && !projected(public_view.environments,"private-env"),
          "hidden catalog/descendant leaked");
    check(projected(public_view.sites,"empty-site") && projected(public_view.areas,"empty-area") &&
          projected(public_view.environments,"empty-env"), "authorized unused catalogs disappeared");
    const auto machine = projected(public_view.assets,"machine-a"), free = projected(public_view.assets,"free");
    check(machine && machine->path == PhysicalHierarchyPath{"factory-demo",{"floor","cell"},{"broker-c","gateway-b"},"test-env"},
          "independent physical path differs");
    check(free && !free->placement && free->path == PhysicalHierarchyPath{"factory-demo",{},{},""},
          "undeclared placement inferred");
    const auto all = project_physical_hierarchy(d,scope(d));
    for (const auto &id : {"area-hidden","env-hidden","parent-hidden","private-parent","site-hidden"}) {
        const auto row = projected(all.assets,id);
        check(row && row->classification == Privacy::Internal, "effective privacy inheritance omitted");
    }
    const auto hidden = projected(all.assets,"parent-hidden");
    check(hidden && hidden->value.privacy == Privacy::Public && hidden->path.asset_ancestors ==
          std::vector<std::string>{"private-parent"}, "stored privacy/path overwritten");
    const auto environment = projected(all.environments,"private-env");
    check(environment && environment->classification == Privacy::Internal, "environment privacy missing");
    check(std::is_sorted(all.assets.begin(),all.assets.end(),[](auto &a,auto &b){return a.value.id<b.value.id;}),
          "asset projection order unstable");
    check(d == copy, "pure projection mutated original");
    auto internal_project = d; internal_project.project.privacy = Privacy::Internal;
    refuses([&]{project_physical_hierarchy(internal_project,scope(internal_project,false));},Code::ScopeDenied,
            "project ancestry bypassed");
}
void all_eleven_and_preservation() {
    const auto d = fixture();
    auto p = proposal(d,{
        SetAssetPlacement{anchor(d,"free"),std::nullopt,AssetPlacement{"free","new-area","","new-env",std::nullopt}},
        RetireEmptyEnvironment{find(d.structure->environments,"empty-env")},
        RenameArea{find(d.structure->areas,"spare"),"Renamed spare"},
        AddArea{{"new-area","New area","factory-demo","",Privacy::Internal}},
        RenameEnvironment{find(d.structure->environments,"test-env"),"Renamed environment"},
        RetireEmptySite{find(d.structure->sites,"empty-site")},
        ReparentArea{find(d.structure->areas,"cell"),"spare"},
        AddEnvironment{{"new-env","New environment",Privacy::Internal}},
        RenameSite{find(d.structure->sites,"remote-site"),"Renamed remote"},
        RetireEmptyArea{find(d.structure->areas,"empty-area")},
        AddSite{{"new-site","New site",Privacy::Internal}},
    });
    const auto before = d;
    const auto transition = apply_physical_hierarchy(d,scope(d),p);
    check(d == before, "successful transition mutated input");
    preserved(d,transition.document);
    check(transition.diff.sites.size()==3 && transition.diff.areas.size()==4 &&
          transition.diff.environments.size()==3 && transition.diff.placements.size()==1,"11-op batch diff lost rows");
    check(ordered(transition.diff.sites)&&ordered(transition.diff.areas)&&ordered(transition.diff.environments),
          "changed rows not sorted by identity");
    check(find(transition.document.structure->sites,"remote-site").label=="Renamed remote" &&
          find(transition.document.structure->areas,"spare").label=="Renamed spare" &&
          find(transition.document.structure->environments,"test-env").label=="Renamed environment",
          "typed renames not applied");
    const auto machine = affected(transition.diff,Entity::Asset,"machine-a");
    check(machine && machine->before_path == PhysicalHierarchyPath{"factory-demo",{"floor","cell"},{"broker-c","gateway-b"},"test-env"} &&
          machine->after_path == PhysicalHierarchyPath{"factory-demo",{"spare","cell"},{"broker-c","gateway-b"},"test-env"},
          "unchanged descendant paths missing from review");
    const auto free = affected(transition.diff,Entity::Asset,"free");
    check(free && free->before_classification==Privacy::Public && free->after_classification==Privacy::Internal,
          "effective elevation absent from review");
    const auto added = affected(transition.diff,Entity::Site,"new-site"), retired = affected(transition.diff,Entity::Site,"empty-site");
    check(added && !added->before_classification && added->before_path==PhysicalHierarchyPath{} &&
          added->after_path==PhysicalHierarchyPath{"new-site",{},{},""},"new site path not typed");
    check(retired && !retired->after_classification && retired->after_path==PhysicalHierarchyPath{},"retired path retained");
    for(std::size_t i=1;i<transition.diff.affected.size();++i) {
        const auto &a=transition.diff.affected[i-1],&b=transition.diff.affected[i];
        check(std::pair{a.kind,a.id}<std::pair{b.kind,b.id},"affected identities not unique/stably ordered");
    }
    std::reverse(p.changes.begin(),p.changes.end());
    const auto reversed=apply_physical_hierarchy(d,scope(d),p);
    check(reversed.document==transition.document && reversed.diff==transition.diff,"input order changed final transition");
}
void placement_declaration_and_role() {
    auto d=fixture();
    const auto declared=apply_physical_hierarchy(d,scope(d),proposal(d,{set(d,"free",AssetPlacement{"free","","","",std::nullopt})}));
    const auto &change=declared.diff.placements.at(0);
    check(!change.before && change.after && !change.after->role,"null and declared-empty placement collapsed");
    auto view=project_physical_hierarchy(declared.document,scope(d));
    const auto row=projected(view.assets,"free");
    check(row && row->placement && !row->placement->role && row->value.kind==Kind::Machine,
          "role inferred from asset kind");
    preserved(d,declared.document);
    const auto cleared=apply_physical_hierarchy(declared.document,scope(d),proposal(declared.document,{set(declared.document,"free",std::nullopt)}));
    check(cleared.document==d && cleared.diff.placements.at(0).before && !cleared.diff.placements.at(0).after,
          "declared-empty removal retired/changed asset");
    for(auto role:{PhysicalRole::Host,PhysicalRole::Gateway,PhysicalRole::Device}) {
        const auto changed=apply_physical_hierarchy(d,scope(d),proposal(d,{set(d,"free",AssetPlacement{"free","","","",role})}));
        check(placement(changed.document,"free")->role==role && find(changed.document.topology.assets,"free").kind==Kind::Machine,
              "explicit physical role changed asset kind");
        preserved(d,changed.document);
    }
}
void original_values_and_noops() {
    const auto d=fixture();
    auto bad_site=find(d.structure->sites,"remote-site");bad_site.label="Stale";
    auto bad_area=find(d.structure->areas,"spare");bad_area.label="Stale";
    auto bad_env=find(d.structure->environments,"empty-env");bad_env.label="Stale";
    for(const auto &op:std::vector<PhysicalHierarchyChange>{RenameSite{bad_site,"New"},RenameArea{bad_area,"New"},
             RenameEnvironment{bad_env,"New"}})
        refuses([&]{apply_physical_hierarchy(d,scope(d),proposal(d,{op}));},Code::Conflict,"stale catalog old value accepted");
    for(int field=0;field<5;++field) {
        auto stale=anchor(d,"free");
        if(field==0)stale.label="Old label";if(field==1)stale.site="remote-site";
        if(field==2)stale.kind=Kind::Gateway;if(field==3)stale.privacy=Privacy::Internal;
        if(field==4)stale.id="machine-a";
        const auto id=stale.id;
        auto op=SetAssetPlacement{stale,std::nullopt,AssetPlacement{id,"","","",PhysicalRole::Host}};
        refuses([&]{apply_physical_hierarchy(d,scope(d),proposal(d,{op}));},Code::Conflict,"stale asset anchor accepted");
    }
    auto stale=set(d,"machine-a",AssetPlacement{"machine-a","cell","gateway-b","test-env",PhysicalRole::Host});
    stale.expected->role=PhysicalRole::Gateway;
    refuses([&]{apply_physical_hierarchy(d,scope(d),proposal(d,{stale}));},Code::Conflict,"stale placement accepted");
    auto p=proposal(d,{RenameArea{find(d.structure->areas,"spare"),"New"}});--p.expected_revision;
    refuses([&]{apply_physical_hierarchy(d,scope(d),p);},Code::Conflict,"stale revision accepted");
    for(const auto &op:std::vector<PhysicalHierarchyChange>{
            RenameSite{find(d.structure->sites,"remote-site"),"Remote"},RenameArea{find(d.structure->areas,"spare"),"Spare"},
            RenameEnvironment{find(d.structure->environments,"empty-env"),"Empty"},
            ReparentArea{find(d.structure->areas,"cell"),"floor"},set(d,"free",std::nullopt),set(d,"machine-a",placement(d,"machine-a"))})
        refuses([&]{apply_physical_hierarchy(d,scope(d),proposal(d,{op}));},Code::InvalidArgument,"no-op accepted");
    p=proposal(d,{RenameArea{find(d.structure->areas,"spare"),"Intermediate"},
                 RenameArea{Area{"spare","Intermediate","factory-demo","",Privacy::Public},"Final"}});
    refuses([&]{normalize_physical_hierarchy_proposal(scope(d),p);},Code::InvalidArgument,"sequential expected values bypassed duplicate target");
    check(d==fixture(),"refused original/no-op checks mutated input");
}
void final_references_and_retirement() {
    auto d=fixture();
    const auto created=apply_physical_hierarchy(d,scope(d),proposal(d,{
        set(d,"free",AssetPlacement{"free","a-child","","z-env",std::nullopt}),
        AddArea{{"a-child","Child","factory-demo","z-parent",Privacy::Internal}},
        AddArea{{"z-parent","Parent","factory-demo","",Privacy::Internal}},
        AddEnvironment{{"z-env","Environment",Privacy::Internal}},AddSite{{"z-site","Site",Privacy::Internal}}}));
    const auto free=affected(created.diff,Entity::Asset,"free");
    check(free && free->after_path==PhysicalHierarchyPath{"factory-demo",{"z-parent","a-child"},{},"z-env"},
          "final-draft added references not resolved independently of request order");
    preserved(d,created.document);

    // Retire only after all uses in the final draft have been removed or moved.
    std::vector<PhysicalHierarchyChange> changes{RetireEmptyEnvironment{find(d.structure->environments,"test-env")}};
    for (const auto &p : d.structure->asset_placements) if(p.environment_id=="test-env") {
        auto desired=p;desired.environment_id.clear();changes.push_back(set(d,p.asset_id,desired));
    }
    auto result=apply_physical_hierarchy(d,scope(d),proposal(d,changes));
    check(!projected(project_physical_hierarchy(result.document,scope(d)).environments,"test-env"),
          "final environment detach then retire failed");
    check(result.diff.placements.size()==7 && result.document.topology.assets==d.topology.assets,
          "environment retirement cascaded into assets or omitted cross-site users");
    preserved(d,result.document);

    changes={RetireEmptyArea{find(d.structure->areas,"cell")}};
    for(const auto &id:{"machine-a","gateway-b","broker-c"}) {
        auto desired=*placement(d,id);desired.area_id="floor";changes.push_back(set(d,id,desired));
    }
    result=apply_physical_hierarchy(d,scope(d),proposal(d,changes));
    check(result.diff.areas.size()==1 && result.diff.placements.size()==3,
          "coordinated area detach then retire refused");
    check(placement(result.document,"machine-a")->parent_asset_id=="gateway-b",
          "area retirement implicitly rewrote asset ancestry");
    preserved(d,result.document);

    d.structure->areas.push_back({"detach-parent","Parent","factory-demo","",Privacy::Public});
    d.structure->areas.push_back({"detach-child","Child","factory-demo","detach-parent",Privacy::Public});
    result=apply_physical_hierarchy(d,scope(d),proposal(d,{
        RetireEmptyArea{find(d.structure->areas,"detach-parent")},
        ReparentArea{find(d.structure->areas,"detach-child"),"floor"}}));
    check(find(result.document.structure->areas,"detach-child").parent_area_id=="floor",
          "final reparent then parent retirement failed");

    d.structure->areas.push_back({"unused-child","Child","empty-site","",Privacy::Public});
    result=apply_physical_hierarchy(d,scope(d),proposal(d,{
        RetireEmptySite{find(d.structure->sites,"empty-site")},
        RetireEmptyArea{find(d.structure->areas,"unused-child")}}));
    check(result.diff.sites.size()==1 && result.diff.areas.size()==1,
          "final child/site retirement evaluated against original users");
    for(const auto &op:std::vector<PhysicalHierarchyChange>{
        RetireEmptySite{find(d.structure->sites,"factory-demo")},
        RetireEmptySite{find(d.structure->sites,"private-site")},
        RetireEmptyArea{find(d.structure->areas,"cell")},
        RetireEmptyArea{find(d.structure->areas,"floor")},
        RetireEmptyEnvironment{find(d.structure->environments,"test-env")}})
        refuses([&]{apply_physical_hierarchy(d,scope(d),proposal(d,{op}));},Code::Conflict,
                "catalog retirement accepted surviving final users");
    auto moved=*placement(d,"broker-c");moved.area_id="floor";
    refuses([&]{apply_physical_hierarchy(d,scope(d),proposal(d,{set(d,"broker-c",moved)}));},
            Code::InvalidArgument,"parent move implicitly moved dependent placements");
}

void hidden_target_oracles() {
    const auto d=fixture();
    // Existing hidden and nonexistent targets must not disclose which old value
    // differed. These expected rows are deliberately stale but well shaped.
    for(bool missing:{false,true}) {
        auto s=find(d.structure->sites,"private-site");s.label="Stale";s.privacy=Privacy::Public;
        auto a=find(d.structure->areas,"private-area");a.label="Stale";a.privacy=Privacy::Public;
        auto e=find(d.structure->environments,"private-env");e.label="Stale";e.privacy=Privacy::Public;
        auto asset=anchor(d,"parent-hidden");asset.label="Stale";
        if(missing) {s.id="missing-site";a.id="missing-area";e.id="missing-env";asset.id="missing-asset";}
        for(const auto &op:std::vector<PhysicalHierarchyChange>{
            RenameSite{s,"New"},RetireEmptySite{s},RenameArea{a,"New"},ReparentArea{a,"spare"},
            RetireEmptyArea{a},RenameEnvironment{e,"New"},RetireEmptyEnvironment{e},
            SetAssetPlacement{asset,std::nullopt,AssetPlacement{asset.id,"","","",PhysicalRole::Device}}})
            refuses([&]{apply_physical_hierarchy(d,scope(d,false),proposal(d,{op}));},
                    Code::ScopeDenied,"hidden versus unknown target disclosed an old-value conflict");
    }
    // A hidden desired ancestor must be authorized before a visible stale
    // expected row can leak structural/old-value information.
    for(const auto &id:{"private-area","missing-area"}) {
        auto a=find(d.structure->areas,"spare");a.label="Stale";
        refuses([&]{apply_physical_hierarchy(d,scope(d,false),proposal(d,{ReparentArea{a,id}}));},
                Code::ScopeDenied,"hidden or missing desired ancestor was checked after old values");
    }
    for(const auto &desired:std::vector<AssetPlacement>{
        {"free","private-child","","",std::nullopt},{"free","missing-area","","",std::nullopt},
        {"free","","","private-env",std::nullopt},{"free","","","missing-env",std::nullopt},
        {"free","floor","private-parent","test-env",std::nullopt},
        {"free","floor","missing-asset","test-env",std::nullopt}}) {
        auto a=anchor(d,"free");a.label="Stale";
        refuses([&]{apply_physical_hierarchy(d,scope(d,false),
            proposal(d,{SetAssetPlacement{a,std::nullopt,desired}}));},Code::ScopeDenied,
            "stale anchor exposed hidden versus missing desired placement reference");
    }
    for(const auto &op:std::vector<PhysicalHierarchyChange>{
        set(d,"free",AssetPlacement{"free","private-child","","",std::nullopt}),
        set(d,"free",AssetPlacement{"free","","","private-env",std::nullopt}),
        set(d,"free",AssetPlacement{"free","floor","private-parent","test-env",std::nullopt})})
        refuses([&]{apply_physical_hierarchy(d,scope(d,false),proposal(d,{op}));},
                Code::ScopeDenied,"hidden placement ancestry accepted");
    const auto independent=apply_physical_hierarchy(d,scope(d,false),
        proposal(d,{RenameArea{find(d.structure->areas,"spare"),"Independent rename"}}));
    check(independent.diff.affected.size()==1 && independent.diff.affected[0].id=="spare",
          "unrelated hidden rows either blocked an independent edit or leaked into diff");
    preserved(d,independent.document);
    for(const auto &op:std::vector<PhysicalHierarchyChange>{
        RenameSite{find(d.structure->sites,"factory-demo"),"Changed"},
        RenameArea{find(d.structure->areas,"floor"),"Changed"},
        RenameEnvironment{find(d.structure->environments,"test-env"),"Changed"}})
        refuses([&]{apply_physical_hierarchy(d,scope(d,false),proposal(d,{op}));},
                Code::ScopeDenied,"hidden unchanged descendant bypassed authorization");
}

void effective_classification_policy() {
    const auto d=fixture();
    auto env=*placement(d,"env-hidden");env.environment_id.clear();
    auto parent=*placement(d,"parent-hidden");parent.parent_asset_id.clear();
    for(const auto &op:std::vector<PhysicalHierarchyChange>{
        set(d,"env-hidden",env),set(d,"area-hidden",std::nullopt),set(d,"parent-hidden",parent),
        ReparentArea{find(d.structure->areas,"private-child"),"spare"}})
        refuses([&]{apply_physical_hierarchy(d,scope(d),proposal(d,{op}));},
                Code::ScopeDenied,"effective declassification accepted with Internal authority");
    std::vector<PhysicalHierarchyChange> elevated;
    for(const auto &id:{"machine-a","gateway-b","broker-c"}) {
        auto p=*placement(d,id);p.area_id="private-area";elevated.push_back(set(d,id,p));
    }
    const auto result=apply_physical_hierarchy(d,scope(d),proposal(d,elevated));
    for(const auto &id:{"machine-a","gateway-b","broker-c"}) {
        const auto row=affected(result.diff,Entity::Asset,id);
        check(row && row->before_classification==Privacy::Public && row->after_classification==Privacy::Internal,
              "effective elevation missing from affected diff");
        check(find(result.document.topology.assets,id).privacy==Privacy::Public,
              "inherited classification overwrote declared privacy");
    }
    preserved(d,result.document);
    const auto hidden_view=project_physical_hierarchy(result.document,scope(d,false));
    for(const auto &id:{"machine-a","gateway-b","broker-c"})
        check(!projected(hidden_view.assets,id),"newly hidden descendant remained publicly visible");
}

void complete_affected_and_kind_identity() {
    const auto d=fixture();
    const auto result=apply_physical_hierarchy(d,scope(d),proposal(d,{
        RenameSite{find(d.structure->sites,"factory-demo"),"New factory"},
        RenameEnvironment{find(d.structure->environments,"test-env"),"New test"}}));
    // Site scope and global environment membership independently enlarge this
    // set. In particular remote is affected despite residing at another site.
    std::set<std::pair<Entity,std::string>> expected{{Entity::Site,"factory-demo"},{Entity::Environment,"test-env"}};
    for(const auto &id:{"cell","private-child","floor","spare","private-area","empty-area"})
        expected.emplace(Entity::Area,id);
    for(const auto &id:{"machine-a","gateway-b","broker-c","free","area-hidden","env-hidden","private-parent","parent-hidden","remote"})
        expected.emplace(Entity::Asset,id);
    std::set<std::pair<Entity,std::string>> actual;
    for(const auto &row:result.diff.affected) {
        actual.emplace(row.kind,row.id);
        check(row.before_classification==row.after_classification && row.before_path==row.after_path,
              "rename fabricated classification/path changes");
    }
    check(actual==expected && result.diff.affected.size()==expected.size(),
          "complete unchanged descendant/global environment closure differs");
    check(result.diff.placements.empty() && result.diff.areas.empty(),
          "affected descendants were incorrectly recorded as changed rows");
    preserved(d,result.document);

    auto shared=minimal();shared.structure->sites[0].id="shared";
    shared.structure->areas={{"shared","Area","shared","",Privacy::Public}};
    shared.structure->environments={{"shared","Environment",Privacy::Public}};
    shared.topology.assets={{"shared","Asset","shared",Kind::Machine,Privacy::Public}};
    validate(shared);
    const auto mixed=apply_physical_hierarchy(shared,scope(shared),proposal(shared,{
        RenameSite{shared.structure->sites[0],"Site renamed"},
        RenameArea{shared.structure->areas[0],"Area renamed"},
        RenameEnvironment{shared.structure->environments[0],"Environment renamed"},
        set(shared,"shared",AssetPlacement{"shared","shared","","shared",std::nullopt})}));
    check(mixed.diff.sites.size()==1 && mixed.diff.areas.size()==1 && mixed.diff.environments.size()==1 &&
          mixed.diff.placements.size()==1 && mixed.diff.affected.size()==4,
          "same stable ID in different typed namespaces collided");
    for(auto kind:{Entity::Site,Entity::Area,Entity::Environment,Entity::Asset})
        check(affected(mixed.diff,kind,"shared")!=nullptr,"typed namespace affected identity lost");
}

void graph_rules() {
    const auto d=fixture();
    for(const auto &op:std::vector<PhysicalHierarchyChange>{
        ReparentArea{find(d.structure->areas,"floor"),"cell"},
        ReparentArea{find(d.structure->areas,"cell"),"cell"},
        ReparentArea{find(d.structure->areas,"spare"),"remote-area"},
        set(d,"broker-c",AssetPlacement{"broker-c","cell","machine-a","test-env",PhysicalRole::Host}),
        set(d,"machine-a",AssetPlacement{"machine-a","cell","machine-a","test-env",PhysicalRole::Device}),
        set(d,"free",AssetPlacement{"free","remote-area","","",std::nullopt}),
        set(d,"free",AssetPlacement{"free","floor","remote","test-env",std::nullopt}),
        set(d,"free",AssetPlacement{"free","floor","broker-c","test-env",std::nullopt}),
        set(d,"free",AssetPlacement{"free","cell","broker-c","",std::nullopt}),
        set(d,"machine-a",AssetPlacement{"machine-a","cell","free","test-env",std::nullopt})})
        refuses([&]{apply_physical_hierarchy(d,scope(d),proposal(d,{op}));},Code::InvalidArgument,
                "cycle/cross-site/mismatched placement or undeclared parent accepted");
    for(const auto &op:std::vector<PhysicalHierarchyChange>{
        AddArea{{"new","New","missing-site","",Privacy::Internal}},
        AddArea{{"new","New","factory-demo","missing-area",Privacy::Internal}},
        ReparentArea{find(d.structure->areas,"spare"),"missing-area"},
        set(d,"free",AssetPlacement{"free","missing-area","","",std::nullopt}),
        set(d,"free",AssetPlacement{"free","","missing-asset","",std::nullopt}),
        set(d,"free",AssetPlacement{"free","","","missing-env",std::nullopt})})
        refuses([&]{apply_physical_hierarchy(d,scope(d),proposal(d,{op}));},Code::ScopeDenied,
                "unknown final reference disclosed existence or was accepted");
    refuses([&]{apply_physical_hierarchy(d,scope(d),proposal(d,{
        AddArea{{"a","A","factory-demo","b",Privacy::Internal}},
        AddArea{{"b","B","factory-demo","a",Privacy::Internal}}}));},
            Code::InvalidArgument,"final added area cycle accepted");
    // Explicit coordinated final references succeed although neither order is
    // a valid sequence of intermediate graphs.
    auto p1=*placement(d,"broker-c");p1.parent_asset_id="gateway-b";
    auto p2=*placement(d,"gateway-b");p2.parent_asset_id.clear();
    const auto result=apply_physical_hierarchy(d,scope(d),proposal(d,{
        set(d,"broker-c",p1),set(d,"gateway-b",p2)}));
    const auto leaf=affected(result.diff,Entity::Asset,"machine-a");
    check(leaf && leaf->after_path.asset_ancestors==std::vector<std::string>{"gateway-b"},
          "coordinated parent rearrangement failed final-graph semantics");
}

void request_validation() {
    const auto d=fixture();
    auto good=proposal(d,{RenameArea{find(d.structure->areas,"spare"),"Changed"}});
    auto denied=scope(d);denied.allow_physical_write=false;
    refuses([&]{normalize_physical_hierarchy_proposal(denied,good);},Code::ScopeDenied,"missing explicit physical grant accepted");
    denied=scope(d);denied.project_id="another-project";
    refuses([&]{normalize_physical_hierarchy_proposal(denied,good);},Code::ScopeDenied,"cross-project proposal accepted");
    for(auto rev:{-1LL,0LL,9007199254740991LL}) {
        auto p=good;p.expected_revision=rev;
        refuses([&]{normalize_physical_hierarchy_proposal(scope(d),p);},Code::InvalidArgument,"invalid revision accepted");
    }
    refuses([&]{normalize_physical_hierarchy_proposal(scope(d),proposal(d,{}));},Code::InvalidArgument,"empty batch accepted");
    auto max=proposal(d,{});
    for(int i=0;i<32;++i)max.changes.push_back(AddEnvironment{{"env-"+std::to_string(i),"New",Privacy::Internal}});
    check(normalize_physical_hierarchy_proposal(scope(d),max).changes.size()==32,"32-change request refused");
    max.changes.push_back(AddSite{{"site-extra","Extra",Privacy::Internal}});
    refuses([&]{normalize_physical_hierarchy_proposal(scope(d),max);},Code::BudgetExceeded,"33-change request accepted");
    for(const auto &op:std::vector<PhysicalHierarchyChange>{
        AddSite{{"new","New",Privacy::Public}},AddArea{{"new","New","factory-demo","",Privacy::Public}},
        AddEnvironment{{"new","New",Privacy::Public}}})
        refuses([&]{normalize_physical_hierarchy_proposal(scope(d),proposal(d,{op}));},Code::ScopeDenied,
                "new catalog created directly Public");
    for(const auto &label:std::vector<std::string>{"",std::string(121,'x'),"bad\nlabel",std::string("\xc0\xaf",2)}) {
        auto p=proposal(d,{RenameSite{find(d.structure->sites,"remote-site"),label}});
        refuses([&]{normalize_physical_hierarchy_proposal(scope(d),p);},Code::InvalidArgument,"invalid label accepted");
    }
    std::string unicode;
    for(int i=0;i<60;++i)unicode+="\xc3\xa9";
    check(normalize_physical_hierarchy_proposal(scope(d),
        proposal(d,{RenameSite{find(d.structure->sites,"remote-site"),unicode}})).changes.size()==1,
        "valid 120-byte UTF8 label refused");
    unicode+="\xc3\xa9";
    refuses([&]{normalize_physical_hierarchy_proposal(scope(d),
        proposal(d,{RenameSite{find(d.structure->sites,"remote-site"),unicode}}));},
        Code::InvalidArgument,"122-byte UTF8 label accepted");
    auto bad_asset=anchor(d,"free");bad_asset.kind=static_cast<Kind>(99);
    for(const auto &op:std::vector<PhysicalHierarchyChange>{
        AddSite{{"../escape","New",Privacy::Internal}},
        AddSite{{"new","New",static_cast<Privacy>(99)}},
        SetAssetPlacement{bad_asset,std::nullopt,AssetPlacement{"free","","","",std::nullopt}},
        set(d,"free",AssetPlacement{"other","","","",std::nullopt}),
        set(d,"free",AssetPlacement{"free","","","",static_cast<PhysicalRole>(99)})})
        refuses([&]{normalize_physical_hierarchy_proposal(scope(d),proposal(d,{op}));},Code::InvalidArgument,
                "invalid ID/enum/placement anchor accepted");
    refuses([&]{normalize_physical_hierarchy_proposal(scope(d),proposal(d,{
        AddSite{{"duplicate","One",Privacy::Internal}},AddSite{{"duplicate","Two",Privacy::Internal}}}));},
        Code::InvalidArgument,"duplicate typed target accepted");

    // Each individually valid row stays within label/ID bounds; repeated
    // escaped labels and full placement pins exceed the aggregate wire budget.
    auto large=proposal(d,{});
    const auto long_id=std::string(60,'a');
    for(int i=0;i<32;++i) {
        const auto id=long_id+std::to_string(i);
        PhysicalAssetAnchor a{id,std::string(120,'"'),long_id,Kind::Machine,Privacy::Public};
        large.changes.push_back(SetAssetPlacement{a,
            AssetPlacement{id,long_id,long_id,long_id,PhysicalRole::Host},
            AssetPlacement{id,long_id,long_id,long_id,PhysicalRole::Device}});
    }
    refuses([&]{normalize_physical_hierarchy_proposal(scope(d),large);},Code::BudgetExceeded,
            "aggregate escaped request budget bypassed by individually valid fields");
}

ProjectDocument area_chain(int count) {
    auto d=minimal();
    d.topology.assets={{"leaf","Leaf","site",Kind::Sensor,Privacy::Public}};
    for(int i=1;i<=count;++i)
        d.structure->areas.push_back({"a"+std::to_string(i),"Area","site",i==1?"":"a"+std::to_string(i-1),Privacy::Public});
    std::reverse(d.structure->areas.begin(),d.structure->areas.end());
    validate(d);return d;
}
ProjectDocument asset_chain(int count) {
    auto d=minimal();
    d.structure->environments={{"env","Environment",Privacy::Public}};
    for(int i=1;i<=count;++i) {
        auto id="n"+std::to_string(i);
        d.topology.assets.push_back({id,"Asset","site",Kind::Sensor,Privacy::Public});
        d.structure->asset_placements.push_back({id,"",i==1?"":"n"+std::to_string(i-1),"env",std::nullopt});
    }
    d.topology.assets.push_back({"leaf","Leaf","site",Kind::Sensor,Privacy::Public});
    std::reverse(d.topology.assets.begin(),d.topology.assets.end());
    std::reverse(d.structure->asset_placements.begin(),d.structure->asset_placements.end());
    validate(d);return d;
}
void depth_limits() {
    auto d=area_chain(31);
    auto result=apply_physical_hierarchy(d,scope(d),
        proposal(d,{set(d,"leaf",AssetPlacement{"leaf","a31","","",std::nullopt})}));
    const auto leaf=affected(result.diff,Entity::Asset,"leaf");
    check(leaf && leaf->after_path.area_ancestors.size()==31 && leaf->after_path.area_ancestors.front()=="a1" &&
          leaf->after_path.area_ancestors.back()=="a31","area+asset depth32 refused or reversed");
    check(apply_physical_hierarchy(d,scope(d),proposal(d,{
        AddArea{{"a32","Area","site","a31",Privacy::Internal}}})).document.structure->areas.size()==32,
        "area depth32 refused");
    refuses([&]{apply_physical_hierarchy(d,scope(d),proposal(d,{
        AddArea{{"a32","Area","site","a31",Privacy::Internal}},
        set(d,"leaf",AssetPlacement{"leaf","a32","","",std::nullopt})}));},Code::InvalidArgument,
        "area+asset depth33 accepted");
    refuses([&]{apply_physical_hierarchy(d,scope(d),proposal(d,{
        AddArea{{"a32","Area","site","a31",Privacy::Internal}},
        AddArea{{"a33","Area","site","a32",Privacy::Internal}}}));},Code::InvalidArgument,
        "area depth33 accepted");
    d=asset_chain(31);
    result=apply_physical_hierarchy(d,scope(d),proposal(d,{
        set(d,"leaf",AssetPlacement{"leaf","","n31","env",std::nullopt})}));
    const auto nested=affected(result.diff,Entity::Asset,"leaf");
    check(nested && nested->after_path.asset_ancestors.size()==31 && nested->after_path.asset_ancestors.front()=="n1" &&
          nested->after_path.asset_ancestors.back()=="n31" && nested->after_path.environment_id=="env",
          "asset depth32/environment independent membership refused");
    d=asset_chain(32);
    refuses([&]{apply_physical_hierarchy(d,scope(d),proposal(d,{
        set(d,"leaf",AssetPlacement{"leaf","","n32","env",std::nullopt})}));},Code::InvalidArgument,
        "asset depth33 accepted");
    // Neither local tree alone exceeds the bound; their combined depth does.
    d=area_chain(16);d.topology.assets.clear();
    for(int i=1;i<=16;++i) {
        auto id="n"+std::to_string(i);
        d.topology.assets.push_back({id,"Asset","site",Kind::Sensor,Privacy::Public});
        d.structure->asset_placements.push_back({id,"a16",i==1?"":"n"+std::to_string(i-1),"",std::nullopt});
    }
    validate(d);
    const auto view=project_physical_hierarchy(d,scope(d));
    const auto deepest=projected(view.assets,"n16");
    check(deepest && deepest->path.area_ancestors.size()==16 && deepest->path.asset_ancestors.size()==15,
          "valid combined depth32 projection lost ancestry");
    std::vector<PhysicalHierarchyChange> changes{AddArea{{"a17","Area","site","a16",Privacy::Internal}}};
    for(const auto &p:d.structure->asset_placements) {
        auto desired=p;desired.area_id="a17";changes.push_back(set(d,p.asset_id,desired));
    }
    refuses([&]{apply_physical_hierarchy(d,scope(d),proposal(d,changes));},Code::InvalidArgument,
        "combined area/asset depth33 accepted");
}

void catalog_and_asset_budgets() {
    for(int kind=0;kind<3;++kind) {
        auto d=minimal();
        if(kind==0)d.structure->sites.clear();
        for(std::size_t i=0;i<max_project_records;++i) {
            auto id="row-"+std::to_string(i);
            if(kind==0)d.structure->sites.push_back({id,"Site",Privacy::Public});
            if(kind==1)d.structure->areas.push_back({id,"Area","site","",Privacy::Public});
            if(kind==2)d.structure->environments.push_back({id,"Environment",Privacy::Public});
        }
        validate(d);
        const auto before=d;
        const auto view=project_physical_hierarchy(d,scope(d));
        check((kind==0?view.sites.size():kind==1?view.areas.size():view.environments.size())==max_project_records,
              "full 2000-row catalog projection truncated");
        const auto op=kind==0?PhysicalHierarchyChange(AddSite{{"extra","Extra",Privacy::Internal}}):
            kind==1?PhysicalHierarchyChange(AddArea{{"extra","Extra","site","",Privacy::Internal}}):
                    PhysicalHierarchyChange(AddEnvironment{{"extra","Extra",Privacy::Internal}});
        refuses([&]{apply_physical_hierarchy(d,scope(d),proposal(d,{op}));},Code::BudgetExceeded,
                "2001-row final catalog accepted");
        check(d==before,"budget refusal modified input");
    }
    auto d=minimal();
    for(std::size_t i=0;i<max_assets;++i)
        d.topology.assets.push_back({"asset-"+std::to_string(i),"Asset","site",Kind::Sensor,Privacy::Public});
    validate(d);
    const auto view=project_physical_hierarchy(d,scope(d,false));
    check(view.assets.size()==max_assets,"physical projection inherited a smaller logical/UI budget");
    const auto result=apply_physical_hierarchy(d,scope(d,false),
        proposal(d,{RenameSite{d.structure->sites[0],"Full site rename"}}));
    check(result.diff.affected.size()==max_assets+1 && result.diff.placements.empty(),
          "full 10000-asset affected set truncated");
    check(affected(result.diff,Entity::Asset,"asset-0") && affected(result.diff,Entity::Asset,"asset-9999"),
          "broad review omitted boundary identities");
    preserved(d,result.document);
}

void saved_schema_and_integrity() {
    const auto d=fixture();
    const auto p=proposal(d,{RenameArea{find(d.structure->areas,"spare"),"Changed"}});
    auto flat=d;flat.structure.reset();flat.storage_lineage.reset();
    refuses([&]{project_physical_hierarchy(flat,scope(d));},Code::Unsupported,"flat projection implicitly seeded structure");
    refuses([&]{apply_physical_hierarchy(flat,scope(d),p);},Code::Unsupported,"flat apply implicitly migrated structure");
    auto unsaved=d;unsaved.topology.revision=0;
    refuses([&]{apply_physical_hierarchy(unsaved,scope(d),p);},Code::Unsupported,"unsaved structure accepted for review");
    auto corrupt=d;find(corrupt.structure->areas,"cell").parent_area_id="absent";
    refuses([&]{project_physical_hierarchy(corrupt,scope(d));},Code::InvalidArgument,"corrupt current graph projected");
    auto exhausted=d;exhausted.topology.revision=9007199254740990LL;
    check(project_physical_hierarchy(exhausted,scope(d)).revision==9007199254740990LL,
          "last-valid revision became unreadable");
    check(normalize_physical_hierarchy_proposal(scope(d),
        proposal(exhausted,{RenameArea{find(d.structure->areas,"spare"),"Changed"}})).expected_revision==9007199254740990LL,
        "pure domain incorrectly imposed storage write headroom");
}
} // namespace

int main() {
    const std::vector<std::pair<const char *,std::function<void()>>> cases{
        {"projection privacy and independent paths",projection_privacy},
        {"eleven operations and full typed preservation",all_eleven_and_preservation},
        {"null versus declared placement and explicit roles",placement_declaration_and_role},
        {"original values and no-ops",original_values_and_noops},
        {"final references and empty retirement",final_references_and_retirement},
        {"hidden target privacy oracles",hidden_target_oracles},
        {"effective classification policy",effective_classification_policy},
        {"complete affected closure and typed identities",complete_affected_and_kind_identity},
        {"final graph constraints",graph_rules},
        {"strict request and byte budgets",request_validation},
        {"area asset and combined depth boundaries",depth_limits},
        {"complete catalog and asset budgets",catalog_and_asset_budgets},
        {"saved schema and integrity",saved_schema_and_integrity},
    };
    int passed=0;
    for(const auto &[name,run]:cases) {
        const auto before=failures;
        try {run();} catch(const std::exception &) {check(false,"unexpected pure physical test exception");}
        if(failures==before) {++passed;std::cout<<"PASS "<<name<<'\n';}
        else std::cout<<"FAIL "<<name<<'\n';
    }
    std::cout<<"Physical hierarchy domain: "<<passed<<'/'<<cases.size()<<" cases passed; "<<checks
             <<" behavioral checks; "<<failures<<" failures; 0 skipped.\n";
    return failures==0?0:1;
}
