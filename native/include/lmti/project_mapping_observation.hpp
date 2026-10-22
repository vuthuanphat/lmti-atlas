#pragma once
#include "project.hpp"
#include <QString>
#include <cstdint>
#include <optional>
#include <string>
#include <vector>

namespace lmti {
inline constexpr std::size_t max_mapping_observation_targets = 4000;
inline constexpr std::size_t max_mapping_observation_bytes = 4 * 1024 * 1024;
enum class MappingObservationKind {
    Component, Asset, Subsystem, Site, Area, Environment, Repository, Knowledge
};
enum class MappingObservationIdentityState { Active, PresentReference };
enum class MappingObservationCode {
    InvalidInput, NativeUnavailable, ConfigChanged, OwnerUnavailable,
    NotSupported, BudgetExceeded
};
class MappingObservationError : public Error {
  public:
    MappingObservationCode code;
    explicit MappingObservationError(MappingObservationCode value)
        : Error("Native mapping observation was refused."), code(value) {}
};
struct MappingObservationScope {
    std::string project_id, store_uuid, site_id, environment_id;
    bool allow_internal = false;
    bool operator==(const MappingObservationScope &) const = default;
};
struct MappingObservationTarget {
    MappingObservationKind kind = MappingObservationKind::Component;
    std::string id;
    bool operator==(const MappingObservationTarget &) const = default;
};
struct MappingObservedTarget {
    MappingObservationTarget target;
    Privacy effective_classification = Privacy::Internal;
    std::string ancestry_fingerprint;
    std::optional<std::string> reference_fingerprint;
    MappingObservationIdentityState identity_state = MappingObservationIdentityState::Active;
    bool operator==(const MappingObservedTarget &) const = default;
};
struct ProjectMappingObservation {
    std::string project_id, store_uuid;
    std::int64_t revision = 0;
    std::vector<MappingObservedTarget> targets;
    int storage_schema = 2; // Actual validated format; appended for source compatibility.
    bool operator==(const ProjectMappingObservation &) const = default;
};
// Pure validation: all request fields, enums and duplicate (kind,id) tuples.
void validate_mapping_observation_request(
    const MappingObservationScope &, const std::vector<MappingObservationTarget> &);
// Fixed launcher path only; schema2 identity precedes graph on one read snapshot.
// Windows invocation namespace leases do not establish a historical inode pin.
ProjectMappingObservation read_project_mapping_observation(
    const QString &fixed_database, const MappingObservationScope &,
    const std::vector<MappingObservationTarget> &);
// Explicit schema3 sibling; no format negotiation or fallback.
ProjectMappingObservation read_project_mapping_observation_v2(
    const QString &fixed_database, const MappingObservationScope &,
    const std::vector<MappingObservationTarget> &);
std::string name(MappingObservationKind);
std::string name(MappingObservationIdentityState);
} // namespace lmti
