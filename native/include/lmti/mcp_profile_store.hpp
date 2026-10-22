#pragma once
#include "lmti/mcp_profile.hpp"
#include <QByteArray>
#include <QString>
#include <optional>

namespace lmti {
McpProfile load_mcp_profile(const QString &path, const std::string &project);
std::int64_t save_mcp_profile(const QString &path, const McpProfile &);
enum class McpClient { Codex, Cursor };
class McpIntegrationScopeDenied : public Error { public: using Error::Error; };
class McpIntegrationChanged : public Error { public: using Error::Error; };
struct McpIntegrationBinding {
    QString config_path;
    std::string project_id, site, target;
    QByteArray sha256;
};
struct McpRuntime {
    QString python, entry, binary, database;
    std::optional<McpIntegrationBinding> integration;
};
struct McpGeneration {
    McpClient client;
    QByteArray content, servers_json, fingerprint;
    std::int64_t revision;
};
void validate_mcp_endpoints(const McpProfile &);
McpGeneration generate_mcp_config(const McpProfile &, McpClient, const McpRuntime &);
} // namespace lmti
