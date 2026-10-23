#include "lmti/project_library.hpp"
#include <QCoreApplication>
#include <QDir>
#include <QFile>
#include <QProcess>
#include <QTemporaryDir>
#include <iostream>

namespace {
void check(bool ok) { if (!ok) throw lmti::Error("Operator setup test failed."); }
QByteArray bytes(const QString &path) {
    QFile file(path); check(file.open(QIODevice::ReadOnly)); return file.readAll();
}
int run(const QString &binary, const QStringList &arguments) {
    QProcess process; process.start(binary, arguments);
    check(process.waitForStarted() && process.waitForFinished(15000));
    check(process.exitStatus() == QProcess::NormalExit);
    return process.exitCode();
}
}
int main(int argc, char **argv) {
    QCoreApplication app(argc, argv);
    try {
        check(app.arguments().size() == 2);
        const auto binary = app.arguments()[1];
        QTemporaryDir temp; check(temp.isValid());
        const auto library = temp.filePath("library.sqlite");
        const auto project = temp.filePath("project.sqlite");
        check(run(binary, {"init-project",project,"sample","Sample project"}) == 0);
        check(lmti::load_project(project).project.id == "sample");
        const auto original = bytes(project);
        check(run(binary, {"init-project",project,"other","Overwrite"}) != 0);
        check(bytes(project) == original);
        check(run(binary, {"library-register",library,project,temp.filePath("missing")}) != 0);
        check(!QFile::exists(library));
        check(run(binary, {"library-register",library,project,temp.path()}) == 0);
        auto view = lmti::inspect_project_library(library);
        check(view.token.schema == 1 && view.entries.size() == 1 && view.entries[0].id == "sample");
        const auto before = bytes(library);
        check(run(binary, {"library-register",library,project,temp.path()}) != 0);
        check(bytes(library) == before && bytes(project) == original);
        // A fresh-only owner must never replace a concurrently created library.
        bool refused = false;
        try { lmti::initialize_project_library(library,view.entries[0]); }
        catch (const lmti::Error &) { refused = true; }
        check(refused && bytes(library) == before);
        check(QDir(temp.path()).mkdir("backups"));
        const auto upgrade = lmti::upgrade_project_library(library,temp.filePath("backups"),view.token);
        check(upgrade.state == lmti::LibraryUpgradeState::Upgraded);
        const auto second = temp.filePath("second.sqlite");
        check(run(binary, {"init-project",second,"second","Second project"}) == 0);
        check(run(binary, {"library-register",library,second,temp.path()}) != 0); // Folder collision.
        check(QDir(temp.path()).mkdir("second-root"));
        check(run(binary, {"library-register",library,second,temp.filePath("second-root")}) == 0);
        view = lmti::inspect_project_library(library);
        check(view.entries.size() == 2 && view.token.schema == 2);
        const auto current = view.token;
        check(run(binary, {"library-register",library,second,temp.filePath("second-root")}) != 0);
        check(lmti::inspect_project_library(library).token == current);
        check(run(binary, {"init-project",temp.filePath("invalid.sqlite"),"../invalid","Invalid"}) != 0);
        check(!QFile::exists(temp.filePath("invalid.sqlite")));
        std::cout << "Operator setup: create/register, no overwrite, fresh-only reservation, CAS and folder collision passed.\n";
        return 0;
    } catch (const std::exception &) {
        std::cerr << "Operator setup tests failed.\n";
        return 1;
    }
}
