#pragma once
#include "lmti/project_mapping_observation.hpp"
#include <QElapsedTimer>
#include <map>
#include <utility>

namespace lmti::detail {
using MappingIdentityRegistry = std::map<std::pair<std::string, std::string>, bool>;
struct MappingObservationSnapshot {
    ProjectDocument document;
    MappingIdentityRegistry registry;
    QElapsedTimer timer;
    int storage_schema = 0;
};
// Caller owns namespace leases. One connection gates immutable identity then
// captures the complete typed graph and registry. No storage->projection link.
// Returns only after SQLite readers are destroyed; timer continues in projection.
MappingObservationSnapshot read_mapping_observation_on_connection(
    const QString &, const MappingObservationScope &, int expected_schema);
} // namespace lmti::detail
