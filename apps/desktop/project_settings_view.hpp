#pragma once
#include "lmti/project.hpp"
#include <QComboBox>
#include <QLabel>
#include <QLineEdit>
#include <QPushButton>
#include <QWidget>
#include <functional>

class ProjectSettingsView final : public QWidget {
    lmti::ProjectInfo baseline_;
    QLineEdit *name_, *goal_, *id_, *revision_, *folder_;
    QComboBox *visibility_;
    QLabel *error_;
    QPushButton *apply_, *open_folder_;
    QString folder_path_;
    void update_pending();

  public:
    explicit ProjectSettingsView(QWidget *parent = nullptr);
    std::function<void(const lmti::ProjectInfo &)> submit;
    std::function<void()> changed, choose_folder;
    void bind(const lmti::ProjectInfo &, std::int64_t revision, const QString &folder);
    bool pending() const;
    bool apply();
    void revert();
};
