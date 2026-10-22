#include "mcp_profile_panel.hpp"
#include "project_window.hpp"
#include <QDialog>
#include <QDialogButtonBox>
#include <QFile>
#include <QLineEdit>
#include <QPlainTextEdit>
#include <QScopeGuard>
#include <QTemporaryDir>
#include <QTimer>
#include <QtTest>

class McpPanelTest : public QObject {
    Q_OBJECT
  private slots:
    void add_validate_reload_and_preview_both_clients() {
        QTemporaryDir temp;
        ProjectWindow window(nullptr, temp.filePath("catalog.sqlite"));
        window.load_demo();
        QCOMPARE(window.findChild<QTabWidget *>("projectTabs")->currentIndex(), static_cast<int>(ProjectPage::Mcp));
        QVERIFY(!window.findChild<QPushButton *>("addMcpConnection")->isEnabled());
        window.save_to(temp.filePath("project.sqlite"));
        window.show();
        auto panel = static_cast<McpProfilePanel *>(window.findChild<QWidget *>("projectMcpPanel"));
        QVERIFY(panel);
        const auto before = window.document();
        QTimer::singleShot(0, &window, [&] {
            auto dialog = window.findChild<QDialog *>("mcpConnectionDialog");
            QVERIFY(dialog);
            const auto close = qScopeGuard([&] { dialog->reject(); });
            auto key = dialog->findChild<QLineEdit *>("mcpConnectionKey");
            auto name = dialog->findChild<QLineEdit *>("mcpConnectionName");
            auto url = dialog->findChild<QLineEdit *>("mcpConnectionUrl");
            key->setText("cloudflare"); name->setText("Cloudflare");
            url->setText("https://example.com/mcp?token=blockedvalue");
            auto save = dialog->findChild<QDialogButtonBox *>()->button(QDialogButtonBox::Save);
            save->click();
            QVERIFY(!dialog->findChild<QLabel *>("mcpConnectionError")->text().isEmpty());
            QCOMPARE(panel->profile().revision, std::int64_t(0));
            url->setText("https://example.com/mcp"); save->click();
        });
        window.findChild<QPushButton *>("addMcpConnection")->click();
        QCOMPARE(panel->profile().revision, std::int64_t(1));
        QCOMPARE(panel->profile().servers.size(), std::size_t(1));
        QCOMPARE(window.document(), before);
        for (const auto *button : {"setupMcpCodex", "setupMcpCursor"}) {
            QTimer::singleShot(0, &window, [&] {
                auto dialog = window.findChild<QDialog *>("mcpClientSetupDialog");
                QVERIFY(dialog);
                const auto close = qScopeGuard([&] { dialog->reject(); });
                const auto text = dialog->findChild<QPlainTextEdit *>("mcpConfigPreview")->toPlainText();
                QVERIFY(text.contains("https://example.com/mcp"));
                QVERIFY(text.contains("cloudflare"));
                QVERIFY(!dialog->findChild<QPushButton *>("applyMcpConfig")->isEnabled());
                QVERIFY(dialog->findChild<QPushButton *>("exportMcpConfig")->isEnabled());
                dialog->accept();
            });
            window.findChild<QPushButton *>(button)->click();
        }
        window.open_project(temp.filePath("project.sqlite"));
        QCOMPARE(panel->profile().revision, std::int64_t(1));
        window.new_project("Other project");
        QCOMPARE(panel->profile().servers.size(), std::size_t(0));
    }
    void panel_layout_languages_and_no_synthetic_online_claims() {
        QTemporaryDir temp;
        ProjectWindow window(nullptr, temp.filePath("catalog.sqlite"));
        window.load_demo(); window.save_to(temp.filePath("project.sqlite"));
        for (bool english : {true, false}) {
            window.set_language(english);
            for (const auto size : {QSize(1280,720), QSize(1440,900)}) {
                window.resize(size); window.show_page(ProjectPage::Mcp); window.show();
                QCoreApplication::processEvents();
                auto add = window.findChild<QPushButton *>("addMcpConnection");
                QVERIFY(add->isVisible());
                const auto bounds = QRect(add->mapTo(&window, QPoint()), add->size());
                QVERIFY(window.rect().contains(bounds));
                auto summary = window.findChild<QLabel *>("mcpProfileSummary");
                QVERIFY(!summary->text().contains("online", Qt::CaseInsensitive));
                QVERIFY(!window.findChild<QPushButton *>("checkLocalMcp")->isEnabled());
            }
        }
    }
    void local_handshake_and_client_apply_restore_in_fixture() {
        if (qEnvironmentVariable("LMTI_STUDIO_PYTHON_BINARY").isEmpty())
            QSKIP("Configure trusted Python for this process integration.");
        QTemporaryDir temp;
        ProjectWindow window(nullptr, temp.filePath("catalog.sqlite"));
        window.create_project_folder(temp.path(), "Pilot", "Pilot");
        const auto database = temp.filePath("Pilot/project.lmti.sqlite");
        lmti::McpProfile profile{window.document().project.id, 0,
            {{"lmti_context", "LMTI context", "", "default", lmti::McpTransport::LmtiLocal, lmti::McpAuth::None}}};
        lmti::save_mcp_profile(temp.filePath("mcp-profiles.sqlite"), profile);
        window.open_project(database); window.show();
        auto panel = static_cast<McpProfilePanel *>(window.findChild<QWidget *>("projectMcpPanel"));
        QVERIFY(panel);
        window.findChild<QPushButton *>("checkLocalMcp")->click();
        const auto status = window.findChild<QLabel *>("mcpOperationStatus")->text();
        QVERIFY2(status.contains("4 tools"), qPrintable(status));
        for (int i = 0; i < 2; ++i) {
            const auto path = temp.filePath(i == 0 ? "Pilot/.codex/config.toml" : "Pilot/.cursor/mcp.json");
            QTimer::singleShot(0, &window, [&] {
                auto dialog = window.findChild<QDialog *>("mcpClientSetupDialog");
                QVERIFY(dialog);
                const auto close = qScopeGuard([&] { dialog->reject(); });
                auto apply = dialog->findChild<QPushButton *>("applyMcpConfig");
                QVERIFY2(apply->isEnabled(), qPrintable(dialog->findChild<QLabel *>("mcpSetupStatus")->text()));
                apply->click();
                QTRY_VERIFY_WITH_TIMEOUT(!panel->has_pending_write(), 12000);
                QVERIFY2(QFileInfo::exists(path), qPrintable(dialog->findChild<QLabel *>("mcpSetupStatus")->text()));
                QVERIFY(dialog->findChild<QLabel *>("mcpSetupStatus")->text().contains("not verified"));
                dialog->findChild<QPushButton *>("restoreMcpConfig")->click();
                QTRY_VERIFY_WITH_TIMEOUT(!panel->has_pending_write(), 12000);
                QVERIFY(!QFileInfo::exists(path));
                dialog->accept();
            });
            window.findChild<QPushButton *>(i == 0 ? "setupMcpCodex" : "setupMcpCursor")->click();
        }
    }
};
QTEST_MAIN(McpPanelTest)
#include "mcp_profile_panel_test.moc"
