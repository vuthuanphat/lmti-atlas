#pragma once
#include <QString>

// Disposable synthetic fixtures only. Memory creation goes through its TS owner.
bool create_design_knowledge_fixture(const QString &directory, const QString &project_id);
