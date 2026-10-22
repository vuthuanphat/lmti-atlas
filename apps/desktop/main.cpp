#include "design_render.hpp"
#include "project_window.hpp"
#include "window.hpp"
#include <QApplication>
#include <QFileInfo>
#include <QMessageBox>
#include <QTemporaryDir>
#include <QTimer>
#include <memory>

int main(int argc, char **argv) {
    QApplication app(argc, argv);
    app.setApplicationName("LMTI Architecture Studio");
    app.setOrganizationName("Cyno Software");
    try {
        auto args = app.arguments();
        QString catalog;
        if (args.size() >= 3 && args[1] == "--data-directory") {
            const auto directory = lmti::checked_project_folder(args[2]);
            catalog = QDir(directory).filePath("projects-catalog.sqlite");
            args.removeAt(1);
            args.removeAt(1);
        }
        if (args.size() == 3 && args[1] == "--legacy") {
            Window legacy;
            try {
                legacy.open_file(args[2]);
            } catch (const std::exception &e) {
                QMessageBox::warning(&legacy, "LMTI", QString::fromUtf8(e.what()));
                return 1;
            }
            legacy.show();
            return app.exec();
        }
        const bool render =
            args.size() >= 3 && (args[1] == "--render-demo" || args[1] == "--render-library" ||
                                 args[1] == "--render-empty-library" || args[1] == "--render-screen");
        std::unique_ptr<QTemporaryDir> fixture;
        if (render) {
            fixture = std::make_unique<QTemporaryDir>();
            if (!fixture->isValid())
                return 1;
        }
        ProjectWindow window(nullptr, render ? fixture->filePath("catalog.sqlite") : catalog);
        if (args.size() >= 4 && args.size() <= 6 && args[1] == "--render-screen") {
            if (args.size() >= 5) {
                if (args[4] != "en" && args[4] != "vi")
                    return 1;
                window.set_language(args[4] == "en");
            }
            if (args.size() == 6) {
                const auto dimensions = args[5].split('x');
                bool width_ok = false, height_ok = false;
                const auto width = dimensions.value(0).toInt(&width_ok);
                const auto height = dimensions.value(1).toInt(&height_ok);
                if (dimensions.size() != 2 || !width_ok || !height_ok || width < 1100 || width > 3840 ||
                    height < 720 || height > 2160)
                    return 1;
                window.resize(width, height);
            }
            if (!render_design_screen(window, args[3], args[2], fixture->path()))
                return 1;
            return app.exec();
        }
        if (args.size() == 2 && args[1] == "--demo") {
            window.load_demo();
        } else if (args.size() == 2) {
            try {
                window.open_project(args[1]);
            } catch (const std::exception &e) {
                QMessageBox::warning(&window, "LMTI", QString::fromUtf8(e.what()));
                return 1;
            }
        }
        if (render && (args[1] == "--render-library" || args[1] == "--render-empty-library") &&
            (args.size() == 3 || args.size() == 4)) {
            if (args[1] == "--render-library") {
                window.create_project_folder(fixture->path(), "SensorFirmware", "Sensor firmware",
                                             "Synthetic example");
                auto first = window.document().project.id;
                window.create_project_folder(fixture->path(), "EdgeGateway", "Edge gateway",
                                             "Synthetic example");
                window.create_project_folder(fixture->path(), "MonitorBackend", "Monitor backend",
                                             "Synthetic example");
                lmti::pin_library_project(window.library_path(), QString::fromStdString(first), true);
            }
            if (args.size() == 4) {
                if (args[3] != "vi")
                    return 1;
                window.set_language(false);
            }
            window.show_library();
            window.show();
            QTimer::singleShot(250, [&] { app.exit(window.grab().save(args[2]) ? 0 : 1); });
            return app.exec();
        }
        if ((args.size() >= 3 && args.size() <= 6) && args[1] == "--render-demo") {
            window.load_demo();
            if (args.size() >= 4) {
                bool ok = false;
                auto index = args[3].toInt(&ok);
                if (!ok || index < 0 || index > static_cast<int>(ProjectPage::Mcp))
                    return 1;
                window.show_page(index);
                if (index == 3)
                    window.findChild<QTabWidget *>("architectureTabs")->setCurrentIndex(1);
            }
            if (args.size() >= 5) {
                if (args[4] != "vi" && args[4] != "en")
                    return 1;
                window.set_language(args[4] == "en");
            }
            if (args.size() == 6) {
                if (args[5] != "details" || args[3] != "1")
                    return 1;
                auto components = window.findChild<QTreeWidget *>("componentTable");
                components->setCurrentItem(components->topLevelItem(0));
            }
            window.show();
            QTimer::singleShot(250, [&] {
                const auto ok = window.grab().save(args[2]);
                app.exit(ok ? 0 : 1);
            });
            return app.exec();
        }
        if (args.size() > 2) {
            QMessageBox::warning(&window, "LMTI", "Usage: lmti-desktop [project.sqlite or topology.sqlite]");
            return 1;
        }
        window.show();
        return app.exec();
    } catch (const std::exception &) {
        QMessageBox::critical(
            nullptr, "LMTI",
            "Unable to start Projects. Check the local package and its writable data folder.");
        return 1;
    }
}
