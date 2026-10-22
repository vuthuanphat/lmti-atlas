#pragma once
#include "lmti/mcp_profile_store.hpp"
#include "lmti/project_library.hpp"
#include <QJsonObject>
#include <QLabel>
#include <QPushButton>
#include <QTreeWidget>
#include <QWidget>
#include <array>
#include <memory>

// Private desktop selection; never an Agent DTO or a path permission.
struct McpSelection {
    QString library, project, database, root;
    lmti::ProjectDocument saved;
    bool clean = false;
    bool operator==(const McpSelection &) const = default;
};

class McpProfilePanel final : public QWidget {
    QString store_, project_, root_, database_;
    QStringList sites_;
    bool clean_ = false, available_ = false;
    lmti::McpProfile profile_;
    lmti::McpRuntime runtime_;
    McpSelection selection_;
    QString config_owner_;
    quint64 selection_epoch_ = 0;
    bool epoch_exhausted_ = false;
    struct ReviewedBinding;
    struct SetupReview;
    struct WriteJob;
    std::unique_ptr<WriteJob> write_;
    std::shared_ptr<const SetupReview> uncertain_;
    QString uncertain_action_;
    QTreeWidget *servers_;
    QLabel *summary_, *empty_, *status_;
    QPushButton *add_, *edit_, *toggle_, *check_;
    std::array<QLabel *, 2> clients_;
    std::array<QPushButton *, 2> setup_;
    void refresh();
    void edit_server(bool create);
    void setup_client(lmti::McpClient);
    ReviewedBinding capture_review() const;
    void require_review(const ReviewedBinding &) const;
    lmti::McpGeneration generate(const ReviewedBinding &, lmti::McpClient) const;
    QJsonObject request(const QString &, const SetupReview &) const;
    QJsonObject config_operation(const ReviewedBinding &, const QJsonObject &) const;
    void start_config_write(std::shared_ptr<const SetupReview>, const QString &, const QString &,
                             QLabel *, QPushButton *, QPushButton *, QPushButton *);
    void finish_config_write();
    void check_local();
  protected:
    bool eventFilter(QObject *, QEvent *) override;
  public:
    explicit McpProfilePanel(QString store, QWidget *parent = nullptr);
    ~McpProfilePanel() override;
    void bind(McpSelection, QStringList sites);
    bool has_pending_write() const;
    const lmti::McpProfile &profile() const { return profile_; }
};
