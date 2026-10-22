#pragma once
#include "agent_review_view.hpp"
#include "drive_knowledge_panel.hpp"
#include "impact_panel.hpp"
#include "knowledge_panel.hpp"
#include "mcp_profile_panel.hpp"
#include "lmti/project_store.hpp"
#include "project_library_view.hpp"
#include "project_settings_view.hpp"
#include "window.hpp"
#include <QFrame>
#include <QHBoxLayout>
#include <QListWidget>
#include <QStackedWidget>
#include <QTabWidget>
#include <QToolButton>
#include <array>
#include <optional>

// Stable IDs retain the existing public render/legacy page indices.
enum class ProjectPage {
    Overview,
    Software,
    Hardware,
    Architecture,
    Work,
    Releases,
    Agent,
    Knowledge,
    Settings,
    Impact,
    Mcp
};

class ProjectWindow : public QMainWindow {
    lmti::ProjectDocument document_, saved_;
    QString path_, catalog_, library_path_, folder_, library_error_;
    bool active_ = false;
    bool refreshing_ = false;
    bool navigation_visibility_pending_ = false;
    int resume_page_ = 0;
    std::vector<lmti::ProjectDocument> undo_, redo_;
    QStackedWidget *root_;
    ProjectLibraryView *library_view_;
    QListWidget *navigation_;
    QListWidget *knowledge_navigation_;
    QWidget *project_navigation_;
    QWidget *project_switcher_;
    QPushButton *more_tools_ = nullptr;
    QWidget *recent_projects_;
    QListWidget *recent_list_;
    QHBoxLayout *workspace_body_ = nullptr;
    QWidget *workspace_content_ = nullptr;
    QPushButton *project_settings_;
    ProjectSettingsView *settings_ = nullptr;
    QComboBox *project_picker_;
    QComboBox *language_picker_;
    QPushButton *resume_button_;
    QLabel *breadcrumb_, *folder_label_, *save_state_;
    QLabel *page_description_;
    std::array<QLabel *, 4> metrics_;
    QTabWidget *tabs_;
    QTabWidget *architecture_tabs_;
    Window *architecture_;
    QLabel *heading_, *summary_, *progress_, *agent_note_;
    QTreeWidget *components_, *repositories_, *targets_, *bindings_, *dependencies_, *releases_,
        *verification_, *milestones_, *knowledge_;
    std::vector<QTreeWidget *> work_columns_;
    QLineEdit *work_filter_;
    QComboBox *agent_site_;
    QPlainTextEdit *agent_context_;
    QTreeWidget *agent_summary_;
    QTreeWidget *agent_records_;
    QLineEdit *agent_filter_;
    std::array<QLabel *, 4> agent_counts_;
    std::array<QLabel *, 4> agent_scope_values_;
    QTabWidget *agent_tabs_;
    AgentReviewView *agent_review_ = nullptr;
    QLabel *graph_count_;
    QTreeWidget *work_list_;
    QStackedWidget *work_views_ = nullptr;
    QPushButton *edit_work_, *remove_work_;
    QComboBox *work_mode_;
    QTreeWidget *attention_;
    struct TableUi {
        QString kind;
        QTreeWidget *tree;
        QLineEdit *filter;
        QLabel *count;
        QPushButton *edit = nullptr, *remove = nullptr;
        struct Choice {
            QString key, label;
            QComboBox *widget;
        };
        std::vector<Choice> choices;
    };
    std::vector<TableUi> table_ui_;
    QFrame *inspector_ = nullptr;
    QLabel *inspector_title_, *inspector_summary_, *inspector_state_;
    QTreeWidget *inspector_links_, *inspector_facts_;
    struct InspectorRelation {
        QString kind, id, caption, detail, state;
    };
    std::vector<InspectorRelation> inspector_relations_;
    QWidget *inspector_pagination_ = nullptr;
    QLabel *inspector_page_label_ = nullptr;
    QPushButton *inspector_previous_ = nullptr, *inspector_next_ = nullptr;
    int inspector_page_ = 0;
    QComboBox *inspector_mode_ = nullptr;
    QWidget *inspector_modes_ = nullptr;
    QWidget *inspector_actions_, *inspector_primary_;
    QString inspected_kind_, inspected_id_, create_kind_, create_id_;
    struct ViewState {
        QString kind, id;
        int page, work_mode;
        struct Table {
            QTreeWidget *tree;
            QString selection;
            int scroll;
        };
        std::vector<Table> tables;
        std::vector<std::pair<QLineEdit *, QString>> filters;
        std::vector<std::pair<QComboBox *, QString>> choices;
        std::vector<std::pair<QTabWidget *, int>> tabs;
        struct Canvas {
            QGraphicsView *view;
            QTransform transform;
            int horizontal, vertical;
        };
        std::vector<Canvas> canvases;
        int page_horizontal = 0, page_vertical = 0;
        int inspector_page = 0, inspector_vertical = 0;
        QString related_kind, related_id;
    };
    std::vector<ViewState> inspector_history_;
    ViewState capture_view() const;
    void restore_view(const ViewState &);
    QTreeWidget *overview_bindings_, *overview_blockers_;
    QLabel *attention_count_ = nullptr;
    KnowledgePanel *knowledge_panel_;
    ImpactPanel *impact_panel_ = nullptr;
    DriveKnowledgePanel *drive_panel_ = nullptr;
    McpProfilePanel *mcp_panel_ = nullptr;
    QTreeWidget *hardware_devices_;
    QLabel *hardware_details_;
    QGraphicsScene *relationship_scene_;
    QGraphicsView *relationship_view_ = nullptr;
    QAction *save_action_, *undo_action_, *redo_action_, *review_action_, *close_action_;
    void build_pages();
    void refresh(bool architecture = true, bool keep_knowledge = false);
    void refresh_work();
    void filter_work_views();
    void refresh_agent();
    void filter_agent_records();
    void refresh_relationships();
    void refresh_recent();
    void refresh_navigation();
    void queue_navigation_visibility();
    void filter_inspector_links();
    void configure_table(const QString &, QTreeWidget *, QLineEdit *, QLabel *, QPushButton * = nullptr,
                         QPushButton * = nullptr);
    void filter_table(const TableUi &);
    QComboBox *add_table_filter(QTreeWidget *, QBoxLayout *, const QString &, const QString &);
    void refresh_table_filters(const TableUi &);
    bool matches_table_filters(const TableUi &, const QTreeWidgetItem *) const;
    void build_inspector();
    void refresh_inspector();
    void position_inspector();
    void open_entity(const QString &, const QString &, bool navigate = true);
    void create_related(const QString &);
    void refresh_attention();
    void refresh_creation_actions();
    void create_project_dialog();
    void attach_folder_dialog();
    void open_library_entry(const lmti::LibraryEntry &);
    void locate_library_entry(const lmti::LibraryEntry &);
    // A missing library is an explicitly reviewed state, not an absent intent.
    // Dialog callers capture this before presenting choices; never retokenize
    // after a modal interaction or add registration to automatic remember().
    struct LibraryIntent {
        std::optional<lmti::LibraryInspection> reviewed;
        QString error;
    };
    LibraryIntent capture_library_intent() const;
    LibraryIntent review_library_entry(const lmti::LibraryEntry &) const;
    void require_library_intent(const LibraryIntent &) const;
    void library_failure(const std::exception &);
    void finish_library_intent(const LibraryIntent &, bool explicit_root = false);
    void change_library_folder(const lmti::LibraryEntry &, const QString &, const LibraryIntent &);
    void open_project_intent(const QString &, const QString &, const LibraryIntent &,
                             const std::optional<QString> &explicit_root = std::nullopt);
    void create_project_folder_intent(const QString &, const QString &, const QString &, const QString &,
                                      const LibraryIntent &);
    void attach_project_folder_intent(const QString &, const LibraryIntent &);
    void save_to_intent(const QString &, const LibraryIntent &);
    void remember();
    void edit_entity(const QString &kind, const std::string &id = {},
                     lmti::WorkKind work_kind = lmti::WorkKind::Task);
    void remove_entity(const QString &kind, const std::string &id);
    bool discard_allowed();
    void save_file(bool save_as);
    void review_file();
    void error(const std::exception &);

