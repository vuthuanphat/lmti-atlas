// Development-only Widgets driver for the WEB-03 synthetic integration trial.
// Not installed, packaged, exposed by MCP or used with operator libraries.
#include "mcp_profile_panel.hpp"
#include "project_window.hpp"
#include <QApplication>
#include <QDialog>
#include <QDialogButtonBox>
#include <QDir>
#include <QFile>
#include <QJsonArray>
#include <QJsonDocument>
#include <QLineEdit>
#include <QPlainTextEdit>
#include <QPointer>
#include <QTimer>
#include <iostream>

namespace {
void require(bool value) { if (!value) throw lmti::Error("Synthetic Qt probe refused."); }
void reply(int sequence, const QJsonObject &data) {
    QJsonObject result{{"sequence", sequence}, {"ok", true}, {"data", data}};
    const auto bytes = QJsonDocument(result).toJson(QJsonDocument::Compact);
    require(bytes.size() <= 128*1024);
    std::cout << bytes.constData() << std::endl;
}
void failure(int sequence, const char *phase) {
    const auto bytes = QJsonDocument(QJsonObject{{"sequence",sequence},{"ok",false},
                                                {"phase",QString::fromLatin1(phase)}}).toJson(QJsonDocument::Compact);
    std::cout << bytes.constData() << std::endl;
}
void progress(int sequence,const char *phase) {
    const auto bytes=QJsonDocument(QJsonObject{{"kind","phase"},{"sequence",sequence},{"phase",QString::fromLatin1(phase)}}).toJson(QJsonDocument::Compact);
    std::cout<<bytes.constData()<<std::endl;
}
}

