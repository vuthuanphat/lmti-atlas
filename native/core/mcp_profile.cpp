#include "lmti/mcp_profile.hpp"
#include <regex>
#include <set>

namespace lmti {
void validate(const McpProfile &profile) {
    validate_id(profile.project_id);
    if (profile.revision < 0 || profile.revision > 9007199254740991LL || profile.servers.size() > 32)
        throw Error("MCP profile exceeds revision or server limits.");
    std::set<std::string> ids;
    const std::regex key("[a-z][a-z0-9_-]{0,47}");
    for (const auto &server : profile.servers) {
        if (!std::regex_match(server.id, key) || secret_like(server.id) || !ids.insert(server.id).second ||
            server.label.empty() || server.label.size() > 120 ||
            !valid_metadata_utf8(server.label) || secret_like(server.label))
            throw Error("Use a unique lowercase server key and nonsecret label.");
        if (server.transport == McpTransport::RemoteHttps) {
            if (server.endpoint.size() > 512 || !valid_metadata_utf8(server.endpoint) ||
                secret_like(server.endpoint) || !server.endpoint.starts_with("https://") ||
                server.endpoint.find_first_of("?#@\\ \"<>{}") != std::string::npos ||
                !server.site.empty() ||
                server.auth != McpAuth::ClientOAuth)
                throw Error("Use a nonsecret HTTPS MCP URL without credentials, query or fragment.");
        } else if (server.transport == McpTransport::LmtiLocal) {
            if (!server.endpoint.empty() || server.site.empty() || server.site.size() > 64 ||
                !valid_metadata_utf8(server.site) || secret_like(server.site) ||
                server.auth != McpAuth::None || server.private_endpoint)
                throw Error("Local LMTI needs a nonsecret site and no remote authentication.");
        } else
            throw Error("Unsupported MCP transport.");
    }
}
} // namespace lmti
