#pragma once
#include <QStringList>

// Private launcher-selected conditional read. No writes or current-target repinning.
int original_binding_read_main(const QStringList &arguments);
