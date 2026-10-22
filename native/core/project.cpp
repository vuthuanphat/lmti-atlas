#include "lmti/project.hpp"
#include <algorithm>
#include <cctype>
#include <chrono>
#include <set>
#include <unordered_map>
#include <unordered_set>

namespace lmti {
namespace {
void text(const std::string &value, std::size_t limit, bool required = false) {
    if ((required && value.empty()) || value.size() > limit || !valid_metadata_utf8(value) ||
        secret_like(value) ||
        std::any_of(value.begin(), value.end(), [](unsigned char c) { return c < 32 || c == 127; }))
        throw Error("Invalid or sensitive project metadata; use nonsecret text within field limits.");
}
template <class T>
std::set<std::string> identities(const std::vector<T> &rows, std::size_t limit = max_project_records) {
    if (rows.size() > limit)
        throw Error("Project record limit exceeded.");
    std::set<std::string> ids;
    for (const auto &r : rows) {
        validate_id(r.id);
        if (!ids.insert(r.id).second || (r.privacy != Privacy::Internal && r.privacy != Privacy::Public))
            throw Error("Duplicate identity or invalid classification.");
    }
    return ids;
}
void reference(const std::set<std::string> &ids, const std::string &id, bool required = false) {
    if ((!id.empty() && !ids.contains(id)) || (required && id.empty()))
        throw Error("Reference is unavailable in this project.");
}
template <class T> const T &lookup(const std::vector<T> &rows, const std::string &id) {
    auto it = std::find_if(rows.begin(), rows.end(), [&](const auto &r) { return r.id == id; });
    if (it == rows.end())
        throw Error("Object is unavailable in this project.");
    return *it;
}
template <class E> E parse(const std::string &value, std::initializer_list<E> values) {
    for (auto e : values)
        if (name(e) == value)
            return e;
    throw Error("Invalid project enum value.");
}
using StructureIndex = std::unordered_map<std::string, std::size_t>;
constexpr auto no_parent = static_cast<std::size_t>(-1);
template <class T> StructureIndex structure_index(const std::vector<T> &rows, std::size_t limit) {
    if (rows.size() > limit)
        throw Error("Project structure exceeds record limits.");
    StructureIndex result;
    result.reserve(rows.size());
    for (std::size_t i = 0; i < rows.size(); ++i) {
        validate_id(rows[i].id);
        if (!result.emplace(rows[i].id, i).second)
            throw Error("Duplicate project structure identity.");
    }
    return result;
}
template <class T> StructureIndex structure_catalog(const std::vector<T> &rows) {
    auto index = structure_index(rows, max_project_records);
    for (const auto &row : rows) {
        text(row.label, 120, true);
        if (row.privacy != Privacy::Public && row.privacy != Privacy::Internal)
            throw Error("Invalid project structure classification.");
    }
    return index;
}
std::size_t structure_reference(const StructureIndex &index, const std::string &id, bool optional = false) {
    if (optional && id.empty())
        return no_parent;
    const auto found = index.find(id);
    if (found == index.end())
        throw Error("Project structure reference is unavailable.");
    return found->second;
}
// Parent indexes are already validated. Every vertex is visited and unwound
// once; no recursive stack or repeated ancestor walk is used.
std::vector<std::size_t> structure_depths(const std::vector<std::size_t> &parents,
                                        const std::vector<std::size_t> &root_depths) {
    std::vector<unsigned char> state(parents.size(), 0);
    std::vector<std::size_t> depths(parents.size(), 0), path;
    path.reserve(parents.size());
    for (std::size_t start = 0; start < parents.size(); ++start) {
        auto current = start;
        while (current != no_parent && state[current] == 0) {
            state[current] = 1;
            path.push_back(current);
            current = parents[current];
        }
        if (current != no_parent && state[current] == 1)
            throw Error("Project containment cannot contain a cycle.");
        while (!path.empty()) {
            const auto node = path.back();
            path.pop_back();
            depths[node] = parents[node] == no_parent ? root_depths[node] : depths[parents[node]] + 1;
            if (depths[node] > max_structure_depth)
                throw Error("Project containment exceeds depth limits.");
            state[node] = 2;
        }
    }
    return depths;
}
void validate_structure(const ProjectDocument &document) {
    if (!document.structure)
        return;
    const auto &structure = *document.structure;
    const auto subsystems = structure_catalog(structure.subsystems), sites = structure_catalog(structure.sites),
               areas = structure_catalog(structure.areas), environments = structure_catalog(structure.environments),
               components = structure_index(document.components, max_project_records),
               assets = structure_index(document.topology.assets, max_assets);
    std::vector<std::size_t> parents(structure.subsystems.size(), no_parent);
    for (std::size_t i = 0; i < structure.subsystems.size(); ++i)
        parents[i] = structure_reference(subsystems, structure.subsystems[i].parent_subsystem_id, true);
    const auto subsystem_depths = structure_depths(parents, std::vector<std::size_t>(parents.size(), 1));
    if (structure.component_memberships.size() > max_project_records)
        throw Error("Project structure exceeds record limits.");
    std::unordered_set<std::string> assigned_components;
    for (const auto &row : structure.component_memberships) {
        structure_reference(components, row.component_id);
        const auto parent = structure_reference(subsystems, row.subsystem_id);
        if (!assigned_components.insert(row.component_id).second)
            throw Error("A component can have only one subsystem parent.");
        if (subsystem_depths[parent] + 1 > max_structure_depth)
            throw Error("Project containment exceeds depth limits.");
    }
    // A declared structure names every existing asset site. No site is inferred
    // or created by validation, including for an asset with unknown placement.
    for (const auto &asset : document.topology.assets)
        structure_reference(sites, asset.site);
    parents.assign(structure.areas.size(), no_parent);
    for (std::size_t i = 0; i < structure.areas.size(); ++i) {
        const auto &row = structure.areas[i];
        structure_reference(sites, row.site_id);
        parents[i] = structure_reference(areas, row.parent_area_id, true);
        if (parents[i] != no_parent && structure.areas[parents[i]].site_id != row.site_id)
            throw Error("Area containment must remain within one site.");
    }
    const auto area_depths = structure_depths(parents, std::vector<std::size_t>(parents.size(), 1));
    if (structure.asset_placements.size() > max_assets)
        throw Error("Project structure exceeds record limits.");
    StructureIndex placements;
    placements.reserve(structure.asset_placements.size());
    for (std::size_t i = 0; i < structure.asset_placements.size(); ++i) {
        const auto &row = structure.asset_placements[i];
        structure_reference(assets, row.asset_id);
        if (!placements.emplace(row.asset_id, i).second)
            throw Error("An asset can have only one physical placement.");
    }
    parents.assign(structure.asset_placements.size(), no_parent);
    std::vector<std::size_t> root_depths(parents.size(), 1);
    for (std::size_t i = 0; i < structure.asset_placements.size(); ++i) {
        const auto &row = structure.asset_placements[i];
        const auto &asset = document.topology.assets[structure_reference(assets, row.asset_id)];
        const auto area = structure_reference(areas, row.area_id, true);
        structure_reference(environments, row.environment_id, true);
        if (row.role)
            name(*row.role);
        if (area != no_parent) {
            if (structure.areas[area].site_id != asset.site)
                throw Error("Asset placement must remain within its declared site.");
            root_depths[i] = area_depths[area] + 1;
        }
        parents[i] = structure_reference(placements, row.parent_asset_id, true);
        if (parents[i] != no_parent) {
            const auto &parent = structure.asset_placements[parents[i]];
            const auto &parent_asset = document.topology.assets[structure_reference(assets, parent.asset_id)];
            if (parent_asset.site != asset.site || parent.area_id != row.area_id ||
                parent.environment_id != row.environment_id)
                throw Error("Asset containment must share its parent's site, area and environment.");
        }
    }
    structure_depths(parents, root_depths);
}
} // namespace
std::string name(ComponentKind v) {
    switch (v) {
    case ComponentKind::Firmware:
        return "firmware";
    case ComponentKind::Gateway:
        return "gateway";
    case ComponentKind::Backend:
        return "backend";
    case ComponentKind::Desktop:
        return "desktop";
    case ComponentKind::Driver:
        return "driver";
    case ComponentKind::Library:
        return "library";
    }
    throw Error("Invalid component kind.");
}
std::string name(PhysicalRole value) {
    switch (value) {
    case PhysicalRole::Host:
        return "host";
    case PhysicalRole::Gateway:
        return "gateway";
    case PhysicalRole::Device:
        return "device";
    }
    throw Error("Invalid physical role.");
}
PhysicalRole physical_role(const std::string &value) {
    return parse(value, {PhysicalRole::Host, PhysicalRole::Gateway, PhysicalRole::Device});
}
std::string name(WorkKind v) {
    switch (v) {
    case WorkKind::Task:
        return "task";
    case WorkKind::Bug:
        return "bug";
    case WorkKind::Integration:
        return "integration";
    case WorkKind::Validation:
        return "validation";
    }
    throw Error("Invalid work kind.");
}
std::string name(WorkState v) {
    switch (v) {
    case WorkState::Todo:
        return "todo";
    case WorkState::InProgress:
        return "in-progress";
    case WorkState::Review:
        return "review";
    case WorkState::Done:
        return "done";
    case WorkState::Blocked:
        return "blocked";
    }
    throw Error("Invalid work state.");
}
std::string name(ReleaseState v) {
    switch (v) {
    case ReleaseState::Draft:
        return "draft";
    case ReleaseState::Candidate:
        return "candidate";
    case ReleaseState::Approved:
        return "approved";
    case ReleaseState::Archived:
        return "archived";
    }
    throw Error("Invalid release state.");
}
std::string name(EvidenceResult v) {
    switch (v) {
    case EvidenceResult::OperatorDeclared:
        return "operator-declared";
    case EvidenceResult::Passed:
        return "passed";
    case EvidenceResult::Failed:
        return "failed";
    }
    throw Error("Invalid evidence result.");
}
ComponentKind component_kind(const std::string &v) {
    return parse(v, {ComponentKind::Firmware, ComponentKind::Gateway, ComponentKind::Backend,
                     ComponentKind::Desktop, ComponentKind::Driver, ComponentKind::Library});
}
WorkKind work_kind(const std::string &v) {
    return parse(v, {WorkKind::Task, WorkKind::Bug, WorkKind::Integration, WorkKind::Validation});
}
WorkState work_state(const std::string &v) {
    return parse(
        v, {WorkState::Todo, WorkState::InProgress, WorkState::Review, WorkState::Done, WorkState::Blocked});
}
ReleaseState release_state(const std::string &v) {
    return parse(
        v, {ReleaseState::Draft, ReleaseState::Candidate, ReleaseState::Approved, ReleaseState::Archived});
}
EvidenceResult evidence_result(const std::string &v) {
    return parse(v, {EvidenceResult::OperatorDeclared, EvidenceResult::Passed, EvidenceResult::Failed});
}
void validate_project_info(const ProjectInfo &project) {
    validate_id(project.id);
    text(project.label, 120, true);
    text(project.goal, 512);
    if (project.privacy != Privacy::Public && project.privacy != Privacy::Internal)
        throw Error("Invalid project classification.");
}
void validate(const ProjectDocument &d) {
    validate(d.topology);
    validate_project_info(d.project);
    const auto repos = identities(d.repositories), components = identities(d.components),
               targets = identities(d.targets), releases = identities(d.releases),
               assets = identities(d.topology.assets, max_assets), milestones = identities(d.milestones);
    identities(d.bindings);
    identities(d.dependencies);
    identities(d.verification);
    identities(d.work);
    identities(d.knowledge);
    validate_structure(d);
    for (const auto &r : d.repositories) {
        text(r.label, 120, true);
        text(r.locator, 512);
        if (r.locator.find("://") != std::string::npos &&
            (r.locator.find('@') != std::string::npos || r.locator.find('?') != std::string::npos ||
             r.locator.find('#') != std::string::npos ||
             !(r.locator.starts_with("https://") || r.locator.starts_with("ssh://"))))
            throw Error("Repository URLs must use HTTPS/SSH without credentials, query or fragment.");
    }
    for (const auto &r : d.components) {
        text(r.label, 120, true);
        name(r.kind);
        reference(repos, r.repository_id);
    }
    for (const auto &r : d.targets) {
        text(r.label, 120, true);
        text(r.hardware_revision, 64);
        text(r.architecture, 64);
    }
    for (const auto &r : d.releases) {
        text(r.label, 64, true);
        text(r.source_revision, 128);
        name(r.state);
        reference(components, r.component_id, true);
        reference(targets, r.target_id);
    }
    std::set<std::pair<std::string, std::string>> pairs;
    for (const auto &r : d.bindings) {
        reference(assets, r.asset_id, true);
        reference(components, r.component_id, true);
        reference(releases, r.release_id, true);
        reference(targets, r.target_id);
        const auto &release = lookup(d.releases, r.release_id);
        if (release.component_id != r.component_id || release.target_id != r.target_id ||
            !pairs.insert({r.asset_id, r.component_id}).second)
            throw Error(
                "Binding must match its release component/target and be unique per device/component.");
    }
    for (const auto &r : d.dependencies) {
        reference(components, r.from, true);
        reference(components, r.to, true);
        text(r.contract, 120, true);
        if (r.from == r.to)
            throw Error("A component cannot depend on itself.");
    }
    for (const auto &r : d.verification) {
        reference(releases, r.release_id, true);
        reference(assets, r.asset_id);
        text(r.source, 120, true);
        text(r.evidence, 512, true);
        name(r.result);
        if (r.at <= 0 || r.at > 253402300799LL)
            throw Error("Verification requires a valid timestamp.");
    }
    for (const auto &r : d.milestones) {
        text(r.label, 120, true);
        text(r.criteria, 512, true);
        text(r.due_date, 10);
        text(r.evidence, 512, r.accepted);
        if (!r.due_date.empty() && (r.due_date.size() != 10 || r.due_date[4] != '-' || r.due_date[7] != '-'))
            throw Error("Use YYYY-MM-DD for milestone date.");
        if (!r.due_date.empty()) {
            for (std::size_t i = 0; i < r.due_date.size(); ++i)
                if (i != 4 && i != 7 && (r.due_date[i] < '0' || r.due_date[i] > '9'))
                    throw Error("Invalid milestone date.");
            auto year = std::stoi(r.due_date.substr(0, 4)), month = std::stoi(r.due_date.substr(5, 2)),
                 day = std::stoi(r.due_date.substr(8, 2));
            if (year < 1 || !std::chrono::year_month_day(std::chrono::year(year), std::chrono::month(month),
                                                         std::chrono::day(day))
                                 .ok())
                throw Error("Invalid milestone calendar date.");
        }
    }
    for (const auto &r : d.work) {
        text(r.label, 120, true);
        text(r.checklist, 512);
        text(r.evidence, 512);
        name(r.kind);
        name(r.state);
        reference(components, r.component_id);
        reference(assets, r.asset_id);
        reference(releases, r.release_id);
        reference(milestones, r.milestone_id);
        if (!r.release_id.empty() && lookup(d.releases, r.release_id).component_id != r.component_id)
            throw Error("Work release must belong to its linked component.");
        if (r.state == WorkState::Done &&
            (r.checklist.empty() || (r.kind == WorkKind::Validation && r.evidence.empty())))
            throw Error("Done needs a completed checklist; validation work also needs evidence.");
    }
    for (const auto &r : d.knowledge) {
        text(r.label, 120, true);
        text(r.reference, 256, true);
        text(r.fingerprint, 128, true);
        reference(components, r.component_id);
    }
    for (const auto &m : d.milestones)
        if (m.accepted) {
            std::size_t tasks = 0;
            for (const auto &w : d.work)
                if (w.milestone_id == m.id) {
                    ++tasks;
                    if (w.state != WorkState::Done)
                        throw Error("Reopen milestone acceptance before changing unfinished work.");
                }
            if (tasks == 0)
                throw Error("Milestone acceptance requires completed work and operator evidence.");
        }
}
ProjectDocument apply_proposal(const ProjectDocument &d, const WorkProposal &p) {
    if (d.structure)
        throw Error("Project structure is unavailable through this legacy proposal boundary.");
    if (p.project_id != d.project.id || p.revision != d.topology.revision || p.revision < 1)
        throw Error("Proposal project or saved revision mismatch.");
    auto next = d;
    auto it = std::find_if(next.work.begin(), next.work.end(), [&](auto &w) { return w.id == p.work_id; });
    if (it == next.work.end() || it->state != p.expected)
        throw Error("Proposal old value does not match this project.");
    // An Agent may request review or flag a blocker, never claim completion.
    if (p.desired != WorkState::Review && p.desired != WorkState::Blocked)
        throw Error("Agent proposals may only request review or mark work blocked.");
    it->state = p.desired;
    validate(next);
    return next;
}
void validate_update(const ProjectDocument &before, const ProjectDocument &after) {
    validate(after);
    if (before.project.id != after.project.id)
        throw Error("Project identity cannot change during an update.");
    if (before.structure && !after.structure)
        throw Error("Declared project structure cannot be silently removed.");
    for (const auto &old : before.releases)
        if (old.state == ReleaseState::Approved) {
            auto it = std::find_if(after.releases.begin(), after.releases.end(),
                                   [&](auto &r) { return r.id == old.id; });
            if (it == after.releases.end() || *it != old)
                throw Error("Approved release metadata is immutable; create a new release.");
        }
}
ProjectDocument demo_project() {
    ProjectDocument d;
    d.project = {"factory-monitor", "Factory Monitor",
                 "Synthetic demo: sensor firmware, gateway and monitoring backend.", Privacy::Public};
    d.topology = demo_topology();
    d.repositories = {{"repo-sensor", "Sensor repository", "", Privacy::Public},
                      {"repo-gateway", "Gateway repository", "", Privacy::Public}};
    d.components = {
        {"sensor-firmware", "Sensor firmware", "repo-sensor", ComponentKind::Firmware, Privacy::Public},
        {"gateway-agent", "Gateway agent", "repo-gateway", ComponentKind::Gateway, Privacy::Public},
        {"monitor-backend", "Monitor backend", "", ComponentKind::Backend, Privacy::Public}};
    d.targets = {{"board-b", "Sensor board", "rev B", "MCU (declared)", Privacy::Public}};
    d.releases = {{"sensor-v020", "0.2.0", "sensor-firmware", "board-b", "demo-revision",
                   ReleaseState::Candidate, Privacy::Public}};
    d.bindings = {
        {"sensor-binding", "machine-a", "sensor-firmware", "sensor-v020", "board-b", Privacy::Public}};
    d.dependencies = {
        {"sensor-gateway", "sensor-firmware", "gateway-agent", "sensor-v1", Privacy::Public},
        {"gateway-backend", "gateway-agent", "monitor-backend", "mqtt sensor-v1", Privacy::Public}};
    d.milestones = {
        {"local-demo", "Local demo", "Validate sampling and gateway data contract", "", Privacy::Public}};
    d.work = {{"validate-sampling", "Validate sampling", "sensor-firmware", "machine-a", "sensor-v020",
               "local-demo", "Sampling interval and data quality", "", WorkKind::Validation, WorkState::Todo,
               Privacy::Public},
              {"gateway-contract", "Validate gateway data contract", "gateway-agent", "gateway-b", "",
               "local-demo", "Check sensor-v1 messages", "", WorkKind::Integration, WorkState::Blocked,
               Privacy::Public}};
    validate(d);
    return d;
}
} // namespace lmti
