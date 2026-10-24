#pragma once
#include <QStringList>

// Fixed private operator mode. Owns bounded stdin/stdout only; every domain
// operation remains read-only and is delegated to the existing native owner.
int project_operations_main(const QStringList &arguments);