  protected:
    void closeEvent(QCloseEvent *) override;
    void resizeEvent(QResizeEvent *) override;
    bool eventFilter(QObject *, QEvent *) override;

  public:
    explicit ProjectWindow(QWidget *parent = nullptr, QString catalog = {});
    ~ProjectWindow() override;
    const lmti::ProjectDocument &document() const {
        return document_;
    }
    void new_project(const QString &label, const QString &goal = {});
    void create_project_folder(const QString &parent, const QString &folder_name, const QString &label,
                               const QString &goal = {});
    void attach_project_folder(const QString &folder);
    void show_library();
    void set_language(bool english);
    QString library_path() const {
        return library_path_;
    }
    void load_demo();
    void open_project(const QString &path, const QString &expected_id = {});
    void save_to(const QString &path);
    void update_project(const std::function<void(lmti::ProjectDocument &)> &operation,
                        bool architecture = true);
    void apply_checked_proposal(const lmti::WorkProposal &);
    void review_proposal(const lmti::WorkProposal &);
    void show_page(int index) {
        if (active_ && index >= 0 && index < tabs_->count()) {
            root_->setCurrentIndex(1);
            tabs_->setCurrentIndex(index);
        }
    }
    void show_page(ProjectPage page) {
        show_page(static_cast<int>(page));
    }
};
