#include "lmti/storage.hpp"
#include <QDir>
#include <QFileInfo>
#include <QSqlDatabase>
#include <QSqlError>
#include <QSqlQuery>
#include <QUuid>
#include <QVariant>
#include <unordered_set>

namespace lmti {
namespace {
constexpr int application_id = 0x4c4d5449;
constexpr qint64 max_database_bytes = 64 * 1024 * 1024;
class Database {
    QString connection_;

  public:
    QSqlDatabase db;
    Database(const Database &) = delete;
    Database &operator=(const Database &) = delete;
    Database(const QString &path, bool readonly) {
        QFileInfo info(path);
        if (path.isEmpty() || path.contains(QChar(0)) || info.isSymLink() ||
            (info.exists() && (!info.isFile() || info.size() > max_database_bytes)) ||
            (!info.exists() && readonly))
            throw Error("Database must be an existing regular topology file for reads, at most 64 MiB.");
        if (!info.dir().exists())
            throw Error("Database parent directory does not exist.");
        connection_ = QUuid::createUuid().toString(QUuid::WithoutBraces);
        db = QSqlDatabase::addDatabase("QSQLITE", connection_);
        db.setDatabaseName(info.absoluteFilePath());
        db.setConnectOptions(readonly ? "QSQLITE_OPEN_READONLY;QSQLITE_BUSY_TIMEOUT=2000"
                                      : "QSQLITE_BUSY_TIMEOUT=2000");
        if (!db.open()) {
            db = QSqlDatabase();
            QSqlDatabase::removeDatabase(connection_);
            throw Error("Cannot open topology database.");
        }
        try {
            exec("PRAGMA trusted_schema=OFF");
            exec("PRAGMA foreign_keys=ON");
            if (readonly)
                exec("PRAGMA query_only=ON");
        } catch (...) {
            db.close();
            db = QSqlDatabase();
            QSqlDatabase::removeDatabase(connection_);
            throw;
        }
    }
    ~Database() {
        db.close();
        db = QSqlDatabase();
        QSqlDatabase::removeDatabase(connection_);
    }
    void exec(const QString &sql) {
        QSqlQuery q(db);
        if (!q.exec(sql))
            throw Error("Topology database operation failed.");
    }
    qint64 scalar(const QString &sql) {
        QSqlQuery q(db);
        if (!q.exec(sql) || !q.next())
            throw Error("Invalid topology database.");
        bool ok = false;
        const auto v = q.value(0).toLongLong(&ok);
        if (!ok)
            throw Error("Invalid topology integer.");
        return v;
    }
};
void run(QSqlQuery &q) {
    if (!q.exec())
        throw Error("Topology database query failed.");
}
void prepare(QSqlQuery &q, const QString &sql) {
    if (!q.prepare(sql))
        throw Error("Invalid topology schema.");
}
std::string text(const QSqlQuery &q, int col, std::size_t max) {
    const auto value = q.value(col);
    if (value.isNull() || value.typeId() != QMetaType::QString)
        throw Error("Invalid topology text column.");
    const auto bytes = value.toString().toUtf8();
    if (static_cast<std::size_t>(bytes.size()) > max)
        throw Error("Topology field exceeds size limit.");
    return bytes.toStdString();
}
qint64 number(const QSqlQuery &q, int col) {
    const auto value = q.value(col);
    if (value.isNull() || (value.typeId() != QMetaType::LongLong && value.typeId() != QMetaType::Int))
        throw Error("Invalid topology integer column.");
    bool ok = false;
    auto n = value.toLongLong(&ok);
    if (!ok)
        throw Error("Invalid topology integer.");
    return n;
}
Asset asset(const QSqlQuery &q) {
    Asset a;
    a.id = text(q, 0, 64);
    a.label = text(q, 1, 120);
    a.site = text(q, 2, 64);
    a.kind = parse_kind(text(q, 3, 20));
    a.privacy = parse_privacy(text(q, 4, 20));
    const auto enabled = number(q, 5), poll = number(q, 6);
    if ((enabled != 0 && enabled != 1) || poll < 100 || poll > 3600000)
        throw Error("Invalid stored desired configuration.");
    a.enabled = enabled == 1;
    a.poll_ms = static_cast<int>(poll);
    a.observed = parse_observation(text(q, 7, 20));
    a.observed_at = number(q, 8);
    bool okx = false, oky = false;
    a.x = q.value(9).toDouble(&okx);
    a.y = q.value(10).toDouble(&oky);
    if (!okx || !oky)
        throw Error("Invalid canvas position.");
    return a;
}
std::int64_t revision(Database &d) {
    if (d.scalar("PRAGMA application_id") != application_id || d.scalar("PRAGMA user_version") != 1)
        throw Error("This file is not an LMTI topology v1 database.");
    if (d.scalar("SELECT COUNT(*) FROM topology_meta") != 1)
        throw Error("Invalid topology metadata.");
    const auto rev = d.scalar("SELECT revision FROM topology_meta WHERE singleton=1");
    if (rev < 1 || rev >= 9007199254740991LL)
        throw Error("Invalid stored revision.");
    return rev;
}
void schema(Database &d) {
    // STRICT rejects silent SQLite type coercion. No migrations from memory DBs.
    d.exec("CREATE TABLE topology_meta(singleton INTEGER PRIMARY KEY CHECK(singleton=1), revision INTEGER "
           "NOT NULL CHECK(revision>=0)) STRICT");
    d.exec("INSERT INTO topology_meta VALUES(1,0)");
    d.exec("CREATE TABLE assets(id TEXT PRIMARY KEY, label TEXT NOT NULL, site TEXT NOT NULL, kind TEXT NOT "
           "NULL, privacy TEXT NOT NULL, enabled INTEGER NOT NULL CHECK(enabled IN (0,1)), poll_ms INTEGER "
           "NOT NULL CHECK(poll_ms BETWEEN 100 AND 3600000), observed TEXT NOT NULL, observed_at INTEGER NOT "
           "NULL, x REAL NOT NULL, y REAL NOT NULL) STRICT");
    d.exec("CREATE INDEX assets_site_privacy ON assets(site,privacy,id)");
    d.exec("CREATE TABLE links(id TEXT PRIMARY KEY, source TEXT NOT NULL REFERENCES assets(id), target TEXT "
           "NOT NULL REFERENCES assets(id), protocol TEXT NOT NULL, CHECK(source<>target), "
           "UNIQUE(source,target,protocol)) STRICT");
    d.exec("CREATE INDEX links_source ON links(source)");
    d.exec("CREATE INDEX links_target ON links(target)");
    d.exec("PRAGMA application_id=1280136265");
    d.exec("PRAGMA user_version=1");
}
ReadResult read(const QString &path, const std::optional<ReadScope> &scope) {
    if (scope) {
        validate_id(scope->site);
        if (!scope->asset_id.empty())
            validate_id(scope->asset_id);
        if (scope->limit < 1 || scope->limit > 200)
            throw Error("Agent context limit must be 1-200.");
    }
    Database d(path, true);
    d.exec("BEGIN");
    ReadResult result;
    auto &t = result.topology;
    t.revision = revision(d);
    QSqlQuery q(d.db);
    q.setForwardOnly(true);
    QString sql = "SELECT id,label,site,kind,privacy,enabled,poll_ms,observed,observed_at,x,y FROM assets";
    if (scope)
        sql += scope->external ? " WHERE site=? AND privacy='public'" : " WHERE site=?";
    if (scope && !scope->asset_id.empty())
        sql += " AND id=?";
    sql += " ORDER BY id LIMIT ?";
    prepare(q, sql);
    if (scope)
        q.addBindValue(QString::fromStdString(scope->site));
    if (scope && !scope->asset_id.empty())
        q.addBindValue(QString::fromStdString(scope->asset_id));
    const auto limit = scope ? scope->limit : max_assets;
    q.addBindValue(static_cast<qlonglong>(limit + 1));
    run(q);
    while (q.next()) {
        if (t.assets.size() == limit) {
            if (scope) {
                result.truncated = true;
                break;
            }
            throw Error("Too many topology assets.");
        }
        t.assets.push_back(asset(q));
    }
    if (q.lastError().isValid())
        throw Error("Cannot read topology assets.");
    q.finish();
    std::unordered_set<std::string> ids;
    for (const auto &a : t.assets)
        ids.insert(a.id);
    QString edges = "SELECT l.id,l.source,l.target,l.protocol FROM links l";
    if (scope)
        edges += " JOIN assets a ON a.id=l.source JOIN assets b ON b.id=l.target WHERE a.site=? AND b.site=?";
    if (scope && scope->external)
        edges += " AND a.privacy='public' AND b.privacy='public'";
    edges += " ORDER BY l.id LIMIT ?";
    prepare(q, edges);
    if (scope) {
        q.addBindValue(QString::fromStdString(scope->site));
        q.addBindValue(QString::fromStdString(scope->site));
    }
    q.addBindValue(static_cast<qlonglong>(max_links + 1));
    run(q);
    std::size_t count = 0;
    while (q.next()) {
        if (++count > max_links)
            throw Error("Too many topology links.");
        Link l{text(q, 0, 64), text(q, 1, 64), text(q, 2, 64), parse_protocol(text(q, 3, 20))};
        if (!scope || (ids.contains(l.from) && ids.contains(l.to))) {
            if (scope && t.links.size() == max_context_links) {
                result.truncated = true;
                break;
            }
            t.links.push_back(l);
        }
    }
    if (q.lastError().isValid())
        throw Error("Cannot read topology links.");
    q.finish();
    validate(t);
    d.exec("COMMIT");
    return result;
}
} // namespace
Topology load(const QString &path) {
    return read(path, std::nullopt).topology;
}
ReadResult read_scope(const QString &path, const ReadScope &scope) {
    return read(path, scope);
}
std::int64_t save(const QString &path, const Topology &t) {
    validate(t);
    Database d(path, false);
    d.exec("BEGIN IMMEDIATE");
    try {
        const auto tables = d.scalar("SELECT COUNT(*) FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'");
        if (tables == 0) {
            if (t.revision != 0)
                throw Error("New databases require revision zero.");
            schema(d);
        } else if (revision(d) != t.revision)
            throw Error("Revision conflict: reopen the saved topology before writing.");
        // Reject views/triggers injected into the writable schema.
        if (d.scalar("SELECT COUNT(*) FROM sqlite_schema WHERE type IN ('trigger','view')") != 0)
            throw Error("Unexpected executable schema objects.");
        d.exec("DELETE FROM links");
        d.exec("DELETE FROM assets");
        QSqlQuery q(d.db);
        prepare(q, "INSERT INTO assets VALUES(?,?,?,?,?,?,?,?,?,?,?)");
        for (const auto &a : t.assets) {
            q.bindValue(0, QString::fromStdString(a.id));
            q.bindValue(1, QString::fromStdString(a.label));
            q.bindValue(2, QString::fromStdString(a.site));
            q.bindValue(3, QString::fromStdString(name(a.kind)));
            q.bindValue(4, QString::fromStdString(name(a.privacy)));
            q.bindValue(5, a.enabled ? 1 : 0);
            q.bindValue(6, a.poll_ms);
            q.bindValue(7, QString::fromStdString(name(a.observed)));
            q.bindValue(8, static_cast<qlonglong>(a.observed_at));
            q.bindValue(9, a.x);
            q.bindValue(10, a.y);
            run(q);
        }
        prepare(q, "INSERT INTO links VALUES(?,?,?,?)");
        for (const auto &l : t.links) {
            q.bindValue(0, QString::fromStdString(l.id));
            q.bindValue(1, QString::fromStdString(l.from));
            q.bindValue(2, QString::fromStdString(l.to));
            q.bindValue(3, QString::fromStdString(name(l.protocol)));
            run(q);
        }
        prepare(q, "UPDATE topology_meta SET revision=? WHERE singleton=1");
        q.addBindValue(static_cast<qlonglong>(t.revision + 1));
        run(q);
        if (q.numRowsAffected() != 1)
            throw Error("Invalid topology metadata.");
        q.finish();
        d.exec("COMMIT");
        return t.revision + 1;
    } catch (...) {
        d.db.rollback();
        throw;
    }
}
} // namespace lmti
