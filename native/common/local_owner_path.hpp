#pragma once
#include "lmti/topology.hpp"
#include <QDir>
#include <QFileInfo>
#include <QStringList>
#include <QRegularExpression>

namespace lmti::detail {
// Pure lexical validation: no QFileInfo probes and no Qt conversion which can
// strip a Windows namespace prefix before the owner has rejected it.
inline QString local_owner_path_lexical(const QString &path) {
    auto invalid = [] { throw Error("Trusted local path unavailable."); };
    if (path.isEmpty() || path.size() > 1024 || path.startsWith("\\\\") || path.startsWith("//")) invalid();
    for (const auto c : path) if (c.unicode() < 32 || c.unicode() == 127) invalid();
    auto normalized = path;
    normalized.replace('\\','/'); // Literal conversion preserves all prefixes for validation.
    // Lexical checks must precede all filesystem probes, including ancestor probes.
    if (normalized.isEmpty() || normalized.size() > 1024 || normalized.startsWith("//") ||
        !QDir::isAbsolutePath(normalized) || QDir::cleanPath(normalized) != normalized) invalid();
    const auto tail = normalized.size() > 1 && normalized[1] == ':' ? normalized.mid(2) : normalized;
    if (tail.contains(':')) invalid();
    const QRegularExpression device("^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\\.|$)",QRegularExpression::CaseInsensitiveOption);
    for (const auto &segment : tail.split('/',Qt::SkipEmptyParts))
        if (segment.endsWith('.') || segment.endsWith(' ') || segment.contains('"') || device.match(segment).hasMatch()) invalid();
    return normalized;
}
inline QString local_owner_path(const QString &path, bool required = true, bool folder = false) {
    auto invalid = [] { throw Error("Trusted local path unavailable."); };
    const auto normalized = local_owner_path_lexical(path);
    QStringList ancestors;
    for (auto part = normalized;;) {
        ancestors.prepend(part);
        const auto parent = QFileInfo(part).dir().absolutePath();
        if (parent == part) break;
        part = parent;
    }
    for (qsizetype i = 0; i < ancestors.size(); ++i) {
        const QFileInfo item(ancestors[i]);
        if (item.isSymLink() || item.isJunction()) invalid();
        const bool leaf = i == ancestors.size()-1;
        if (!leaf && !item.isDir()) invalid();
        if (leaf && (required || item.exists()) && !(folder ? item.isDir() : item.isFile())) invalid();
    }
    const QFileInfo item(normalized);
    if (!item.exists()) return normalized;
    const auto canonical = item.canonicalFilePath();
    if (canonical.isEmpty()) invalid();
    return canonical;
}
} // namespace lmti::detail
