#pragma once
#include <QCheckBox>
#include <QJsonObject>
#include <QLabel>
#include <QPlainTextEdit>
#include <QProcess>
#include <QPushButton>
#include <QTimer>
#include <QTreeWidget>
#include <QUrl>
#include <functional>

// Local-view presentation only. The persistent owner process holds session-only
// credentials and enforces the selected-folder grant on every provider request.
class DriveKnowledgePanel : public QWidget {
    QString project_id_, document_path_, connection_id_, account_name_, scope_id_;
    QString operation_, request_connection_id_, status_key_, next_cursor_, checked_at_;
    qint64 revision_ = 0, next_request_id_ = 0, request_id_ = 0;
    bool clean_ = false, configured_ = false, status_checked_ = false, picker_ = false;
    bool partial_ = false, authorization_opened_ = false, pending_up_ = false;
    bool updating_layout_ = false;
    QJsonObject current_folder_, root_folder_, request_extra_;
    QStringList ancestors_;
    QProcess *process_ = nullptr;
    QTimer deadline_;
    QByteArray output_;
    std::function<bool(const QUrl &)> browser_handler_;
    QLabel *status_, *source_, *count_, *preview_title_;
    QCheckBox *acknowledgment_;
    QPushButton *connect_, *disconnect_, *cancel_, *up_, *refresh_, *choose_, *use_, *next_, *read_, *open_;
    QPushButton *privacy_details_;
    QWidget *documents_, *preview_page_;
    QTreeWidget *files_;
    QPlainTextEdit *preview_;
    void request(const QString &, const QJsonObject &extra = {});
    bool start_process();
    void consume_output();
    void receive(const QJsonObject &);
    void render_page(const QJsonObject &, const QString &expected_folder = {});
    void navigate(const QString &, bool up = false);
    void stop_process();
    void clear_session();
    void clear_preview();
    void fail(const QString &);
    void set_status(const QString &);
    void update_actions();
    void translate();
    void update_text_geometry();
    QJsonObject selected() const;

  protected:
    void resizeEvent(QResizeEvent *) override;

  public:
    explicit DriveKnowledgePanel(QWidget *parent = nullptr);
    ~DriveKnowledgePanel() override;
    void bind_project(const QString &id, const QString &path, qint64 revision, bool clean);
    void cancel();
    // Allows a host/test to supply its browser boundary without exposing URLs in UI.
    void set_browser_handler(std::function<bool(const QUrl &)> handler);
};
