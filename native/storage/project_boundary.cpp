#include "lmti/project_store.hpp"
#include "project_projection_p.hpp"
#include "lmti/storage.hpp"
#include <QJsonArray>
#include <QJsonDocument>
#include <QCryptographicHash>
#include <algorithm>
#include <cmath>
#include <map>
#include <set>

namespace lmti {
namespace {
QString s(const std::string &v) {
    return QString::fromStdString(v);
}
bool visible(Privacy p, const ProjectScope &scope) {
    return !scope.external || p == Privacy::Public;
}
bool allowed(const std::set<std::string> &ids, const std::string &id) {
    return id.empty() || ids.contains(id);
}
QJsonObject identity(const std::string &id, const std::string &label) {
    return {{"id", s(id)}, {"label", s(label)}};
}
} // namespace
QJsonObject detail::project_snapshot_records(const ProjectDocument &d, const ProjectScope &scope, bool include_references) {
    validate_id(scope.project_id);
    validate_id(scope.site);
    if (scope.project_id != d.project.id || !visible(d.project.privacy, scope) || d.topology.revision < 1 ||
        d.topology.revision > 9007199254740991LL)
        throw Error("Project is unavailable in the authorized scope.");

    QJsonObject result{{"schema", include_references ? "lmti.project.snapshot.v2" : "lmti.project.snapshot.v1"},
                       {"projectId", s(d.project.id)},
                       {"revision", d.topology.revision},
                       {"site", s(scope.site)},
                       {"external", scope.external},
                       {"complete", true},
                       {"semantics", "declared"}};
    for (const auto *key : {"components", "assets", "releases", "bindings", "dependencies", "connections"})
        result[key] = QJsonArray{};
    if (include_references) {
        result["repositories"] = QJsonArray{};
        result["knowledge"] = QJsonArray{};
    }
    constexpr qsizetype max_bytes = 4 * 1024 * 1024;
    auto byte_count = QJsonDocument(result).toJson(QJsonDocument::Compact).size();
    auto append = [&](QJsonArray &rows, const QJsonObject &row) {
        byte_count += QJsonDocument(row).toJson(QJsonDocument::Compact).size() + (rows.isEmpty() ? 0 : 1);
        if (byte_count > max_bytes)
            throw Error("Project snapshot exceeds byte budget; no partial snapshot is available.");
        rows.append(row);
    };
    auto inherited = [](Privacy a, Privacy b) {
        return a == Privacy::Public && b == Privacy::Public ? Privacy::Public : Privacy::Internal;
    };
    using Classifications = std::map<std::string, Privacy>;
    Classifications repos, targets, components, assets, releases;
    auto parent_allowed = [](const Classifications &rows, const std::string &id) {
        return id.empty() || rows.contains(id);
    };
    auto parent_privacy = [](const Classifications &rows, const std::string &id) {
        return id.empty() ? Privacy::Public : rows.at(id);
    };
    QJsonArray repository_rows, knowledge_rows;
    auto fingerprint = [](const QString &value) {
        return QString::fromLatin1(QCryptographicHash::hash(value.toUtf8(), QCryptographicHash::Sha256).toHex());
    };
    for (const auto &r : d.repositories)
        if (visible(r.privacy, scope)) {
            repos.emplace(r.id, inherited(r.privacy, d.project.privacy));
            if (include_references)
                append(repository_rows, {{"id", s(r.id)}, {"label", s(r.label)},
                                         {"privacy", s(name(repos.at(r.id)))},
                                         {"locatorFingerprint", fingerprint(s(r.locator))}});
        }
    for (const auto &r : d.targets)
        if (visible(r.privacy, scope))
            targets.emplace(r.id, inherited(r.privacy, d.project.privacy));

    QJsonArray component_rows, asset_rows, release_rows, binding_rows, dependency_rows, connection_rows;
    for (const auto &r : d.components)
        if (visible(r.privacy, scope) && parent_allowed(repos, r.repository_id)) {
            const auto privacy =
                inherited(inherited(r.privacy, d.project.privacy), parent_privacy(repos, r.repository_id));
            QJsonObject row{{"id", s(r.id)}, {"label", s(r.label)},
                            {"kind", s(name(r.kind))}, {"privacy", s(name(privacy))}};
            if (include_references)
                row["repositoryId"] = s(r.repository_id);
            append(component_rows, row);
            components.emplace(r.id, privacy);
        }
    if (include_references)
        for (const auto &r : d.knowledge)
            if (visible(r.privacy, scope) && parent_allowed(components, r.component_id)) {
                const auto privacy = inherited(inherited(r.privacy, d.project.privacy),
                                               parent_privacy(components, r.component_id));
                // Identity/reference evidence only. This does not fetch a document,
                // export its locator/content or verify its current external revision.
                const auto binding = QJsonDocument(QJsonObject{{"reference", s(r.reference)},
                                                               {"fingerprint", s(r.fingerprint)}})
                                         .toJson(QJsonDocument::Compact);
                append(knowledge_rows, {{"id", s(r.id)}, {"label", s(r.label)},
                                       {"componentId", s(r.component_id)},
                                       {"privacy", s(name(privacy))},
                                       {"referenceFingerprint", QString::fromLatin1(
                                            QCryptographicHash::hash(binding, QCryptographicHash::Sha256).toHex())}});
            }
    for (const auto &r : d.topology.assets)
        if (r.site == scope.site && visible(r.privacy, scope)) {
            const auto privacy = inherited(r.privacy, d.project.privacy);
            append(asset_rows, {{"id", s(r.id)},
                                {"label", s(r.label)},
                                {"kind", s(name(r.kind))},
                                {"site", s(r.site)},
                                {"privacy", s(name(privacy))}});
            assets.emplace(r.id, privacy);
        }
    for (const auto &r : d.releases)
        if (visible(r.privacy, scope) && components.contains(r.component_id) &&
            parent_allowed(targets, r.target_id)) {
            const auto privacy = inherited(inherited(r.privacy, components.at(r.component_id)),
                                           parent_privacy(targets, r.target_id));
            append(release_rows, {{"id", s(r.id)},
                                  {"label", s(r.label)},
                                  {"componentId", s(r.component_id)},
                                  {"state", s(name(r.state))},
                                  {"privacy", s(name(privacy))}});
            releases.emplace(r.id, privacy);
        }
    for (const auto &r : d.bindings)
        if (visible(r.privacy, scope) && assets.contains(r.asset_id) && components.contains(r.component_id) &&
            releases.contains(r.release_id) && parent_allowed(targets, r.target_id)) {
            const auto privacy =
                inherited(inherited(r.privacy, assets.at(r.asset_id)), releases.at(r.release_id));
            append(binding_rows, {{"id", s(r.id)},
                                  {"assetId", s(r.asset_id)},
                                  {"componentId", s(r.component_id)},
                                  {"desiredReleaseId", s(r.release_id)},
                                  {"privacy", s(name(privacy))}});
        }
    for (const auto &r : d.dependencies)
        if (visible(r.privacy, scope) && components.contains(r.from) && components.contains(r.to)) {
            const auto privacy = inherited(inherited(r.privacy, components.at(r.from)), components.at(r.to));
            append(dependency_rows, {{"id", s(r.id)},
                                     {"from", s(r.from)},
                                     {"to", s(r.to)},
                                     {"contract", s(r.contract)},
                                     {"privacy", s(name(privacy))}});
        }
    for (const auto &r : d.topology.links)
        if (assets.contains(r.from) && assets.contains(r.to)) {
            const auto privacy = inherited(assets.at(r.from), assets.at(r.to));
            append(connection_rows, {{"id", s(r.id)},
                                     {"from", s(r.from)},
                                     {"to", s(r.to)},
                                     {"protocol", s(name(r.protocol))},
                                     {"privacy", s(name(privacy))}});
        }
    auto ordered = [](const QJsonArray &rows) {
        std::vector<QJsonObject> values;
        values.reserve(static_cast<std::size_t>(rows.size()));
        for (const auto &row : rows)
            values.push_back(row.toObject());
        std::sort(values.begin(), values.end(),
                  [](const auto &a, const auto &b) { return a["id"].toString() < b["id"].toString(); });
        QJsonArray sorted;
        for (const auto &row : values)
            sorted.append(row);
        return sorted;
    };
    result["components"] = ordered(component_rows);
    result["assets"] = ordered(asset_rows);
    result["releases"] = ordered(release_rows);
    result["bindings"] = ordered(binding_rows);
    result["dependencies"] = ordered(dependency_rows);
    result["connections"] = ordered(connection_rows);
    if (include_references) {
        result["repositories"] = ordered(repository_rows);
        result["knowledge"] = ordered(knowledge_rows);
    }
    if (QJsonDocument(result).toJson(QJsonDocument::Compact).size() > max_bytes)
        throw Error("Project snapshot exceeds byte budget; no partial snapshot is available.");
    return result;
}
QJsonObject project_snapshot(const QString &path, const ProjectScope &scope, bool include_references) {
    validate_id(scope.project_id);
    validate_id(scope.site);
    const auto d = load_project(path);
    if (d.structure)
        throw Error("Project structure is unavailable through this legacy snapshot boundary.");
    return detail::project_snapshot_records(d, scope, include_references);
}
QJsonObject project_context(const ProjectDocument &d, const ProjectScope &scope) {
    if (d.structure)
        throw Error("Project structure is unavailable through this legacy boundary.");
    validate(d);
    validate_id(scope.project_id);
    validate_id(scope.site);
    if (scope.project_id != d.project.id || !visible(d.project.privacy, scope) || scope.limit < 1 ||
        scope.limit > 200)
        throw Error("Project is unavailable in the authorized scope.");
    QJsonObject result{{"schema", "lmti.project.context.v1"},
                       {"projectId", s(d.project.id)},
                       {"revision", d.topology.revision},
                       {"site", s(scope.site)},
                       {"project", QJsonObject{{"label", s(d.project.label)}, {"goal", s(d.project.goal)}}}};
    bool truncated = false;
    auto append = [&](QJsonArray &array, const QJsonObject &value) {
        if (static_cast<std::size_t>(array.size()) < scope.limit) {
            array.append(value);
            return true;
        }
        truncated = true;
        return false;
    };
    std::set<std::string> repos, comps, targets, releases, assets, milestones;
    QJsonArray repo_rows, comp_rows, target_rows, release_rows, asset_rows, binding_rows, dependency_rows,
        milestone_rows, work_rows, verification_rows, knowledge_rows;
    for (const auto &r : d.repositories)
        if (visible(r.privacy, scope) && append(repo_rows, identity(r.id, r.label)))
            repos.insert(r.id); // no locator
    for (const auto &r : d.components)
        if (visible(r.privacy, scope) && allowed(repos, r.repository_id)) {
            auto row = identity(r.id, r.label);
            row["kind"] = s(name(r.kind));
            row["repositoryId"] = s(r.repository_id);
            if (append(comp_rows, row))
                comps.insert(r.id);
        }
    for (const auto &r : d.targets)
        if (visible(r.privacy, scope)) {
            auto row = identity(r.id, r.label);
            row["hardwareRevision"] = s(r.hardware_revision);
            row["architecture"] = s(r.architecture);
            if (append(target_rows, row))
                targets.insert(r.id);
        }
    for (const auto &r : d.releases)
        if (visible(r.privacy, scope) && comps.contains(r.component_id) && allowed(targets, r.target_id)) {
            auto row = identity(r.id, r.label);
            row["componentId"] = s(r.component_id);
            row["targetId"] = s(r.target_id);
            row["state"] = s(name(r.state));
            row["sourceRevision"] = s(r.source_revision);
            if (append(release_rows, row))
                releases.insert(r.id);
        }
    for (const auto &r : d.topology.assets)
        if (r.site == scope.site && visible(r.privacy, scope) && append(asset_rows, asset_json(r)))
            assets.insert(r.id);
    for (const auto &r : d.bindings)
        if (visible(r.privacy, scope) && assets.contains(r.asset_id) && comps.contains(r.component_id) &&
            releases.contains(r.release_id) && allowed(targets, r.target_id))
            append(binding_rows, {{"id", s(r.id)},
                                  {"assetId", s(r.asset_id)},
                                  {"componentId", s(r.component_id)},
                                  {"desiredReleaseId", s(r.release_id)},
                                  {"targetId", s(r.target_id)},
                                  {"observedVersion", "unknown"}});
    for (const auto &r : d.dependencies)
        if (visible(r.privacy, scope) && comps.contains(r.from) && comps.contains(r.to))
            append(dependency_rows,
                   {{"id", s(r.id)}, {"from", s(r.from)}, {"to", s(r.to)}, {"contract", s(r.contract)}});
    for (const auto &r : d.milestones)
        if (visible(r.privacy, scope)) {
            auto row = identity(r.id, r.label);
            row["criteria"] = s(r.criteria);
            row["dueDate"] = s(r.due_date);
            row["acceptance"] = r.accepted ? "operator-accepted" : "pending";
            row["evidence"] = s(r.evidence);
            if (append(milestone_rows, row))
                milestones.insert(r.id);
        }
    for (const auto &r : d.work)
        if (visible(r.privacy, scope) && allowed(comps, r.component_id) && allowed(assets, r.asset_id) &&
            allowed(releases, r.release_id) && allowed(milestones, r.milestone_id)) {
            auto row = identity(r.id, r.label);
            row["componentId"] = s(r.component_id);
            row["assetId"] = s(r.asset_id);
            row["releaseId"] = s(r.release_id);
            row["milestoneId"] = s(r.milestone_id);
            row["kind"] = s(name(r.kind));
            row["state"] = s(name(r.state));
            row["checklist"] = s(r.checklist);
            row["evidence"] = s(r.evidence);
            append(work_rows, row);
        }
    for (const auto &r : d.verification)
        if (visible(r.privacy, scope) && releases.contains(r.release_id) && allowed(assets, r.asset_id))
            append(verification_rows, {{"id", s(r.id)},
                                       {"releaseId", s(r.release_id)},
                                       {"assetId", s(r.asset_id)},
                                       {"result", s(name(r.result))},
                                       {"at", r.at},
                                       {"source", s(r.source)},
                                       {"evidence", s(r.evidence)}});
    // Knowledge links are local references, never raw memory content or raw AMF.
    // A future privacy-reviewed source adapter must authorize any dereference.
    for (const auto &r : d.knowledge)
        if (visible(r.privacy, scope) && allowed(comps, r.component_id)) {
            auto row = identity(r.id, r.label);
            row["componentId"] = s(r.component_id);
            row["fingerprint"] = s(r.fingerprint);
            row["state"] = "reference-only";
            append(knowledge_rows, row);
        }
    result["repositories"] = repo_rows;
    result["components"] = comp_rows;
    result["targets"] = target_rows;
    result["releases"] = release_rows;
    result["assets"] = asset_rows;
    result["bindings"] = binding_rows;
    result["dependencies"] = dependency_rows;
    result["milestones"] = milestone_rows;
    result["work"] = work_rows;
    result["verification"] = verification_rows;
    result["knowledge"] = knowledge_rows;
    result["truncated"] = truncated;
    if (QJsonDocument(result).toJson(QJsonDocument::Compact).size() > 2 * 1024 * 1024)
        throw Error("Project context exceeds byte budget.");
    return result;
}
QJsonObject project_impact(const ProjectDocument &d, const ProjectScope &scope, const std::string &id) {
    if (d.structure)
        throw Error("Project structure is unavailable through this legacy boundary.");
    validate_id(id);
    auto result = project_context(d, scope);
    std::set<std::string> visible_ids, reached{id};
    for (const auto &v : result["components"].toArray())
        visible_ids.insert(v.toObject()["id"].toString().toStdString());
    if (!visible_ids.contains(id))
        throw Error("Component is unavailable within the bounded scope.");
    bool changed = true;
    int depth = 0;
    // Bounded traversal of the already authorized graph; cycles cannot loop forever.
    while (changed && depth++ < 16) {
        changed = false;
        for (const auto &v : result["dependencies"].toArray()) {
            auto row = v.toObject();
            auto from = row["from"].toString().toStdString(), to = row["to"].toString().toStdString();
            if (reached.contains(from))
                changed = reached.insert(to).second || changed;
            if (reached.contains(to))
                changed = reached.insert(from).second || changed;
        }
    }
    if (changed)
        result["truncated"] = true;
    QJsonArray affected;
    for (const auto &component : reached)
        affected.append(s(component));
    result["affectedComponentIds"] = affected;
    result["analysis"] = "Declared dependency neighborhood; not live device impact or permission to deploy.";
    return result;
}
WorkProposal parse_work_proposal(const QJsonObject &o) {
    const std::set<QString> fields{"schema", "projectId",     "revision",
                                   "workId", "expectedState", "desiredState"};
    for (auto it = o.begin(); it != o.end(); ++it)
        if (!fields.contains(it.key()))
            throw Error("Unknown project proposal field.");
    if (o.size() != 6 || o["schema"] != "lmti.project.work-proposal.v1")
        throw Error("Invalid project proposal schema.");
    for (const auto &key : {"projectId", "workId", "expectedState", "desiredState"})
        if (!o[key].isString() || o[key].toString().size() > 64)
            throw Error("Invalid proposal text.");
    auto n = o["revision"].toDouble(-1);
    if (!o["revision"].isDouble() || !std::isfinite(n) || n < 1 || n > 9007199254740991.0 ||
        std::floor(n) != n)
        throw Error("Invalid proposal revision.");
    WorkProposal p{o["projectId"].toString().toStdString(), o["workId"].toString().toStdString(),
                   static_cast<std::int64_t>(n), work_state(o["expectedState"].toString().toStdString()),
                   work_state(o["desiredState"].toString().toStdString())};
    validate_id(p.project_id);
    validate_id(p.work_id);
    if (p.desired != WorkState::Review && p.desired != WorkState::Blocked)
        throw Error("Proposal state is not allowed.");
    return p;
}
QJsonObject work_proposal_json(const WorkProposal &p) {
    return {{"schema", "lmti.project.work-proposal.v1"},
            {"projectId", s(p.project_id)},
            {"revision", p.revision},
            {"workId", s(p.work_id)},
            {"expectedState", s(name(p.expected))},
            {"desiredState", s(name(p.desired))}};
}
} // namespace lmti
