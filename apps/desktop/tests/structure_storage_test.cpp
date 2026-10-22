#include "project_window.hpp"
#include "lmti/project_store.hpp"
#include <QFile>
#include <QFileInfo>
#include <QStandardPaths>
#include <QTemporaryDir>
#include <QtTest>

namespace {
QByteArray bytes(const QString &path) {
    QFile file(path);
    return file.open(QIODevice::ReadOnly) ? file.readAll() : QByteArray{};
}
void add_structure(lmti::ProjectDocument &d) {
    d.structure.emplace();
    d.structure->sites = {{"factory-demo", "Factory", lmti::Privacy::Public}};
    d.structure->subsystems = {{"unused", "Unused subsystem", "", lmti::Privacy::Internal}};
    d.structure->areas = {{"cell", "Cell", "factory-demo", "", lmti::Privacy::Internal}};
    d.structure->asset_placements = {{"machine-a", "cell", "", "", std::nullopt}};
}
}
class StructureStorageTest : public QObject {
    Q_OBJECT
  private slots:
    void initTestCase() { QStandardPaths::setTestModeEnabled(true); }
    void first_save_retirement_and_save_as_keep_lineage() {
        QTemporaryDir temp;
        QVERIFY(temp.isValid());
        const auto path = temp.filePath("structured.sqlite");
        const auto copy = temp.filePath("must-not-create.sqlite");
        ProjectWindow window(nullptr, temp.filePath("catalog.sqlite"));
        window.load_demo();
        window.update_project(add_structure);
        window.save_to(path);
        QVERIFY(window.document().storage_lineage.has_value());
        QCOMPARE(window.document().topology.revision, 1);
        window.update_project([](auto &d) { d.structure->subsystems.clear(); });
        window.save_to(path);
        QCOMPARE(window.document().topology.revision, 2);
        const auto before = bytes(path);
        const auto saved = window.document();
        QVERIFY_THROWS_EXCEPTION(lmti::Error, window.save_to(copy));
        QVERIFY(!QFileInfo::exists(copy));
        QCOMPARE(bytes(path), before);
        QCOMPARE(window.document(), saved);
        QCOMPARE(lmti::load_project(path), saved);
        // A successful save is not followed by readback; owner mutation retained
        // lineage. The retired ID also cannot return through an ordinary Qt edit.
        window.update_project([](auto &d) {
            d.structure->subsystems.push_back({"unused", "Restored draft", "", lmti::Privacy::Internal});
        });
        QVERIFY_THROWS_EXCEPTION(lmti::Error, window.save_to(path));
        QCOMPARE(bytes(path), before);
    }
    void loaded_structure_same_path_edit_is_lossless() {
        QTemporaryDir temp;
        QVERIFY(temp.isValid());
        const auto path = temp.filePath("loaded.sqlite");
        auto d = lmti::demo_project();
        add_structure(d);
        d.topology.revision = lmti::save_project(path, d);
        ProjectWindow window(nullptr, temp.filePath("catalog.sqlite"));
        window.open_project(path);
        QCOMPARE(window.document(), d);
        window.update_project([](auto &document) { document.project.label = "Renamed project"; });
        window.save_to(path);
        QCOMPARE(lmti::load_project(path), window.document());
        QCOMPARE(window.document().structure, d.structure);
        const auto before = bytes(path);
        const auto copy = temp.filePath("loaded-copy.sqlite");
        QVERIFY_THROWS_EXCEPTION(lmti::Error, window.save_to(copy));
        QVERIFY(!QFileInfo::exists(copy));
        QCOMPARE(bytes(path), before);
    }
};
QTEST_MAIN(StructureStorageTest)
#include "structure_storage_test.moc"
