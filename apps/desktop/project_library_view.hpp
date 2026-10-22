#pragma once
#include "lmti/project_library.hpp"
#include <QBoxLayout>
#include <QButtonGroup>
#include <QComboBox>
#include <QGridLayout>
#include <QLabel>
#include <QLineEdit>
#include <QPushButton>
#include <QScrollArea>
#include <QStackedWidget>
#include <QTreeWidget>
#include <functional>

class ProjectLibraryView : public QWidget {
    std::vector<lmti::LibraryEntry> entries_;
    QLineEdit *search_;
    QButtonGroup *filters_;
    QComboBox *mode_, *sort_;
    QWidget *mode_segments_, *controls_, *starter_;
    QBoxLayout *controls_row_;
    QScrollArea *scroll_ = nullptr;
    QStackedWidget *views_;
    QTreeWidget *list_ = nullptr;
    QGridLayout *grid_;
    QLabel *count_, *page_label_, *notice_;
    QPushButton *previous_, *next_;
    int page_ = 0, columns_ = 3;
    void rebuild();
    void open_folder(const QString &path);

  protected:
    bool eventFilter(QObject *, QEvent *) override;

  public:
    explicit ProjectLibraryView(QWidget *parent = nullptr);
    std::function<void()> create_project, attach_folder, import_file, open_demo;
    std::function<void(const lmti::LibraryEntry &)> open_project, toggle_pin, remove_reference,
        locate_project, change_folder;
    void set_entries(std::vector<lmti::LibraryEntry> entries);
    void set_error(const QString &message);
};
