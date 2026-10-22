#pragma once
#include <QCheckBox>
#include <QComboBox>
#include <QJsonObject>
#include <QLabel>
#include <QLineEdit>
#include <QPlainTextEdit>
#include <QProcess>
#include <QPushButton>
#include <QTabWidget>
#include <QTimer>
#include <QTreeWidget>

// Presentation only. The impact owner validates scope, freshness and all writes.
class ImpactPanel : public QWidget {
    QString project_id_, document_path_, config_path_, operation_, status_key_;
    QStringList sites_;
    qint64 revision_ = 0, graph_revision_ = -1, review_revision_ = 0;
    bool clean_ = false, review_allowed_ = false, loaded_ = false, report_saved_ = false;
    QJsonObject snapshot_, report_, review_, preview_, requested_change_;
    QString requested_report_id_;
    QProcess *process_ = nullptr;
    QTimer deadline_;
    QByteArray output_;
    QLabel *status_, *source_;
    QTabWidget *tabs_;
    QPushButton *connect_, *create_, *reload_, *cancel_, *upgrade_, *import_, *preview_button_, *accept_,
        *reject_, *report_button_, *save_report_, *open_report_, *verify_;
    QCheckBox *import_confirm_, *verify_confirm_;
    QComboBox *entity_, *category_, *verification_status_, *saved_reports_;
    QLineEdit *description_, *baseline_, *proposed_, *evidence_summary_, *evidence_ref_, *report_id_;
    QTreeWidget *sources_, *imports_, *targets_, *findings_, *checklist_, *history_;
    QPlainTextEdit *details_, *import_details_;
    void request(const QString &, QJsonObject extra = {});
    void receive(const QJsonObject &);
    void render_report(const QJsonObject &);
    void clear_report();
    void clear_results();
    void update_actions();
    void set_status(const QString &);
    void fail(const QString &);
    void setup_dialog();
    QJsonObject change() const;
    void review_import(const QString &);

  public:
    explicit ImpactPanel(QWidget *parent = nullptr);
    ~ImpactPanel() override;
    void bind_project(const QString &id, const QString &path, qint64 revision, bool clean,
                      const QStringList &sites);
    void connect_workspace(const QString &config);
    void create_workspace(const QString &config, const QString &site, const QString &environment,
                          bool allow_internal);
    void cancel();
};
