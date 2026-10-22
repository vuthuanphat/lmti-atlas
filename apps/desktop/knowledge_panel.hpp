#pragma once
#include <QCheckBox>
#include <QJsonObject>
#include <QLabel>
#include <QLineEdit>
#include <QPlainTextEdit>
#include <QProcess>
#include <QPushButton>
#include <QTabWidget>
#include <QTimer>
#include <QTreeWidget>
#include <QVector>
#include <QWidget>

class KnowledgePanel : public QWidget {
    struct TableUi {
        QTreeWidget *tree;
        QLineEdit *search;
        QLabel *count, *empty;
    };
    QVector<TableUi> table_ui_;
    QString project_id_, source_root_, source_id_, context_;
    QString status_key_;
    QStringList source_details_;
    QProcess *process_ = nullptr;
    QTimer deadline_;
    QByteArray output_;
    QLabel *status_, *source_, *skill_;
    QString skill_key_, skill_value_;
    QLineEdit *task_;
    QTreeWidget *map_, *memories_, *lessons_;
    QPlainTextEdit *preview_;
    QTreeWidget *context_summary_;
    QTabWidget *tabs_;
    QWidget *banner_;
    QLabel *map_title_, *map_detail_, *memory_title_, *memory_detail_, *lesson_title_, *lesson_detail_;
    QCheckBox *lesson_confirm_;
    QPushButton *lesson_approve_, *lesson_reject_;
    void update_lesson_actions();
    void show_details(QTreeWidget *, QLabel *, QLabel *);
    void filter_table(QTreeWidget *);
    QPushButton *connect_, *reload_, *prepare_, *cancel_, *copy_, *export_, *review_;
    bool review_allowed_ = false;
    bool snapshot_ready_ = false;
    bool memory_connected_ = false;
    void request(const QString &, const QJsonObject &extra = {});
    void receive(const QJsonObject &);
    void fail(const QString &);
    void clear_results();
    void busy(bool);
    void set_status(const QString &);
    void translate_state();
    void refresh_source();
    void review_lesson();

  public:
    explicit KnowledgePanel(QWidget *parent = nullptr);
    ~KnowledgePanel() override;
    void bind_project(const QString &, bool changed);
    void connect_source(const QString &);
    void cancel();
    void add_references(QWidget *);
    void add_drive(QWidget *);
};
