#pragma once
#include "lmti/topology.hpp"
#include <QByteArray>
#include <QJsonArray>
#include <QJsonDocument>
#include <QJsonObject>
#include <QSet>
#include <QString>
#include <vector>

namespace lmti::detail {
inline QJsonObject strict_json_object(const QByteArray &bytes, qsizetype cap) {
    auto invalid = [] { throw Error("Invalid JSON input."); };
    if (bytes.isEmpty() || bytes.size() > cap || QString::fromUtf8(bytes).toUtf8() != bytes) invalid();
    QJsonParseError error;
    const auto document = QJsonDocument::fromJson(bytes, &error);
    if (error.error != QJsonParseError::NoError || !document.isObject()) invalid();
    std::vector<QSet<QString>> objects;
    int depth = 0;
    for (qsizetype i = 0; i < bytes.size(); ++i) {
        if (bytes[i] == '{' || bytes[i] == '[') {
            if (++depth > 16) invalid();
            if (bytes[i] == '{') objects.emplace_back();
        } else if (bytes[i] == '}' || bytes[i] == ']') {
            --depth;
            if (bytes[i] == '}') objects.pop_back();
        } else if (bytes[i] == '"') {
            const auto start = i++;
            while (i < bytes.size() && bytes[i] != '"') { if (bytes[i] == '\\') ++i; ++i; }
            // Raw UTF-8 validity does not validate code units introduced by
            // JSON escapes. Check every quoted token before any conversion;
            // this also covers keys and values overwritten by duplicate keys.
            QJsonParseError token_error;
            const auto token = QJsonDocument::fromJson(
                QByteArray("[") + bytes.mid(start, i-start+1) + "]", &token_error);
            if (token_error.error != QJsonParseError::NoError || !token.isArray()) invalid();
            const auto values = token.array();
            if (values.size() != 1 || !values.at(0).isString()) invalid();
            const auto decoded = values.at(0).toString();
            if (!decoded.isValidUtf16()) invalid();
            auto after = i + 1;
            while (after < bytes.size() && (bytes[after] == ' ' || bytes[after] == '\r' || bytes[after] == '\n' || bytes[after] == '\t')) ++after;
            if (after < bytes.size() && bytes[after] == ':') {
                if (objects.empty()) invalid();
                if (objects.back().contains(decoded)) invalid();
                objects.back().insert(decoded);
            }
        }
    }
    return document.object();
}
} // namespace lmti::detail
