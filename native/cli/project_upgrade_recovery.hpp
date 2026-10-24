#pragma once
#include <QStringList>

// Fixed private read-only library/backup recovery mode; no write dispatch.
int project_upgrade_recovery_main(const QStringList &arguments);
