#include "lmti/mcp_profile_store.hpp"
#include "lmti/project_store.hpp"
#include "lmti/project_library.hpp"
#include <QCoreApplication>
#include <QFile>
#include <QJsonDocument>
#include <QTemporaryDir>
#include <iostream>
#include <functional>

void require(bool value, const char *message) { if (!value) throw lmti::Error(message); }
void rejected(const std::function<void()> &operation) {
    try { operation(); } catch (const lmti::Error &) { return; }
    throw lmti::Error("Expected rejection.");
}
int main(int argc, char **argv) {
    QCoreApplication app(argc, argv);
    try {
        QTemporaryDir temp;
        const auto path = temp.filePath("profiles.sqlite");
        lmti::McpProfile a{"project-A", 0, {{"cloudflare", "Cloudflare", "https://example.com/mcp", ""}}};
        require(lmti::load_mcp_profile(path, a.project_id) == lmti::McpProfile{a.project_id, 0, {}}, "Initial profile");
        a.revision = lmti::save_mcp_profile(path, a);
        require(a.revision == 1 && lmti::load_mcp_profile(path, a.project_id) == a, "Roundtrip");
        require(lmti::load_mcp_profile(path, "project-B").servers.empty(), "Project isolation");
        auto stale = a; stale.revision = 0;
        rejected([&] { lmti::save_mcp_profile(path, stale); });
        for (const auto &url : {"http://example.com/mcp", "https://user:password@example.com/mcp", "https://example.com/mcp?token=hiddenvalue", "https://169.254.169.254/mcp", "https://example.com:444/mcp", "https://example.com/%0a"}) {
            auto invalid = a; invalid.servers[0].endpoint = url;
            rejected([&] { lmti::save_mcp_profile(path, invalid); });
        }
        auto duplicate = a; duplicate.servers.push_back(a.servers.front());
        rejected([&] { lmti::save_mcp_profile(path, duplicate); });
        auto injection = a; injection.servers[0].id = "server\n[other]";
        rejected([&] { lmti::save_mcp_profile(path, injection); });
        auto secret_key = a; secret_key.servers[0].id = "sk-proj-" + std::string(24, 'x');
        rejected([&] { lmti::save_mcp_profile(path, secret_key); });
        auto unsupported_auth = a; unsupported_auth.servers[0].auth = lmti::McpAuth::None;
        rejected([&] { lmti::generate_mcp_config(unsupported_auth, lmti::McpClient::Codex, {}); });
        require(lmti::load_mcp_profile(path, a.project_id) == a, "Rejected writes must not mutate");
        auto codex = lmti::generate_mcp_config(a, lmti::McpClient::Codex, {});
        auto cursor = lmti::generate_mcp_config(a, lmti::McpClient::Cursor, {});
        require(codex.servers_json == cursor.servers_json && codex.revision == cursor.revision, "Shared source");
        require(codex.content.contains("[mcp_servers.\"cloudflare\"]") && cursor.content.contains("mcpServers"), "Client formats");
        a.servers[0].enabled = false;
        a.revision = lmti::save_mcp_profile(path, a);
        require(lmti::generate_mcp_config(a, lmti::McpClient::Cursor, {}).servers_json == "{}", "Disabled omitted");
        a.servers.push_back({"lmti_context", "LMTI context", "", "factory", lmti::McpTransport::LmtiLocal, lmti::McpAuth::None});
        rejected([&] { lmti::generate_mcp_config(a, lmti::McpClient::Cursor, {}); });
        const auto dummy = temp.filePath("trusted-file");
        QFile file(dummy); require(file.open(QIODevice::WriteOnly), "Fixture file"); file.close();
        auto local = lmti::generate_mcp_config(a, lmti::McpClient::Codex, {dummy, dummy, dummy, dummy});
        require(local.content.contains("--target") && local.content.contains("external") && local.content.contains("-I"), "Scoped launcher");
        if (argc == 2) {
            QDir evidence(QString::fromLocal8Bit(argv[1]));
            require(evidence.exists(), "Create a fresh evidence directory first.");
            auto project = lmti::demo_project();
            const auto database = evidence.filePath("synthetic-project.sqlite");
            require(!QFileInfo::exists(database), "Evidence files must be new.");
            lmti::save_project(database, project);
            lmti::McpProfile fixture{project.project.id, 1, {{"lmti_m1", "LMTI context", "", "factory-demo",
                lmti::McpTransport::LmtiLocal, lmti::McpAuth::None}}};
            fixture.revision = 0;
            fixture.revision = lmti::save_mcp_profile(evidence.filePath("mcp-profiles.sqlite"), fixture);
            lmti::remember_library_project(evidence.filePath("project-library.sqlite"),
                {QString::fromStdString(project.project.id), QString::fromStdString(project.project.label),
                 database, evidence.absolutePath(), false, 0});
            lmti::McpRuntime runtime{qEnvironmentVariable("LMTI_PYTHON_BINARY"), qEnvironmentVariable("LMTI_AGENT_ENTRY"),
                                    qEnvironmentVariable("LMTI_PROJECT_BINARY"), database};
            for (auto client : {lmti::McpClient::Codex, lmti::McpClient::Cursor}) {
                const auto output = lmti::generate_mcp_config(fixture, client, runtime);
                QFile config(evidence.filePath(client == lmti::McpClient::Codex ? "codex.toml" : "cursor.json"));
                require(config.open(QIODevice::WriteOnly | QIODevice::NewOnly), "New config evidence file");
                require(config.write(output.content) == output.content.size(), "Write config evidence");
            }
            require(evidence.mkdir("edge-project"), "Fresh second project folder");
            auto second = lmti::demo_project(); second.project.id = "edge-gateway"; second.project.label = "Edge Gateway";
            const auto second_db = evidence.filePath("edge-project/project.sqlite");
            lmti::save_project(second_db, second);
            lmti::remember_library_project(evidence.filePath("project-library.sqlite"),
                {"edge-gateway", "Edge Gateway", second_db, evidence.filePath("edge-project"), false, 0});
        }
        std::cout << "MCP profile isolation, revisions, validation, generation and local boundary passed\n";
        return 0;
    } catch (const std::exception &error) { std::cerr << error.what() << '\n'; return 1; }
}
