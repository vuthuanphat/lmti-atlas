#pragma once
#include <cstdint>
#include <stdexcept>
#include <string>
#include <vector>

namespace lmti {
inline constexpr std::size_t max_assets = 10000;
inline constexpr std::size_t max_links = 50000;
enum class Kind { Machine, Gateway, Broker, Service, Sensor };
enum class Privacy { Internal, Public };
enum class Observation { Unknown, Online, Offline };
enum class Protocol { Dependency, Mqtt, OpcUa, ModbusTcp };

struct Asset {
    std::string id, label, site;
    Kind kind = Kind::Machine;
    Privacy privacy = Privacy::Internal;
    bool enabled = true;
    int poll_ms = 1000;
    Observation observed = Observation::Unknown;
    std::int64_t observed_at = 0; // UTC epoch seconds; 0 means no observation.
    double x = 0, y = 0;
    bool operator==(const Asset &) const = default;
};
struct Link {
    std::string id, from, to;
    Protocol protocol = Protocol::Dependency;
    bool operator==(const Link &) const = default;
};
struct Topology {
    std::int64_t revision = 0; // Changes only after a successful database commit.
    std::vector<Asset> assets;
    std::vector<Link> links;
    bool operator==(const Topology &) const = default;
};
struct ConfigProposal {
    std::int64_t base_revision = 0;
    std::string asset_id, site;
    bool expected_enabled = true, desired_enabled = true;
    int expected_poll_ms = 1000, desired_poll_ms = 1000;
};
class Error : public std::runtime_error {
  public:
    using std::runtime_error::runtime_error;
};
void validate_id(const std::string &value);
void validate(const Topology &topology);
void canonicalize(Topology &topology);
bool secret_like(const std::string &text);
bool valid_metadata_utf8(const std::string &text);
const Asset &find_asset(const Topology &topology, const std::string &id);
Topology apply_proposal(const Topology &topology, const ConfigProposal &proposal);
Topology demo_topology();
std::string name(Kind value);
std::string name(Privacy value);
std::string name(Observation value);
std::string name(Protocol value);
Kind parse_kind(const std::string &value);
Privacy parse_privacy(const std::string &value);
Observation parse_observation(const std::string &value);
Protocol parse_protocol(const std::string &value);
} // namespace lmti
