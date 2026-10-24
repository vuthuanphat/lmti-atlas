#include "lmti/project_store.hpp"
#include <QCoreApplication>
#include <QElapsedTimer>
#include <QFileInfo>
#include <QJsonDocument>
#include <QTemporaryDir>
#include <QTextStream>
#include <algorithm>

int main(int argc, char **argv) {
    QCoreApplication app(argc, argv);
    QTemporaryDir temp;
    if (!temp.isValid())
        return 1;
    try {
        lmti::ProjectDocument d;
        d.project = {"benchmark-project", "Synthetic benchmark", "No production performance claim",
                     lmti::Privacy::Public};
        for (int i = 0; i < 100; ++i) {
            auto id = "component-" + std::to_string(i);
            d.components.push_back(
                {id, "Synthetic component", "", lmti::ComponentKind::Library, lmti::Privacy::Public});
            d.releases.push_back({"release-" + std::to_string(i), "0.1.0", id, "", "synthetic",
                                  lmti::ReleaseState::Candidate, lmti::Privacy::Public});
        }
        for (int i = 0; i < 200; ++i) {
            lmti::Asset a;
            a.id = "asset-" + std::to_string(i);
            a.label = "Synthetic device";
            a.site = "demo-site";
            a.privacy = lmti::Privacy::Public;
            d.topology.assets.push_back(a);
        }
        for (int i = 0; i < 500; ++i) {
            auto asset = "asset-" + std::to_string(i % 200),
                 component = "component-" + std::to_string(i / 200),
                 release = "release-" + std::to_string(i / 200);
            d.bindings.push_back(
                {"binding-" + std::to_string(i), asset, component, release, "", lmti::Privacy::Public});
            d.work.push_back({"work-" + std::to_string(i), "Synthetic validation", component, asset, release,
                              "", "Check synthetic metadata", "", lmti::WorkKind::Validation,
                              lmti::WorkState::Todo, lmti::Privacy::Public});
        }
        QElapsedTimer timer;
        timer.start();
        auto path = temp.filePath("benchmark.sqlite");
        d.topology.revision = lmti::save_project(path, d);
        auto save_ms = timer.nsecsElapsed() / 1000000.0;
        timer.restart();
        auto loaded = lmti::load_project(path);
        auto open_ms = timer.nsecsElapsed() / 1000000.0;
        if (loaded != d)
            return 1;
        std::vector<double> times;
        int payload_bytes = 0;
        for (int i = 0; i < 30; ++i) {
            timer.restart();
            auto result = lmti::project_context(loaded, {d.project.id, "demo-site", true, 200});
            auto payload = QJsonDocument(result).toJson(QJsonDocument::Compact);
            payload_bytes = static_cast<int>(payload.size());
            if (!result["truncated"].toBool())
                return 1;
            times.push_back(timer.nsecsElapsed() / 1000000.0);
        }
        std::sort(times.begin(), times.end());
        QJsonObject report{{"fixture", "synthetic"},
                           {"components", 100},
                           {"assets", 200},
                           {"bindings", 500},
                           {"workItems", 500},
                           {"saveMs", save_ms},
                           {"openMs", open_ms},
                           {"contextP95Ms", times[28]},
                           {"contextBytes", payload_bytes},
                           {"databaseBytes", QFileInfo(path).size()},
                           {"samples", 30},
                           {"scope", "native storage/context only; no GUI frame-time or production claim"}};
        QTextStream(stdout) << QJsonDocument(report).toJson(QJsonDocument::Compact) << '\n';
        return 0;
    } catch (const std::exception &e) {
        QTextStream(stderr) << e.what() << '\n';
        return 1;
    }
}
