#pragma once
#include "lmti/project.hpp"
#include <QLabel>
#include <QPushButton>
#include <QTreeWidget>
#include <QWidget>
#include <functional>
#include <optional>

class AgentReviewView final : public QWidget {
    const lmti::ProjectDocument *document_ = nullptr;
    bool clean_ = false;
    std::optional<lmti::WorkProposal> proposal_;
    QTreeWidget *facts_, *comparison_;
    QLabel *status_, *summary_;
    QPushButton *import_, *apply_;
    void refresh();

  public:
    explicit AgentReviewView(QWidget *parent = nullptr);
    std::function<void()> import_file;
    std::function<void(const lmti::WorkProposal &)> apply_proposal;
    void bind(const lmti::ProjectDocument &, bool clean);
    void set_proposal(const lmti::WorkProposal &);
};