int main(int argc, char **argv) {
    QApplication app(argc, argv);
    app.setApplicationName("LMTI WEB-03 synthetic Qt probe");
    app.setOrganizationName("LMTI synthetic tests");
    try {
        require(argc == 2);
        const auto root = lmti::checked_project_folder(QString::fromLocal8Bit(argv[1]));
        const auto build = QDir(QString::fromUtf8(LMTI_INTEROP_BUILD_ROOT)).absolutePath() + '/';
        require(root.startsWith(build, Qt::CaseInsensitive));
        QFile marker(QDir(root).filePath("web03-qt-fixture"));
        require(marker.open(QIODevice::ReadOnly) && marker.readAll() == "lmti.web03.synthetic.v1");
        ProjectWindow window(nullptr, QDir(root).filePath("catalog.sqlite"));
        window.open_project(QDir(root).filePath("synthetic-project.sqlite"));
        window.show_page(ProjectPage::Mcp); window.resize(1280,720); window.show();
        auto panel = static_cast<McpProfilePanel *>(window.findChild<QWidget *>("projectMcpPanel"));
        require(panel);
        const auto snapshot = [&] {
            QJsonArray servers;
            for (const auto &s : panel->profile().servers)
                servers.append(QJsonObject{{"id", QString::fromStdString(s.id)}, {"enabled", s.enabled},
                                           {"label", QString::fromStdString(s.label)}});
            return QJsonObject{{"projectId", QString::fromStdString(panel->profile().project_id)},
                               {"revision", static_cast<double>(panel->profile().revision)}, {"servers", servers}};
        };
        reply(0, snapshot());
        int last = 0, unavailable_ticks = 0, close_sequence = -1, write_sequence = -1;
        bool exit_requested = false;
        int requested_exit_code = 0;
        QPointer<QDialog> write_dialog;
        // Test-driver failures must obey the same writer lifetime as the UI.
        // A deadline reports failure but never destroys an active child.
        const auto request_exit = [&](int code) {
            exit_requested = true; requested_exit_code = code;
            if (!panel->has_pending_write()) app.exit(code);
        };
        QTimer timer, completion;
        QObject::connect(&completion, &QTimer::timeout, &window, [&] {
            if (panel->has_pending_write()) return;
            if (write_sequence >= 0) {
                const auto completed = write_sequence; write_sequence = -1;
                try {
                    auto status = write_dialog ? write_dialog->findChild<QLabel *>("mcpSetupStatus")
                                               : window.findChild<QLabel *>("mcpOperationStatus");
                    auto apply = write_dialog ? write_dialog->findChild<QPushButton *>("applyMcpConfig") : nullptr;
                    require(status);
                    reply(completed, {{"status",status->text()}, {"canApply",apply && apply->isEnabled()}});
                } catch (...) { failure(completed,"write_completion"); request_exit(2); }
                write_dialog.clear();
            }
            if (exit_requested) {
                if (auto dialog = window.findChild<QDialog *>("mcpClientSetupDialog")) dialog->reject();
                app.exit(requested_exit_code);
            }
        });
        completion.start(20);
        QObject::connect(&timer, &QTimer::timeout, &window, [&] {
            if (write_sequence >= 0 || exit_requested) return;
            const char *phase = "command_open";
            try {
                QFile input(QDir(root).filePath("qt-command.json"));
                if (!input.exists()) return;
                const QFileInfo info(input.fileName());
                require(!info.isSymLink() && !info.isJunction());
                // Windows replacement/scanner locks can briefly prevent opening
                // an otherwise valid IPC file. Wait at most 50 polls; never
                // change permissions or relax the content/sequence checks.
                if (!input.open(QIODevice::ReadOnly)) {
                    require(++unavailable_ticks <= 50);
                    return;
                }
                unavailable_ticks = 0;
                require(input.size() <= 1024);
                const auto bytes = input.read(1025);
                require(bytes.size() <= 1024 && input.error() == QFileDevice::NoError);
                const auto document = QJsonDocument::fromJson(bytes);
                input.close();
                phase = "command_decode";
                require(document.isObject()); const auto request = document.object();
                require(request.size() == 2 && request.value("sequence").isDouble() && request.value("action").isString());
                const int sequence = request.value("sequence").toInt();
                if (sequence == last) return;
                phase = "command_sequence";
                require(sequence == last + 1); last = sequence;
                const auto action = request.value("action").toString();
                progress(sequence,"received");
                phase = "widget_action";
                auto dialog = window.findChild<QDialog *>("mcpClientSetupDialog");
                if (action == "quit") { require(!panel->has_pending_write()); if (dialog) dialog->reject(); reply(sequence, {{"stopped",true}}); request_exit(0); return; }
                if (action == "close_preview") { require(dialog && dialog->isVisible()); close_sequence=sequence; dialog->accept(); return; }
                if (action == "apply_preview" || action == "restore_preview") {
                    require(dialog && dialog->isVisible());
                    auto button = dialog->findChild<QPushButton *>(action == "apply_preview" ? "applyMcpConfig" : "restoreMcpConfig");
                    require(button && button->isEnabled()); button->click();
                    // Also covers immediate stale-review refusal: the next poll
                    // reports it without claiming that a write was dispatched.
                    write_sequence = sequence; write_dialog = dialog;
                    return;
                }
                require(!dialog);
                if (action == "reload_factory" || action == "reload_edge") {
                    progress(sequence,"opening_project");
                    window.open_project(QDir(root).filePath(action == "reload_factory" ? "synthetic-project.sqlite" : "edge-project/project.sqlite"));
                    progress(sequence,"project_opened");
                    window.show_page(ProjectPage::Mcp); reply(sequence, snapshot());
                } else if (action == "toggle_local") {
                    auto tree = window.findChild<QTreeWidget *>("projectMcpServers"); require(tree);
                    QTreeWidgetItem *selected = nullptr;
                    for (int i=0; i<tree->topLevelItemCount(); ++i)
                        if (tree->topLevelItem(i)->data(0,Qt::UserRole).toString() == "lmti_m1") selected=tree->topLevelItem(i);
                    require(selected); tree->setCurrentItem(selected);
                    auto button = window.findChild<QPushButton *>("toggleMcpConnection"); require(button && button->isEnabled());
                    button->click(); auto data = snapshot();
                    data["status"] = window.findChild<QLabel *>("mcpOperationStatus")->text(); reply(sequence,data);
                } else if (action == "add_docs") {
                    QString error;
                    QTimer::singleShot(0, &window, [&] {
                        try {
                            auto editor = window.findChild<QDialog *>("mcpConnectionDialog"); require(editor);
                            editor->findChild<QLineEdit *>("mcpConnectionKey")->setText("project_docs");
                            editor->findChild<QLineEdit *>("mcpConnectionName")->setText("Project docs");
                            editor->findChild<QLineEdit *>("mcpConnectionUrl")->setText("https://example.com/mcp");
                            editor->findChild<QDialogButtonBox *>()->button(QDialogButtonBox::Save)->click();
                            error=editor->findChild<QLabel *>("mcpConnectionError")->text();
                            editor->reject();
                        } catch (...) { failure(last,"connection_dialog"); request_exit(2); }
                    });
                    window.findChild<QPushButton *>("addMcpConnection")->click();
                    auto data=snapshot();data["status"]=error;reply(sequence,data);
                } else if (action == "preview_codex" || action == "preview_cursor") {
                    // Open outside the poll timer callback so a nested modal loop
                    // can keep reading subsequent coordinated probe commands.
                    QTimer::singleShot(0, &window, [&, sequence, action] {
                    auto ready=new QTimer(&window);
                    QObject::connect(ready,&QTimer::timeout,&window,[&, sequence, ready] {
                        try {
                            auto preview = window.findChild<QDialog *>("mcpClientSetupDialog");
                            if(!preview || !preview->isVisible())return;
                            ready->stop();
                            auto data = snapshot(); data["content"] = preview->findChild<QPlainTextEdit *>("mcpConfigPreview")->toPlainText();
                            data["canApply"] = preview->findChild<QPushButton *>("applyMcpConfig")->isEnabled(); reply(sequence,data);
                        } catch (...) { failure(sequence,"setup_dialog"); request_exit(2); }
                    });
                    ready->start(10);
                    window.findChild<QPushButton *>(action == "preview_codex" ? "setupMcpCodex" : "setupMcpCursor")->click();
                    ready->stop();ready->deleteLater();
                    if(close_sequence>=0){const auto closed=close_sequence;close_sequence=-1;reply(closed,snapshot());}
                    });
                } else throw lmti::Error("Unsupported probe action.");
            } catch (...) { failure(last,phase); request_exit(2); }
        });
        timer.start(20);
        QTimer::singleShot(300000, &app, [&] { failure(last,"lifetime_expired"); request_exit(2); });
        return app.exec();
    } catch (...) { std::cerr << "Synthetic Qt probe rejected.\n"; return 2; }
}
