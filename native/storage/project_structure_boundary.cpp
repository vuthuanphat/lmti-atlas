#include "lmti/project_store.hpp"
#include "project_projection_p.hpp"
#include <QJsonArray>
#include <QJsonDocument>
#include <algorithm>
#include <map>
#include <set>

namespace lmti {
namespace {
QString s(const std::string &value) { return QString::fromStdString(value); }
Privacy inherited(Privacy a, Privacy b) {
    return a == Privacy::Public && b == Privacy::Public ? Privacy::Public : Privacy::Internal;
}
bool visible(Privacy privacy, const ProjectScope &scope) {
    return !scope.external || privacy == Privacy::Public;
}
struct Ancestor {
    std::string parent;
    Privacy privacy;
};
using Classifications = std::map<std::string, Privacy>;

// The typed owner validates references, cycles and depth on load. Keep this
// projection iterative and bounded too, independent of record ordering.
Classifications classifications(const std::map<std::string, Ancestor> &nodes) {
    Classifications result;
    for (const auto &[id, unused] : nodes) {
        std::vector<std::string> path;
        auto current = id;
        while (!current.empty() && !result.contains(current)) {
            const auto node = nodes.find(current);
            if (node == nodes.end() || path.size() >= max_structure_depth ||
                std::find(path.begin(), path.end(), current) != path.end())
                throw Error("Project structure is unavailable.");
            path.push_back(current);
            current = node->second.parent;
        }
        auto privacy = current.empty() ? Privacy::Public : result.at(current);
        for (auto it = path.rbegin(); it != path.rend(); ++it) {
            privacy = inherited(privacy, nodes.at(*it).privacy);
            result.emplace(*it, privacy);
        }
    }
    return result;
}
template <typename Row>
std::vector<const Row *> ordered(const std::vector<Row> &rows) {
    std::vector<const Row *> result;
    result.reserve(rows.size());
    for (const auto &row : rows) result.push_back(&row);
    std::sort(result.begin(), result.end(), [](const auto *a, const auto *b) { return a->id < b->id; });
    return result;
}
} // namespace

QJsonObject project_structure_snapshot(const QString &path, const ProjectScope &scope) {
    validate_id(scope.project_id);
    validate_id(scope.site);
    const auto document = load_project(path);
    if (scope.project_id != document.project.id || !visible(document.project.privacy, scope) ||
        document.topology.revision < 1 || document.topology.revision > 9007199254740991LL)
        throw Error("Project is unavailable in the authorized scope.");

    // Owner-derived records, never a second read or a flattened saved document.
    auto view = document;
    Classifications subsystem_privacy, site_privacy, area_privacy, environment_privacy, asset_privacy;
    std::map<std::string, std::string> memberships;
    std::map<std::string, const AssetPlacement *> placements;
    if (document.structure) {
        const auto &structure = *document.structure;
        std::map<std::string, Ancestor> subsystems, areas, assets;
        for (const auto &row : structure.subsystems)
            subsystems.emplace(row.id, Ancestor{row.parent_subsystem_id,
                inherited(document.project.privacy, row.privacy)});
        subsystem_privacy = classifications(subsystems);
        for (const auto &row : structure.sites)
            site_privacy.emplace(row.id, inherited(document.project.privacy, row.privacy));
        for (const auto &row : structure.areas)
            areas.emplace(row.id, Ancestor{row.parent_area_id, inherited(site_privacy.at(row.site_id), row.privacy)});
        area_privacy = classifications(areas);
        for (const auto &row : structure.environments)
            environment_privacy.emplace(row.id, inherited(document.project.privacy, row.privacy));
        for (const auto &row : structure.component_memberships)
            memberships.emplace(row.component_id, row.subsystem_id);
        for (const auto &row : structure.asset_placements)
            placements.emplace(row.asset_id, &row);
        for (const auto &row : document.topology.assets) {
            auto privacy = inherited(site_privacy.at(row.site), row.privacy);
            std::string parent;
            if (const auto placement = placements.find(row.id); placement != placements.end()) {
                const auto &p = *placement->second;
                if (!p.area_id.empty()) privacy = inherited(privacy, area_privacy.at(p.area_id));
                if (!p.environment_id.empty()) privacy = inherited(privacy, environment_privacy.at(p.environment_id));
                parent = p.parent_asset_id;
            }
            assets.emplace(row.id, Ancestor{parent, privacy});
        }
        asset_privacy = classifications(assets);
        for (auto &row : view.components) {
            row.privacy = inherited(document.project.privacy, row.privacy);
            if (const auto member = memberships.find(row.id); member != memberships.end())
                row.privacy = inherited(row.privacy, subsystem_privacy.at(member->second));
        }
        std::erase_if(view.components, [&](const auto &row) { return !visible(row.privacy, scope); });
        for (auto &row : view.topology.assets) row.privacy = asset_privacy.at(row.id);
        std::erase_if(view.topology.assets, [&](const auto &row) {
            return row.site != scope.site || !visible(row.privacy, scope);
        });
    }

    auto result = detail::project_snapshot_records(view, scope, true);
    result["schema"] = "lmti.project.snapshot.v3";
    result["structureDeclared"] = document.structure.has_value();
    for (const auto *key : {"subsystems", "sites", "areas", "environments"}) result[key] = QJsonArray{};
    auto components = result["components"].toArray();
    for (qsizetype i = 0; i < components.size(); ++i) {
        auto row = components[i].toObject();
        const auto member = memberships.find(row["id"].toString().toStdString());
        row["subsystemId"] = member == memberships.end() ? QString{} : s(member->second);
        components[i] = row;
    }
    result["components"] = components;
    std::set<std::string> used_environments;
    auto assets = result["assets"].toArray();
    for (qsizetype i = 0; i < assets.size(); ++i) {
        auto row = assets[i].toObject();
        const auto placement = placements.find(row["id"].toString().toStdString());
        const auto *p = placement == placements.end() ? nullptr : placement->second;
        row["placementDeclared"] = p != nullptr;
        row["areaId"] = p ? s(p->area_id) : QString{};
        row["parentAssetId"] = p ? s(p->parent_asset_id) : QString{};
        row["environmentId"] = p ? s(p->environment_id) : QString{};
        row["physicalRole"] = p && p->role ? s(name(*p->role)) : QStringLiteral("unknown");
        if (p && !p->environment_id.empty()) used_environments.insert(p->environment_id);
        assets[i] = row;
    }
    result["assets"] = assets;
    constexpr qsizetype max_bytes = 4 * 1024 * 1024;
    auto byte_count = QJsonDocument(result).toJson(QJsonDocument::Compact).size();
    auto append = [&](QJsonArray &rows, const QJsonObject &row) {
        byte_count += QJsonDocument(row).toJson(QJsonDocument::Compact).size() + (rows.isEmpty() ? 0 : 1);
        if (byte_count > max_bytes)
            throw Error("Project snapshot exceeds byte budget; no partial snapshot is available.");
        rows.append(row);
    };
    if (document.structure) {
        const auto &structure = *document.structure;
        QJsonArray subsystems, sites, areas, environments;
        for (const auto *row : ordered(structure.subsystems))
            if (visible(subsystem_privacy.at(row->id), scope))
                append(subsystems, {{"id", s(row->id)}, {"label", s(row->label)},
                    {"parentSubsystemId", s(row->parent_subsystem_id)},
                    {"privacy", s(name(subsystem_privacy.at(row->id)))}});
        // Unknown and denied sites both leave the physical view empty. Logical
        // and reference rows keep their existing project-wide authorization.
        for (const auto *row : ordered(structure.sites))
            if (row->id == scope.site && visible(site_privacy.at(row->id), scope))
                append(sites, {{"id", s(row->id)}, {"label", s(row->label)},
                    {"privacy", s(name(site_privacy.at(row->id)))}});
        for (const auto *row : ordered(structure.areas))
            if (row->site_id == scope.site && visible(area_privacy.at(row->id), scope))
                append(areas, {{"id", s(row->id)}, {"label", s(row->label)}, {"siteId", s(row->site_id)},
                    {"parentAreaId", s(row->parent_area_id)}, {"privacy", s(name(area_privacy.at(row->id)))}});
        for (const auto *row : ordered(structure.environments))
            if (used_environments.contains(row->id) && visible(environment_privacy.at(row->id), scope))
                append(environments, {{"id", s(row->id)}, {"label", s(row->label)},
                    {"privacy", s(name(environment_privacy.at(row->id)))}});
        result["subsystems"] = subsystems;
        result["sites"] = sites;
        result["areas"] = areas;
        result["environments"] = environments;
    }
    if (QJsonDocument(result).toJson(QJsonDocument::Compact).size() > max_bytes)
        throw Error("Project snapshot exceeds byte budget; no partial snapshot is available.");
    return result;
}
} // namespace lmti
