#pragma once
#include "lmti/topology.hpp"
#include <cstdint>
#include <string>
#include <vector>

namespace lmti {
class McpRevisionConflict : public Error {
  public:
    using Error::Error;
};
enum class McpTransport { RemoteHttps, LmtiLocal };
enum class McpAuth { ClientOAuth, None };
struct McpServer {
    std::string id, label, endpoint, site;
    McpTransport transport = McpTransport::RemoteHttps;
    McpAuth auth = McpAuth::ClientOAuth;
    bool enabled = true, private_endpoint = false;
    bool operator==(const McpServer &) const = default;
};
struct McpProfile {
    std::string project_id;
    std::int64_t revision = 0;
    std::vector<McpServer> servers;
    bool operator==(const McpProfile &) const = default;
};
void validate(const McpProfile &);
} // namespace lmti
