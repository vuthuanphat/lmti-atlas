#pragma once
#include "topology.hpp"
#include <QJsonObject>
#include <QString>
#include <optional>

namespace lmti {
inline constexpr std::size_t max_context_links = 400;
// The caller supplies the trusted site grant; it is never inferred from a model.
struct ReadScope {
    std::string site;
    bool external = true;
    std::size_t limit = 200;
    std::string asset_id;
};
struct ReadResult {
    Topology topology;
    bool truncated = false;
};
Topology load(const QString &path);
ReadResult read_scope(const QString &path, const ReadScope &scope);
// Save is an optimistic, atomic transaction. New files require revision zero.
std::int64_t save(const QString &path, const Topology &topology);
QJsonObject context_json(const ReadResult &result);
QJsonObject asset_json(const Asset &asset);
QJsonObject proposal_json(const ConfigProposal &proposal);
ConfigProposal parse_proposal(const QJsonObject &object);
} // namespace lmti
