#include "lmti/storage.hpp"
#include <QCoreApplication>
#include <QFileInfo>
#include <QJsonDocument>
#include <QTextStream>

int main(int argc, char **argv) {
    QCoreApplication app(argc, argv);
    const auto args = app.arguments();
    try {
        if (args.size() == 3 && args[1] == "init-demo") {
            if (QFileInfo::exists(args[2]))
                throw lmti::Error("Demo initialization never overwrites an existing file.");
            auto t = lmti::demo_topology();
            t.revision = lmti::save(args[2], t);
            QTextStream(stdout) << QJsonDocument(QJsonObject{{"revision", static_cast<qint64>(t.revision)}})
                                       .toJson(QJsonDocument::Compact)
                                << '\n';
            return 0;
        }
        if (args.size() != 6 || (args[1] != "context" && args[1] != "asset") ||
            (args[4] != "local" && args[4] != "external"))
            throw lmti::Error("Usage: lmti-topology init-demo <db> | context <db> <site> <local|external> "
                              "<limit 1-200> | asset <db> <site> <local|external> <asset-id>");
        bool ok = false;
        const auto limit = args[1] == "asset" ? 1 : args[5].toInt(&ok);
        if (args[1] == "context" && (!ok || limit < 1 || limit > 200))
            throw lmti::Error("Invalid context limit.");
        const auto result = lmti::read_scope(
            args[2], {args[3].toStdString(), args[4] == "external", static_cast<std::size_t>(limit),
                      args[1] == "asset" ? args[5].toStdString() : std::string{}});
        const auto bytes = QJsonDocument(lmti::context_json(result)).toJson(QJsonDocument::Compact);
        if (bytes.size() > 2 * 1024 * 1024)
            throw lmti::Error("Context exceeds output limit.");
        QTextStream(stdout) << bytes << '\n';
        return 0;
    } catch (const std::exception &e) {
        QTextStream(stderr) << e.what() << '\n';
        return 1;
    }
}
