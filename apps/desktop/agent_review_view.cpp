#include "agent_review_view.hpp"
#include "studio_widgets.hpp"
#include <QHBoxLayout>
#include <QVBoxLayout>

AgentReviewView::AgentReviewView(QWidget *parent) : QWidget(parent) {
    setObjectName("agentReviewPage");
    auto outer = new QVBoxLayout(this);
    outer->setContentsMargins(0, 12, 0, 0);
    auto tools = new QHBoxLayout;
    tools->addWidget(
        studio::caption("Review proposed work-state changes before applying them to this project.", "muted"),
        1);
    import_ = new QPushButton(project_caption("Import proposal"));
    import_->setProperty("uiCaption", "Import proposal");
    import_->setProperty("primary", true);
    import_->setObjectName("reviewProposalButton");
    connect(import_, &QPushButton::clicked, this, [this] {
        if (import_file)
            import_file();
    });
    tools->addWidget(import_);
    outer->addLayout(tools);
    auto split = new QHBoxLayout;
    split->setSpacing(18);
    QVBoxLayout *proposal_body, *review_body;
    auto proposal = studio::panel("Proposed change", &proposal_body);
    facts_ = new QTreeWidget;
    facts_->setObjectName("proposalFacts");
    facts_->setHeaderHidden(true);
    facts_->setColumnCount(2);
    studio::inventory(facts_);
    facts_->header()->setSectionResizeMode(QHeaderView::ResizeToContents);
    facts_->header()->setStretchLastSection(true);
    proposal_body->addWidget(facts_, 1);
    proposal_body->addWidget(studio::caption("Change comparison", "sectionTitle"));
    comparison_ = new QTreeWidget;
    comparison_->setObjectName("proposalComparison");
    comparison_->setHeaderLabels({"Field", "Current", "Proposed"});
    studio::inventory(comparison_);
    comparison_->header()->setSectionResizeMode(QHeaderView::Stretch);
    comparison_->setMaximumHeight(130);
    proposal_body->addWidget(comparison_);
    status_ = new QLabel;
    status_->setTextFormat(Qt::PlainText);
    status_->setWordWrap(true);
    status_->setProperty("verbatim", true);
    status_->setObjectName("proposalStatus");
    proposal_body->addWidget(status_);
    split->addWidget(proposal, 3);
    auto review = studio::panel("Review proposal", &review_body);
    review_body->addWidget(studio::caption("Summary", "sectionTitle"));
    summary_ = new QLabel;
    summary_->setTextFormat(Qt::PlainText);
    summary_->setWordWrap(true);
    summary_->setProperty("verbatim", true);
    review_body->addWidget(summary_);
    review_body->addWidget(studio::caption("What changes", "sectionTitle"));
    review_body->addWidget(studio::caption(
        "Only the selected work item's state. Descriptions, checklist and related records stay unchanged."));
    review_body->addStretch();
    auto actions = new QHBoxLayout;
    apply_ = new QPushButton(project_caption("Apply to document"));
    apply_->setProperty("uiCaption", "Apply to document");
    apply_->setProperty("primary", true);
    apply_->setObjectName("applyWorkProposal");
    auto cancel = new QPushButton(project_caption("Cancel"));
    cancel->setProperty("uiCaption", "Cancel");
    cancel->setObjectName("cancelWorkProposal");
    connect(cancel, &QPushButton::clicked, this, [this] {
        proposal_.reset();
        refresh();
    });
    connect(apply_, &QPushButton::clicked, this, [this] {
        if (!document_ || !clean_ || !proposal_ || !apply_proposal)
            return;
        try {
            // Revalidate at activation, not only when the preview was rendered.
            const auto proposal = *proposal_;
            lmti::apply_proposal(*document_, proposal);
            apply_proposal(proposal);
            proposal_.reset();
            refresh();
        } catch (const std::exception &exception) {
            status_->setText(QString::fromUtf8(exception.what()));
            apply_->setEnabled(false);
        }
    });
    actions->addWidget(apply_);
    actions->addWidget(cancel);
    review_body->addLayout(actions);
    split->addWidget(review, 2);
    outer->addLayout(split, 1);
    outer->addWidget(
        studio::caption("Applying edits the draft. Save persists it. Devices are not executed.", "muted"));
    refresh();
}
void AgentReviewView::bind(const lmti::ProjectDocument &document, bool clean) {
    document_ = &document;
    clean_ = clean;
    if (proposal_ && proposal_->project_id != document.project.id)
        proposal_.reset();
    refresh();
}
void AgentReviewView::set_proposal(const lmti::WorkProposal &proposal) {
    proposal_ = proposal;
    refresh();
}
void AgentReviewView::refresh() {
    facts_->clear();
    comparison_->clear();
    apply_->setEnabled(false);
    import_->setEnabled(document_ && clean_);
    import_->setToolTip(
        document_ && clean_ ? "" : project_caption("Save the project before reviewing a proposal"));
    if (!document_ || !proposal_) {
        status_->setText(project_caption("Import a bounded work proposal to review its changes."));
        summary_->setText(project_caption("No proposal loaded"));
        return;
    }
    const auto &proposal = *proposal_;
    auto work = std::find_if(document_->work.begin(), document_->work.end(),
                             [&](const auto &item) { return item.id == proposal.work_id; });
    const auto current = work == document_->work.end()
                             ? project_caption("Not found")
                             : studio::enum_caption(QString::fromStdString(lmti::name(work->state)));
    const auto desired = studio::enum_caption(QString::fromStdString(lmti::name(proposal.desired)));
    auto fact = [this](const QString &key, const QString &value) {
        new QTreeWidgetItem(facts_, {project_caption(key), value});
    };
    fact("Work", work == document_->work.end() ? QString::fromStdString(proposal.work_id)
                                               : QString::fromStdString(work->label));
    fact("Project", QString::fromStdString(proposal.project_id));
    fact("Saved revision", QString::number(proposal.revision));
    fact("Current state", current);
    fact("Proposed state", desired);
    new QTreeWidgetItem(comparison_, {project_caption("Work state"), current, desired});
    summary_->setText(project_caption("Work state: %1 → %2").arg(current, desired));
    try {
        if (!clean_)
            throw lmti::Error("Save the clean project before applying a proposal.");
        lmti::apply_proposal(*document_, proposal);
        status_->setText(project_caption("Saved revision matches proposal: r%1").arg(proposal.revision));
        apply_->setEnabled(true);
    } catch (const std::exception &exception) {
        status_->setText(QString::fromUtf8(exception.what()));
    }
}
