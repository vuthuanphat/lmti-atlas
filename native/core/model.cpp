#include "lmti/topology.hpp"
#include <algorithm>
#include <cmath>
#include <regex>
#include <set>
#include <tuple>
#include <unordered_set>

namespace lmti {
namespace {
bool valid_utf8(const std::string &text) {
    for (std::size_t i = 0; i < text.size();) {
        auto c = static_cast<unsigned char>(text[i++]);
        if (c < 0x80) {
            if (c < 0x20 || c == 0x7f)
                return false;
            continue;
        }
        int remaining;
        std::uint32_t code;
        if (c >= 0xc2 && c <= 0xdf) {
            remaining = 1;
            code = c & 0x1f;
        } else if (c >= 0xe0 && c <= 0xef) {
            remaining = 2;
            code = c & 0x0f;
        } else if (c >= 0xf0 && c <= 0xf4) {
            remaining = 3;
            code = c & 7;
        } else
            return false;
        const int count = remaining;
        while (remaining--) {
            if (i == text.size())
                return false;
            c = static_cast<unsigned char>(text[i++]);
            if ((c & 0xc0) != 0x80)
                return false;
            code = (code << 6) | (c & 0x3f);
        }
        if ((count == 2 && code < 0x800) || (count == 3 && code < 0x10000) || code > 0x10ffff ||
            (code >= 0xd800 && code <= 0xdfff) || (code >= 0x80 && code <= 0x9f))
            return false;
    }
    return true;
}
} // namespace
bool valid_metadata_utf8(const std::string &text) {
    return valid_utf8(text);
}
void validate_id(const std::string &value) {
    if (value.empty() || value.size() > 64 ||
        !((value[0] >= 'A' && value[0] <= 'Z') || (value[0] >= 'a' && value[0] <= 'z')))
        throw Error(
            "Identifier must start with a letter and contain 1-64 ASCII letters, digits, '.', '_' or '-'.");
    for (char c : value)
        if (!((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '.' ||
              c == '_' || c == '-'))
            throw Error("Invalid identifier.");
    if (secret_like(value))
        throw Error("Secret-like identifier blocked.");
}
bool secret_like(const std::string &text) {
    // Bounded metadata only. This heuristic is not a substitute for classification.
    if (text.size() > 512)
        return true;
    static const std::regex pattern(
        R"((-----BEGIN .*PRIVATE KEY-----)|(\b(sk-(proj-|ant-)?|gh[pousr]_)[A-Za-z0-9_-]{20,})|(\bAKIA[0-9A-Z]{16})|(\b(api[_-]?key|password|passwd|token|secret|client[_-]?secret)["']?\s*[:=]\s*["']?[^\s"']{8,})|((postgres(ql)?|mysql|mongodb|redis)://))",
        std::regex::icase);
    return std::regex_search(text, pattern);
}
std::string name(Kind v) {
    switch (v) {
    case Kind::Machine:
        return "machine";
    case Kind::Gateway:
        return "gateway";
    case Kind::Broker:
        return "broker";
    case Kind::Service:
        return "service";
    case Kind::Sensor:
        return "sensor";
    }
    throw Error("Invalid asset kind.");
}
std::string name(Privacy v) {
    switch (v) {
    case Privacy::Internal:
        return "internal";
    case Privacy::Public:
        return "public";
    }
    throw Error("Invalid privacy.");
}
std::string name(Observation v) {
    switch (v) {
    case Observation::Unknown:
        return "unknown";
    case Observation::Online:
        return "online";
    case Observation::Offline:
        return "offline";
    }
    throw Error("Invalid observation.");
}
std::string name(Protocol v) {
    switch (v) {
    case Protocol::Dependency:
        return "dependency";
    case Protocol::Mqtt:
        return "mqtt";
    case Protocol::OpcUa:
        return "opcua";
    case Protocol::ModbusTcp:
        return "modbus-tcp";
    }
    throw Error("Invalid protocol.");
}
Kind parse_kind(const std::string &v) {
    for (auto e : {Kind::Machine, Kind::Gateway, Kind::Broker, Kind::Service, Kind::Sensor})
        if (name(e) == v)
            return e;
    throw Error("Invalid asset kind.");
}
Privacy parse_privacy(const std::string &v) {
    for (auto e : {Privacy::Internal, Privacy::Public})
        if (name(e) == v)
            return e;
    throw Error("Invalid privacy.");
}
Observation parse_observation(const std::string &v) {
    for (auto e : {Observation::Unknown, Observation::Online, Observation::Offline})
        if (name(e) == v)
            return e;
    throw Error("Invalid observation.");
}
Protocol parse_protocol(const std::string &v) {
    for (auto e : {Protocol::Dependency, Protocol::Mqtt, Protocol::OpcUa, Protocol::ModbusTcp})
        if (name(e) == v)
            return e;
    throw Error("Invalid protocol.");
}
void validate(const Topology &t) {
    if (t.revision < 0 || t.revision >= 9007199254740991LL || t.assets.size() > max_assets ||
        t.links.size() > max_links)
        throw Error("Topology exceeds schema limits.");
    std::unordered_set<std::string> ids, edge_ids;
    for (const auto &a : t.assets) {
        validate_id(a.id);
        validate_id(a.site);
        if (!ids.insert(a.id).second)
            throw Error("Duplicate asset identifier.");
        if (a.label.empty() || a.label.size() > 120 || !valid_utf8(a.label) ||
            a.label.find_first_not_of(' ') == std::string::npos || secret_like(a.label))
            throw Error("Label must be nonempty UTF-8 metadata without secrets (maximum 120 bytes).");
        name(a.kind);
        name(a.privacy);
        name(a.observed);
        if (a.poll_ms < 100 || a.poll_ms > 3600000 || !std::isfinite(a.x) || !std::isfinite(a.y) ||
            std::abs(a.x) > 100000 || std::abs(a.y) > 100000)
            throw Error("Invalid desired configuration or canvas position.");
        if (a.observed_at < 0 || a.observed_at > 253402300799LL ||
            ((a.observed == Observation::Unknown) != (a.observed_at == 0)))
            throw Error("Observation must have a timestamp, or be unknown with no timestamp.");
    }
    std::set<std::tuple<std::string, std::string, Protocol>> edges;
    for (const auto &l : t.links) {
        validate_id(l.id);
        name(l.protocol);
        if (!edge_ids.insert(l.id).second || !ids.contains(l.from) || !ids.contains(l.to) || l.from == l.to ||
            !edges.emplace(l.from, l.to, l.protocol).second)
            throw Error("Link must have unique identity and valid, distinct endpoints.");
    }
}
const Asset &find_asset(const Topology &t, const std::string &id) {
    const auto it = std::find_if(t.assets.begin(), t.assets.end(), [&](const auto &a) { return a.id == id; });
    if (it == t.assets.end())
        throw Error("Asset not found.");
    return *it;
}
void canonicalize(Topology &t) {
    std::sort(t.assets.begin(), t.assets.end(), [](const auto &a, const auto &b) { return a.id < b.id; });
    std::sort(t.links.begin(), t.links.end(), [](const auto &a, const auto &b) { return a.id < b.id; });
}
Topology apply_proposal(const Topology &t, const ConfigProposal &p) {
    validate(t);
    validate_id(p.asset_id);
    validate_id(p.site);
    const auto &old = find_asset(t, p.asset_id);
    if (t.revision != p.base_revision || old.site != p.site || old.enabled != p.expected_enabled ||
        old.poll_ms != p.expected_poll_ms)
        throw Error("Proposal conflicts with the current saved configuration.");
    auto next = t;
    for (auto &a : next.assets)
        if (a.id == p.asset_id) {
            a.enabled = p.desired_enabled;
            a.poll_ms = p.desired_poll_ms;
        }
    validate(next);
    return next;
}
Topology demo_topology() {
    Topology t;
    t.assets = {{"machine-a", "Assembly machine A", "factory-demo", Kind::Machine, Privacy::Public, true,
                 1000, Observation::Unknown, 0, 80, 120},
                {"gateway-b", "Edge gateway B", "factory-demo", Kind::Gateway, Privacy::Public, true, 1000,
                 Observation::Unknown, 0, 380, 120},
                {"broker-c", "MQTT broker C", "factory-demo", Kind::Broker, Privacy::Public, true, 1000,
                 Observation::Unknown, 0, 680, 120}};
    t.links = {{"link-ab", "machine-a", "gateway-b", Protocol::OpcUa},
               {"link-bc", "gateway-b", "broker-c", Protocol::Mqtt}};
    validate(t);
    return t;
}
} // namespace lmti
