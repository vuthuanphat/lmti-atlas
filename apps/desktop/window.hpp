#pragma once
#include "lmti/storage.hpp"
#include <QCheckBox>
#include <QComboBox>
#include <QGraphicsView>
#include <QLabel>
#include <QLineEdit>
#include <QMainWindow>
#include <QPlainTextEdit>
#include <QSpinBox>
#include <QTreeWidget>
#include <functional>
#include <map>

class NodeItem;
class Window : public QMainWindow {
    lmti::Topology owned_topology_;
    lmti::Topology &topology_;
    lmti::Topology saved_;
    QString database_path_;
    std::vector<lmti::Topology> undo_, redo_;
    QGraphicsScene *scene_;
    QGraphicsView *view_;
    QTreeWidget *tree_;
    QLineEdit *filter_, *id_, *label_, *site_;
    QComboBox *kind_, *privacy_, *context_site_;
    QSpinBox *poll_;
    QCheckBox *enabled_;
    QPlainTextEdit *context_;
    QPlainTextEdit *context_summary_;
    QLabel *observation_;
    QLabel *zoom_label_, *topology_count_;
    std::map<std::string, NodeItem *> nodes_;
    std::vector<QGraphicsItem *> edges_;
    bool rendering_ = false;
    void edit(const std::function<void(lmti::Topology &)> &operation);
    void rebuild();
    void draw_edges();
    void inspect();
    void update_context();
    void update_title();
    void update_toolbar();
    void update_zoom();
    bool discard_allowed();
    void report(const std::exception &e);
    void add_asset();
    void connect_assets();
    void delete_selected();
    void apply_fields();
    void read_proposal();
    void save_file(bool save_as);

  protected:
    void closeEvent(QCloseEvent *event) override;

  public:
    explicit Window(QWidget *parent = nullptr, lmti::Topology *document = nullptr);
    ~Window() override;
    const lmti::Topology &topology() const {
        return topology_;
    }
    void open_file(const QString &path);
    void select_asset(const std::string &id);
    void apply_checked_proposal(const lmti::ConfigProposal &proposal);
    void save_to(const QString &path);
    // Embedded project editor borrows its owner's typed document, never a store.
    std::function<void(const lmti::Topology &)> commit_topology;
    void refresh_document();
    void retranslate();
};
