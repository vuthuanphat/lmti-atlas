#include "lmti/project_store.hpp"
#include "lmti/project_desired_asset_store.hpp"
#include "project_copy_p.hpp"
#include "original_read_p.hpp"
#include "project_mapping_observation_p.hpp"
#include "../common/local_owner_path.hpp"
#include <QCryptographicHash>
#include <QElapsedTimer>
#include <QFile>
#include <QJsonArray>
#include <QJsonDocument>
#include <QDir>
#include <QFileInfo>
#include <QSqlDatabase>
#include <QSqlError>
#include <QSqlQuery>
#include <QSqlRecord>
#include <QUuid>
#include <QUrl>
#include <array>
#include <atomic>
#include <cmath>
#include <filesystem>
#include <map>
#include <set>
#include <type_traits>

namespace lmti {
#ifdef LMTI_PROJECT_RESERVATION_TEST_HOOKS
namespace detail {
thread_local ReservationTestHook reservation_test_hook = nullptr;
void set_project_reservation_test_hook(ReservationTestHook hook) { reservation_test_hook = hook; }
void reservation_test_point(ReservationTestPoint point, const QString &path) {
    if (reservation_test_hook) reservation_test_hook(point,path);
}
}
#endif
namespace {
constexpr int project_application = 0x4c4d5052, catalog_application = 0x4c4d4341;
constexpr std::size_t max_identity_records = 50000;
class Database {
    QString connection_;

  public:
    QSqlDatabase db;
    QString file_path; // Physical spelling, even when SQLite opens an encoded URI.
    bool existed;
    bool copy_budget = false;
    QElapsedTimer copy_timer;
    // Internal schema reference only. Never infer memory mode from an I/O path.
    struct InMemory {};
    explicit Database(InMemory) : existed(false) {
        connection_ = QUuid::createUuid().toString(QUuid::WithoutBraces);
        db = QSqlDatabase::addDatabase("QSQLITE",connection_);
        db.setDatabaseName(QStringLiteral(":memory:"));
        try {
            if (!db.open()) throw Error("Cannot open schema reference.");
            exec("PRAGMA trusted_schema=OFF");
            exec("PRAGMA foreign_keys=ON");
        } catch (...) {
            db.close();db={};QSqlDatabase::removeDatabase(connection_);throw;
        }
    }
    void check_copy_budget() const {
        if (copy_budget && copy_timer.hasExpired(30000))
            throw ProjectCopyError(ProjectCopyCode::BudgetExceeded);
    }
    Database(const QString &path, bool read, bool existing_write = false) {
        QFileInfo f(path);
        existed = f.exists();
        if (path.isEmpty() || path.contains(QChar(0)) || f.isSymLink() ||
            (existed && (!f.isFile() || f.size() > 64 * 1024 * 1024)) || ((read || existing_write) && !existed) ||
            !f.dir().exists())
            throw Error("Select a regular project database within size limits and an existing directory.");
        file_path = f.absoluteFilePath();
#ifdef LMTI_PROJECT_RESERVATION_TEST_HOOKS
        if (existing_write)
            detail::reservation_test_point(detail::ReservationTestPoint::BeforeExistingOpen,file_path);
#endif
        connection_ = QUuid::createUuid().toString(QUuid::WithoutBraces);
        db = QSqlDatabase::addDatabase("QSQLITE", connection_);
        if (existing_write) {
            // Qt enables SQLITE_OPEN_URI; SQLite mode=rw removes CREATE even if
            // the file disappears after preflight. Encode #, ?, % as path data.
            auto uri = QUrl::fromLocalFile(file_path);
            uri.setQuery(QStringLiteral("mode=rw"));
            db.setDatabaseName(uri.toString(QUrl::FullyEncoded));
            db.setConnectOptions("QSQLITE_OPEN_URI;QSQLITE_OPEN_NOFOLLOW;QSQLITE_BUSY_TIMEOUT=2000");
        } else {
            db.setDatabaseName(file_path);
            db.setConnectOptions(read ? "QSQLITE_OPEN_READONLY;QSQLITE_BUSY_TIMEOUT=2000"
                                      : "QSQLITE_BUSY_TIMEOUT=2000");
        }
        if (!db.open()) {
            db = {};
            QSqlDatabase::removeDatabase(connection_);
            throw Error("Cannot open project database.");
        }
        // Do not prepare even a PRAGMA on the reservation writer until its
        // read-only keeper has established the shared lock. If keeper setup
        // fails, this writer has never entered the pager/WAL read state.
        if (existing_write) return;
        try {
            exec("PRAGMA trusted_schema=OFF");
            exec("PRAGMA foreign_keys=ON");
            if (read)
                exec("PRAGMA query_only=ON");
        } catch (...) {
            db.close();
            db = {};
            QSqlDatabase::removeDatabase(connection_);
            throw;
        }
    }
    ~Database() {
        db.close();
        db = {};
        QSqlDatabase::removeDatabase(connection_);
    }
    void exec(const QString &sql) {
        check_copy_budget();
        QSqlQuery q(db);
        if (!q.exec(sql))
            throw Error("Project database operation failed.");
    }
    qint64 scalar(const QString &sql) {
        check_copy_budget();
        QSqlQuery q(db);
        if (!q.exec(sql) || !q.next())
            throw Error("Invalid project database metadata.");
        bool ok = false;
        auto n = q.value(0).toLongLong(&ok);
        if (!ok)
            throw Error("Invalid project database integer.");
        return n;
    }
    int check(int application) {
        const auto version = scalar("PRAGMA user_version");
        if (scalar("PRAGMA application_id") != application ||
            (version != 1 && !(application == project_application && (version == 2 || version == 3))) ||
            scalar("SELECT count(*) FROM sqlite_schema WHERE type IN ('trigger','view')") != 0)
            throw Error("Unsupported project schema; use the appropriate reader. No downgrade is allowed.");
        if (application == project_application && version == 1 &&
            scalar("SELECT count(*) FROM sqlite_schema WHERE type='table' AND lower(name) IN "
                   "('subsystems','component_memberships','sites','areas','environments','asset_placements','identity_registry','store_identity','proposal_format','desired_asset_receipts')") != 0)
            throw Error("Structured project tables cannot be read as schema 1.");
        return static_cast<int>(version);
    }
    std::vector<QVariantList> rows(const QString &sql, std::size_t limit = max_project_records) {
        check_copy_budget();
        QSqlQuery q(db);
        if (!q.exec(sql + " LIMIT " + QString::number(limit + 1)))
            throw Error("Invalid project table.");
        std::vector<QVariantList> result;
        while (q.next()) {
            check_copy_budget();
            if (result.size() == limit)
                throw Error("Project table exceeds record limits.");
            QVariantList row;
            for (int i = 0; i < q.record().count(); ++i) {
                auto v = q.value(i);
                if (v.metaType().id() == QMetaType::QString && v.toString().toUtf8().size() > 1024)
                    throw Error("Project cell exceeds text limit.");
                row.push_back(v);
            }
            result.push_back(row);
        }
        if (q.lastError().isValid())
            throw Error("Cannot finish reading project table.");
        return result;
    }
    // Table/column lists originate only from fixed schema code; values are bound.
    void insert(const QString &table, const QVariantList &values) {
        check_copy_budget();
        QStringList placeholders;
        for (qsizetype i = 0; i < values.size(); ++i)
            placeholders << "?";
        QSqlQuery q(db);
        if (!q.prepare("INSERT INTO " + table + " VALUES(" + placeholders.join(',') + ")"))
            throw Error("Cannot prepare project row.");
        for (const auto &v : values)
            q.addBindValue(v);
        if (!q.exec())
            throw Error("Invalid project relationship or row.");
    }
};
QString s(const std::string &v) {
    return QString::fromStdString(v);
}
QVariant ref(const std::string &v) {
    return v.empty() ? QVariant(QMetaType(QMetaType::QString)) : QVariant(s(v));
}
std::string str(const QVariantList &r, int i) {
    if (r[i].isNull())
        return {};
    if (r[i].metaType().id() != QMetaType::QString)
        throw Error("Expected a project text cell.");
    return r[i].toString().toStdString();
}
QString lineage_path(const QString &path) {
    const QFileInfo file(path);
    auto canonical = file.canonicalFilePath();
    if (canonical.isEmpty())
        canonical = QDir(file.dir().canonicalPath()).filePath(file.fileName());
    canonical = QDir::cleanPath(canonical);
#ifdef Q_OS_WIN
    canonical = canonical.toCaseFolded();
#endif
    return canonical;
}
qint64 integer(const QVariantList &r, int i) {
    auto t = r[i].metaType().id();
    if (t != QMetaType::Int && t != QMetaType::LongLong)
        throw Error("Expected a project integer cell.");
    return r[i].toLongLong();
}
double number(const QVariantList &r, int i) {
    auto t = r[i].metaType().id();
    if (t != QMetaType::Double && t != QMetaType::LongLong && t != QMetaType::Int)
        throw Error("Expected a numeric layout cell.");
    return r[i].toDouble();
}
void schema(Database &db, int version) {
    db.exec("PRAGMA application_id=1280135250"); // LMPR
    db.exec(version == 2 ? "PRAGMA user_version=2" : "PRAGMA user_version=1");
    db.exec("CREATE TABLE project(id TEXT PRIMARY KEY,label TEXT NOT NULL,goal TEXT NOT NULL,privacy TEXT "
            "NOT NULL,revision INTEGER NOT NULL CHECK(revision>=1))");
    db.exec(QString("CREATE TABLE assets(id TEXT PRIMARY KEY,label TEXT NOT NULL,site TEXT NOT NULL") +
            (version == 2 ? " REFERENCES sites(id)" : "") + ",kind TEXT NOT "
            "NULL,privacy TEXT NOT NULL,enabled INTEGER NOT NULL CHECK(enabled IN(0,1)),poll INTEGER NOT "
            "NULL,observed TEXT NOT NULL,observed_at INTEGER NOT NULL,x REAL NOT NULL,y REAL NOT NULL)");
    db.exec("CREATE TABLE links(id TEXT PRIMARY KEY,source TEXT NOT NULL REFERENCES assets(id),target TEXT "
            "NOT NULL REFERENCES assets(id),protocol TEXT NOT NULL)");
    db.exec("CREATE TABLE repositories(id TEXT PRIMARY KEY,label TEXT NOT NULL,locator TEXT NOT NULL,privacy "
            "TEXT NOT NULL)");
    db.exec("CREATE TABLE components(id TEXT PRIMARY KEY,label TEXT NOT NULL,repository_id TEXT REFERENCES "
            "repositories(id),kind TEXT NOT NULL,privacy TEXT NOT NULL)");
    db.exec("CREATE TABLE targets(id TEXT PRIMARY KEY,label TEXT NOT NULL,hardware_revision TEXT NOT "
            "NULL,architecture TEXT NOT NULL,privacy TEXT NOT NULL)");
    db.exec("CREATE TABLE releases(id TEXT PRIMARY KEY,label TEXT NOT NULL,component_id TEXT NOT NULL "
            "REFERENCES components(id),target_id TEXT REFERENCES targets(id),source_revision TEXT NOT "
            "NULL,state TEXT NOT NULL,privacy TEXT NOT NULL)");
    db.exec(
        "CREATE TABLE bindings(id TEXT PRIMARY KEY,asset_id TEXT NOT NULL REFERENCES assets(id),component_id "
        "TEXT NOT NULL REFERENCES components(id),release_id TEXT NOT NULL REFERENCES releases(id),target_id "
        "TEXT REFERENCES targets(id),privacy TEXT NOT NULL,UNIQUE(asset_id,component_id))");
    db.exec(
        "CREATE TABLE dependencies(id TEXT PRIMARY KEY,source TEXT NOT NULL REFERENCES components(id),target "
        "TEXT NOT NULL REFERENCES components(id),contract TEXT NOT NULL,privacy TEXT NOT NULL)");
    db.exec("CREATE TABLE verification(id TEXT PRIMARY KEY,release_id TEXT NOT NULL REFERENCES "
            "releases(id),asset_id TEXT REFERENCES assets(id),evidence TEXT NOT NULL,source TEXT NOT NULL,at "
            "INTEGER NOT NULL,result TEXT NOT NULL,privacy TEXT NOT NULL)");
    db.exec("CREATE TABLE milestones(id TEXT PRIMARY KEY,label TEXT NOT NULL,criteria TEXT NOT NULL,due_date "
            "TEXT NOT NULL,privacy TEXT NOT NULL,accepted INTEGER NOT NULL CHECK(accepted IN(0,1)),evidence "
            "TEXT NOT NULL)");
    db.exec("CREATE TABLE work(id TEXT PRIMARY KEY,label TEXT NOT NULL,component_id TEXT REFERENCES "
            "components(id),asset_id TEXT REFERENCES assets(id),release_id TEXT REFERENCES "
            "releases(id),milestone_id TEXT REFERENCES milestones(id),checklist TEXT NOT NULL,evidence TEXT "
            "NOT NULL,kind TEXT NOT NULL,state TEXT NOT NULL,privacy TEXT NOT NULL)");
    db.exec("CREATE TABLE knowledge(id TEXT PRIMARY KEY,label TEXT NOT NULL,component_id TEXT REFERENCES "
            "components(id),reference TEXT NOT NULL,fingerprint TEXT NOT NULL,privacy TEXT NOT NULL)");
    db.exec("CREATE INDEX asset_site ON assets(site,privacy)");
    db.exec("CREATE INDEX binding_component ON bindings(component_id)");
    db.exec("CREATE INDEX work_component ON work(component_id)");
    db.exec("CREATE INDEX work_asset ON work(asset_id)");
    db.exec("CREATE INDEX work_milestone ON work(milestone_id)");
    if (version == 2) {
        db.exec("CREATE TABLE store_identity(singleton INTEGER PRIMARY KEY CHECK(singleton=1),store_uuid TEXT NOT NULL)");
        db.exec("CREATE TABLE subsystems(id TEXT PRIMARY KEY,label TEXT NOT NULL,parent_subsystem_id TEXT "
                "REFERENCES subsystems(id) DEFERRABLE INITIALLY DEFERRED,privacy TEXT NOT NULL)");
        db.exec("CREATE TABLE component_memberships(component_id TEXT PRIMARY KEY REFERENCES components(id),"
                "subsystem_id TEXT NOT NULL REFERENCES subsystems(id))");
        db.exec("CREATE TABLE sites(id TEXT PRIMARY KEY,label TEXT NOT NULL,privacy TEXT NOT NULL)");
        db.exec("CREATE TABLE areas(id TEXT PRIMARY KEY,label TEXT NOT NULL,site_id TEXT NOT NULL REFERENCES sites(id),"
                "parent_area_id TEXT REFERENCES areas(id) DEFERRABLE INITIALLY DEFERRED,privacy TEXT NOT NULL)");
        db.exec("CREATE TABLE environments(id TEXT PRIMARY KEY,label TEXT NOT NULL,privacy TEXT NOT NULL)");
        db.exec("CREATE TABLE asset_placements(asset_id TEXT PRIMARY KEY REFERENCES assets(id),area_id TEXT REFERENCES areas(id),"
                "parent_asset_id TEXT REFERENCES asset_placements(asset_id) DEFERRABLE INITIALLY DEFERRED,"
                "environment_id TEXT REFERENCES environments(id),role TEXT CHECK(role IN('host','gateway','device')))");
        db.exec("CREATE TABLE identity_registry(kind TEXT NOT NULL CHECK(kind IN('component','asset','subsystem','site','area','environment')),"
                "entity_id TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN('active','retired')),PRIMARY KEY(kind,entity_id))");
    }
}
// Schema3 is deliberately exact; old versions retain their prior checks.
void check_receipt_schema(Database &, bool upgrading = false);
void validate_receipt_rows(Database &, const ProjectDocument * = nullptr);
void known_project_columns(Database &db, int version) {
    if (version == 3) { check_receipt_schema(db); return; }
    // Exact known columns prevent a new/partial format being treated as schema 2.
    // Metadata uses this too, without treating its success as graph validation.
    std::map<QString, QStringList> expected{
        {"project", {"id:TEXT","label:TEXT","goal:TEXT","privacy:TEXT","revision:INTEGER"}},
        {"assets", {"id:TEXT","label:TEXT","site:TEXT","kind:TEXT","privacy:TEXT","enabled:INTEGER","poll:INTEGER","observed:TEXT","observed_at:INTEGER","x:REAL","y:REAL"}},
        {"links", {"id:TEXT","source:TEXT","target:TEXT","protocol:TEXT"}},
        {"repositories", {"id:TEXT","label:TEXT","locator:TEXT","privacy:TEXT"}},
        {"components", {"id:TEXT","label:TEXT","repository_id:TEXT","kind:TEXT","privacy:TEXT"}},
        {"targets", {"id:TEXT","label:TEXT","hardware_revision:TEXT","architecture:TEXT","privacy:TEXT"}},
        {"releases", {"id:TEXT","label:TEXT","component_id:TEXT","target_id:TEXT","source_revision:TEXT","state:TEXT","privacy:TEXT"}},
        {"bindings", {"id:TEXT","asset_id:TEXT","component_id:TEXT","release_id:TEXT","target_id:TEXT","privacy:TEXT"}},
        {"dependencies", {"id:TEXT","source:TEXT","target:TEXT","contract:TEXT","privacy:TEXT"}},
        {"verification", {"id:TEXT","release_id:TEXT","asset_id:TEXT","evidence:TEXT","source:TEXT","at:INTEGER","result:TEXT","privacy:TEXT"}},
        {"milestones", {"id:TEXT","label:TEXT","criteria:TEXT","due_date:TEXT","privacy:TEXT","accepted:INTEGER","evidence:TEXT"}},
        {"work", {"id:TEXT","label:TEXT","component_id:TEXT","asset_id:TEXT","release_id:TEXT","milestone_id:TEXT","checklist:TEXT","evidence:TEXT","kind:TEXT","state:TEXT","privacy:TEXT"}},
        {"knowledge", {"id:TEXT","label:TEXT","component_id:TEXT","reference:TEXT","fingerprint:TEXT","privacy:TEXT"}},
        {"subsystems", {"id:TEXT","label:TEXT","parent_subsystem_id:TEXT","privacy:TEXT"}},
        {"component_memberships", {"component_id:TEXT","subsystem_id:TEXT"}},
        {"sites", {"id:TEXT","label:TEXT","privacy:TEXT"}},
        {"areas", {"id:TEXT","label:TEXT","site_id:TEXT","parent_area_id:TEXT","privacy:TEXT"}},
        {"environments", {"id:TEXT","label:TEXT","privacy:TEXT"}},
        {"asset_placements", {"asset_id:TEXT","area_id:TEXT","parent_asset_id:TEXT","environment_id:TEXT","role:TEXT"}},
        {"identity_registry", {"kind:TEXT","entity_id:TEXT","state:TEXT"}},
        {"store_identity", {"singleton:INTEGER","store_uuid:TEXT"}}
    };
    if (version == 1)
        for (const auto *table : {"subsystems","component_memberships","sites","areas","environments","asset_placements","identity_registry","store_identity"})
            expected.erase(QString::fromLatin1(table));
    const auto tables = db.rows("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT GLOB 'sqlite_*'", expected.size());
    if (tables.size() != expected.size())
        throw Error("Unsupported project table layout.");
    for (const auto &row : tables)
        if (!expected.contains(s(str(row, 0))))
            throw Error("Unsupported project table layout.");
    for (const auto &[table, columns] : expected) {
        const auto actual = db.rows("SELECT name,type,hidden FROM pragma_table_xinfo('" + table + "') ORDER BY cid", 32);
        if (actual.size() != static_cast<std::size_t>(columns.size()))
            throw Error("Unsupported project column layout.");
        for (std::size_t i = 0; i < actual.size(); ++i)
            if (s(str(actual[i], 0)) + ":" + s(str(actual[i], 1)) != columns[static_cast<qsizetype>(i)] || integer(actual[i], 2) != 0)
                throw Error("Unsupported project column layout.");
    }
}
void schema_two_columns(Database &db) { known_project_columns(db,2); }
using IdentityKey = std::pair<std::string, std::string>;
using IdentityRegistry = std::map<IdentityKey, bool>; // true = active, false = retired.
ProjectDocument::StorageLineage storage_lineage(Database &db, const std::string &project_id) {
    const auto rows = db.rows("SELECT singleton,store_uuid FROM store_identity", 1);
    if (rows.size() != 1 || integer(rows[0],0) != 1)
        throw Error("Invalid project store identity.");
    const auto uuid = s(str(rows[0],1));
    const QUuid parsed(uuid);
    if (parsed.isNull() || parsed.toString(QUuid::WithoutBraces) != uuid)
        throw Error("Invalid project store identity.");
    return {project_id, static_cast<int>(db.scalar("PRAGMA user_version")),
            lineage_path(db.file_path).toStdString(), uuid.toStdString()};
}
std::set<IdentityKey> active_identities(const ProjectDocument &d) {
    std::set<IdentityKey> result;
    auto add = [&](const char *kind, const auto &rows) {
        for (const auto &row : rows)
            result.emplace(kind, row.id);
    };
    add("component", d.components);
    add("asset", d.topology.assets);
    add("subsystem", d.structure->subsystems);
    add("site", d.structure->sites);
    add("area", d.structure->areas);
    add("environment", d.structure->environments);
    return result;
}
IdentityRegistry registry(Database &db, const ProjectDocument &d) {
    const auto graph = active_identities(d);
    std::set<IdentityKey> active;
    IdentityRegistry result;
    for (const auto &row : db.rows("SELECT kind,entity_id,state FROM identity_registry", max_identity_records)) {
        const auto kind = str(row, 0), id = str(row, 1), state = str(row, 2);
        if (kind != "component" && kind != "asset" && kind != "subsystem" && kind != "site" && kind != "area" && kind != "environment")
            throw Error("Invalid project identity registry.");
        validate_id(id);
        if ((state != "active" && state != "retired") || !result.emplace(IdentityKey{kind,id}, state == "active").second)
            throw Error("Invalid project identity registry.");
        if (state == "active")
            active.emplace(kind,id);
        else if (graph.contains({kind,id}))
            throw Error("Invalid project identity registry.");
    }
    if (active != graph)
        throw Error("Invalid project identity registry.");
    return result;
}
IdentityRegistry updated_registry(IdentityRegistry before, const ProjectDocument &after) {
    const auto active = active_identities(after);
    for (auto &[key, present] : before)
        if (present && !active.contains(key))
            present = false;
    for (const auto &key : active) {
        const auto found = before.find(key);
        if (found != before.end() && !found->second)
            throw Error("Retired project identity cannot be reused.");
        before[key] = true;
    }
    if (before.size() > max_identity_records)
        throw Error("Project identity registry exceeds its storage budget.");
    return before;
}
ProjectMetadata metadata(Database &db) {
    auto meta = db.rows("SELECT id,label,goal,privacy,revision FROM project", 1);
    if (meta.size() != 1)
        throw Error("Project metadata is missing.");
    auto &p = meta.front();
    ProjectMetadata result{{str(p, 0), str(p, 1), str(p, 2), parse_privacy(str(p, 3))},integer(p,4)};
    if (result.revision < 1 || result.revision >= 9007199254740991LL)
        throw Error("Invalid saved project revision.");
    validate_project_info(result.project);
    return result;
}
} // namespace
ProjectMetadata load_project_metadata(const QString &path) {
    Database db(path,true);
    db.exec("BEGIN");
    const auto version = db.check(project_application);
    if (version >= 2)
        known_project_columns(db,version);
    // Resolve every required LMPR table/column without reading graph rows. A
    // partial/unsupported container is refused; only metadata row values are
    // projected. Full graph-value/relation validation remains load_project's job.
    for(const auto *query : {
        "SELECT id,label,site,kind,privacy,enabled,poll,observed,observed_at,x,y FROM assets LIMIT 0",
        "SELECT id,source,target,protocol FROM links LIMIT 0",
        "SELECT id,label,locator,privacy FROM repositories LIMIT 0",
        "SELECT id,label,repository_id,kind,privacy FROM components LIMIT 0",
        "SELECT id,label,hardware_revision,architecture,privacy FROM targets LIMIT 0",
        "SELECT id,label,component_id,target_id,source_revision,state,privacy FROM releases LIMIT 0",
        "SELECT id,asset_id,component_id,release_id,target_id,privacy FROM bindings LIMIT 0",
        "SELECT id,source,target,contract,privacy FROM dependencies LIMIT 0",
        "SELECT id,release_id,asset_id,evidence,source,at,result,privacy FROM verification LIMIT 0",
        "SELECT id,label,criteria,due_date,privacy,accepted,evidence FROM milestones LIMIT 0",
        "SELECT id,label,component_id,asset_id,release_id,milestone_id,checklist,evidence,kind,state,privacy FROM work LIMIT 0",
        "SELECT id,label,component_id,reference,fingerprint,privacy FROM knowledge LIMIT 0"
    }) db.exec(QString::fromLatin1(query));
    const auto result=metadata(db);
    if (version == 3) validate_receipt_rows(db);
    db.exec("COMMIT");
    return result;
}
ProjectDocument read_document(Database &db, int version, IdentityRegistry *known_registry = nullptr) {
    if (version >= 2)
        known_project_columns(db,version);
    ProjectDocument d;
    const auto info=metadata(db);
    d.project=info.project;
    d.topology.revision=info.revision;
    for (const auto &r :
         db.rows("SELECT id,label,site,kind,privacy,enabled,poll,observed,observed_at,x,y FROM assets",
                 max_assets)) {
        auto enabled = integer(r, 5), poll = integer(r, 6);
        if ((enabled != 0 && enabled != 1) || poll < 100 || poll > 3600000)
            throw Error("Invalid asset configuration.");
        d.topology.assets.push_back({str(r, 0), str(r, 1), str(r, 2), parse_kind(str(r, 3)),
                                     parse_privacy(str(r, 4)), enabled == 1, static_cast<int>(poll),
                                     parse_observation(str(r, 7)), integer(r, 8), number(r, 9),
                                     number(r, 10)});
    }
    for (const auto &r : db.rows("SELECT id,source,target,protocol FROM links", max_links))
        d.topology.links.push_back({str(r, 0), str(r, 1), str(r, 2), parse_protocol(str(r, 3))});
    for (const auto &r : db.rows("SELECT id,label,locator,privacy FROM repositories"))
        d.repositories.push_back({str(r, 0), str(r, 1), str(r, 2), parse_privacy(str(r, 3))});
    for (const auto &r : db.rows("SELECT id,label,repository_id,kind,privacy FROM components"))
        d.components.push_back(
            {str(r, 0), str(r, 1), str(r, 2), component_kind(str(r, 3)), parse_privacy(str(r, 4))});
    for (const auto &r : db.rows("SELECT id,label,hardware_revision,architecture,privacy FROM targets"))
        d.targets.push_back({str(r, 0), str(r, 1), str(r, 2), str(r, 3), parse_privacy(str(r, 4))});
    for (const auto &r :
         db.rows("SELECT id,label,component_id,target_id,source_revision,state,privacy FROM releases"))
        d.releases.push_back({str(r, 0), str(r, 1), str(r, 2), str(r, 3), str(r, 4), release_state(str(r, 5)),
                              parse_privacy(str(r, 6))});
    for (const auto &r :
         db.rows("SELECT id,asset_id,component_id,release_id,target_id,privacy FROM bindings"))
        d.bindings.push_back(
            {str(r, 0), str(r, 1), str(r, 2), str(r, 3), str(r, 4), parse_privacy(str(r, 5))});
    for (const auto &r : db.rows("SELECT id,source,target,contract,privacy FROM dependencies"))
        d.dependencies.push_back({str(r, 0), str(r, 1), str(r, 2), str(r, 3), parse_privacy(str(r, 4))});
    for (const auto &r :
         db.rows("SELECT id,release_id,asset_id,evidence,source,at,result,privacy FROM verification"))
        d.verification.push_back({str(r, 0), str(r, 1), str(r, 2), str(r, 3), str(r, 4), integer(r, 5),
                                  evidence_result(str(r, 6)), parse_privacy(str(r, 7))});
    for (const auto &r :
         db.rows("SELECT id,label,criteria,due_date,privacy,accepted,evidence FROM milestones")) {
        auto accepted = integer(r, 5);
        if (accepted != 0 && accepted != 1)
            throw Error("Invalid milestone acceptance flag.");
        d.milestones.push_back(
            {str(r, 0), str(r, 1), str(r, 2), str(r, 3), parse_privacy(str(r, 4)), accepted == 1, str(r, 6)});
    }
    for (const auto &r : db.rows("SELECT "
                                 "id,label,component_id,asset_id,release_id,milestone_id,checklist,evidence,"
                                 "kind,state,privacy FROM work"))
        d.work.push_back({str(r, 0), str(r, 1), str(r, 2), str(r, 3), str(r, 4), str(r, 5), str(r, 6),
                          str(r, 7), work_kind(str(r, 8)), work_state(str(r, 9)), parse_privacy(str(r, 10))});
    for (const auto &r : db.rows("SELECT id,label,component_id,reference,fingerprint,privacy FROM knowledge"))
        d.knowledge.push_back(
            {str(r, 0), str(r, 1), str(r, 2), str(r, 3), str(r, 4), parse_privacy(str(r, 5))});
    if (version >= 2) {
        d.structure.emplace();
        d.storage_lineage = storage_lineage(db,d.project.id);
        auto &structure = *d.structure;
        for (const auto &r : db.rows("SELECT id,label,parent_subsystem_id,privacy FROM subsystems"))
            structure.subsystems.push_back({str(r,0),str(r,1),str(r,2),parse_privacy(str(r,3))});
        for (const auto &r : db.rows("SELECT component_id,subsystem_id FROM component_memberships"))
            structure.component_memberships.push_back({str(r,0),str(r,1)});
        for (const auto &r : db.rows("SELECT id,label,privacy FROM sites"))
            structure.sites.push_back({str(r,0),str(r,1),parse_privacy(str(r,2))});
        for (const auto &r : db.rows("SELECT id,label,site_id,parent_area_id,privacy FROM areas"))
            structure.areas.push_back({str(r,0),str(r,1),str(r,2),str(r,3),parse_privacy(str(r,4))});
        for (const auto &r : db.rows("SELECT id,label,privacy FROM environments"))
            structure.environments.push_back({str(r,0),str(r,1),parse_privacy(str(r,2))});
        for (const auto &r : db.rows("SELECT asset_id,area_id,parent_asset_id,environment_id,role FROM asset_placements",max_assets)) {
            AssetPlacement row{str(r,0),str(r,1),str(r,2),str(r,3),std::nullopt};
            if (!r[4].isNull()) row.role = physical_role(str(r,4));
            structure.asset_placements.push_back(row);
        }
    }
    validate(d);
    if (version >= 2) {
        const auto records = registry(db,d);
        if (known_registry) *known_registry = records;
        if (!db.rows("SELECT * FROM pragma_foreign_key_check",1).empty())
            throw Error("Invalid project relationship or registry.");
    }
    if (version == 3) validate_receipt_rows(db,&d);
    return d;
}
ProjectDocument load_project(const QString &path) {
    Database db(path, true);
    db.exec("BEGIN");
    const auto version = db.check(project_application);
    auto document = read_document(db,version);
    db.exec("COMMIT");
    return document;
}
detail::MappingObservationSnapshot detail::read_mapping_observation_on_connection(
    const QString &path, const MappingObservationScope &scope, int expected_schema) {
    try {
        if (expected_schema != 2 && expected_schema != 3)
            throw MappingObservationError(MappingObservationCode::NotSupported);
        // Namespace protection and pure request validation belong to the caller.
        // All identity, graph and registry reads below share this read snapshot.
        Database db(path,true);
        db.copy_budget = true; db.copy_timer.start();
        db.exec("BEGIN");
        const auto actual_schema = db.scalar("PRAGMA user_version");
        if (db.scalar("PRAGMA application_id") != project_application || actual_schema != expected_schema)
            throw MappingObservationError(MappingObservationCode::NotSupported);
        (void)db.check(project_application);
        const auto info = metadata(db);
        if (info.project.id != scope.project_id ||
            storage_lineage(db,info.project.id).store_uuid != scope.store_uuid)
            throw MappingObservationError(MappingObservationCode::ConfigChanged);
        if (!scope.allow_internal && info.project.privacy != Privacy::Public)
            throw MappingObservationError(MappingObservationCode::NativeUnavailable);
#ifdef LMTI_ORIGINAL_READ_TEST_HOOKS
        original_read_test_point(OriginalReadPhase::BeforeProjectContent,path);
#endif
        MappingObservationSnapshot result;
        result.document = read_document(db,static_cast<int>(actual_schema),&result.registry);
        result.storage_schema = static_cast<int>(actual_schema);
        result.timer = db.copy_timer;
        db.exec("COMMIT");
        return result;
    } catch (const MappingObservationError &) { throw; }
    catch (const DesiredAssetError &error) {
        if (error.code == DesiredAssetCode::BudgetExceeded)
            throw MappingObservationError(MappingObservationCode::BudgetExceeded);
        throw MappingObservationError(MappingObservationCode::OwnerUnavailable);
    }
    catch (const ProjectCopyError &error) {
        if (error.code == ProjectCopyCode::BudgetExceeded)
            throw MappingObservationError(MappingObservationCode::BudgetExceeded);
        throw MappingObservationError(MappingObservationCode::OwnerUnavailable);
    }
    catch (...) {
        throw MappingObservationError(MappingObservationCode::OwnerUnavailable);
    }
}
ProjectDocument detail::read_original_project(const QString &path, int expected_schema,
    const std::string &expected_project_id, const std::string &expected_store_uuid) {
    // The caller holds every original path component. Identity is checked in
    // this same read snapshot before graph rows; never reopen from a new lookup.
    Database db(path,true);
    db.exec("BEGIN");
    const auto version = db.check(project_application);
    if (version != expected_schema)
        throw OriginalProjectChanged();
    const auto info = metadata(db);
    if (info.project.id != expected_project_id)
        throw OriginalProjectChanged();
    if (version == 2 &&
        storage_lineage(db,info.project.id).store_uuid != expected_store_uuid)
        throw OriginalProjectChanged();
    if (version == 1 && !expected_store_uuid.empty())
        throw OriginalProjectChanged();
#ifdef LMTI_ORIGINAL_READ_TEST_HOOKS
    original_read_test_point(OriginalReadPhase::BeforeProjectContent,path);
#endif
    auto result = read_document(db,version);
    db.exec("COMMIT");
    return result;
}

template <typename Emit>
void visit_project_rows(const ProjectDocument &d, std::int64_t revision, Emit visitor) {
    if (d.structure) {
        const auto &structure = *d.structure;
        for (const auto &r : structure.sites)
            visitor("sites",{s(r.id),s(r.label),s(name(r.privacy))});
        for (const auto &r : structure.subsystems)
            visitor("subsystems",{s(r.id),s(r.label),ref(r.parent_subsystem_id),s(name(r.privacy))});
        for (const auto &r : structure.areas)
            visitor("areas",{s(r.id),s(r.label),s(r.site_id),ref(r.parent_area_id),s(name(r.privacy))});
        for (const auto &r : structure.environments)
            visitor("environments",{s(r.id),s(r.label),s(name(r.privacy))});
    }
    visitor("project", {s(d.project.id), s(d.project.label), s(d.project.goal),
                          s(name(d.project.privacy)), revision});
    for (const auto &r : d.topology.assets)
        visitor("assets", {s(r.id), s(r.label), s(r.site), s(name(r.kind)), s(name(r.privacy)),
                             int(r.enabled), r.poll_ms, s(name(r.observed)), r.observed_at, r.x, r.y});
    for (const auto &r : d.topology.links)
        visitor("links", {s(r.id), s(r.from), s(r.to), s(name(r.protocol))});
    for (const auto &r : d.repositories)
        visitor("repositories", {s(r.id), s(r.label), s(r.locator), s(name(r.privacy))});
    for (const auto &r : d.components)
        visitor("components",
                  {s(r.id), s(r.label), ref(r.repository_id), s(name(r.kind)), s(name(r.privacy))});
    for (const auto &r : d.targets)
        visitor("targets",
                  {s(r.id), s(r.label), s(r.hardware_revision), s(r.architecture), s(name(r.privacy))});
    for (const auto &r : d.releases)
        visitor("releases", {s(r.id), s(r.label), s(r.component_id), ref(r.target_id),
                               s(r.source_revision), s(name(r.state)), s(name(r.privacy))});
    for (const auto &r : d.bindings)
        visitor("bindings", {s(r.id), s(r.asset_id), s(r.component_id), s(r.release_id),
                               ref(r.target_id), s(name(r.privacy))});
    for (const auto &r : d.dependencies)
        visitor("dependencies", {s(r.id), s(r.from), s(r.to), s(r.contract), s(name(r.privacy))});
    for (const auto &r : d.verification)
        visitor("verification", {s(r.id), s(r.release_id), ref(r.asset_id), s(r.evidence), s(r.source),
                                   r.at, s(name(r.result)), s(name(r.privacy))});
    for (const auto &r : d.milestones)
        visitor("milestones", {s(r.id), s(r.label), s(r.criteria), s(r.due_date), s(name(r.privacy)),
                                 int(r.accepted), s(r.evidence)});
    for (const auto &r : d.work)
        visitor("work", {s(r.id), s(r.label), ref(r.component_id), ref(r.asset_id), ref(r.release_id),
                           ref(r.milestone_id), s(r.checklist), s(r.evidence), s(name(r.kind)),
                           s(name(r.state)), s(name(r.privacy))});
    for (const auto &r : d.knowledge)
        visitor("knowledge", {s(r.id), s(r.label), ref(r.component_id), s(r.reference),
                                s(r.fingerprint), s(name(r.privacy))});
    if (d.structure) {
        const auto &structure = *d.structure;
        for (const auto &r : structure.component_memberships)
            visitor("component_memberships",{s(r.component_id),s(r.subsystem_id)});
        for (const auto &r : structure.asset_placements)
            visitor("asset_placements",{s(r.asset_id),ref(r.area_id),ref(r.parent_asset_id),ref(r.environment_id),
                                         r.role ? QVariant(s(name(*r.role))) : ref("")});
    }
}
namespace {
// One private writer shared by ordinary save and the reviewed hierarchy owner.
// The caller holds the transaction and has validated the complete document and
// derived registry. No connection, COMMIT, or caller-supplied SQL escapes here.
#ifdef LMTI_PHYSICAL_HIERARCHY_OWNER_TEST_HOOKS
void physical_test_point(PhysicalHierarchyOwnerTestPoint);
#endif
void replace_project_rows(Database &db, const ProjectDocument &document, int version,
                          std::int64_t revision, const IdentityRegistry &identities) {
    if (version >= 2)
        for (const auto *table : {"component_memberships","asset_placements","subsystems","areas","environments"})
            db.exec("DELETE FROM " + QString::fromLatin1(table));
    for (const auto &table :
         {"knowledge", "work", "verification", "bindings", "dependencies", "releases", "components",
          "repositories", "targets", "milestones", "links", "assets", "project"})
        db.exec("DELETE FROM " + QString(table));
    if (version >= 2) db.exec("DELETE FROM sites");
#ifdef LMTI_PHYSICAL_HIERARCHY_OWNER_TEST_HOOKS
    // Isolated failure between actual DELETE and INSERT statements; no shipped
    // callback, alternate schema, SQL input or runtime switch exists.
    physical_test_point(PhysicalHierarchyOwnerTestPoint::DuringRowRewrite);
#endif
    visit_project_rows(document, revision,
        [&](const QString &table, const QVariantList &row) { db.insert(table,row); });
    if (version >= 2) {
        db.exec("DELETE FROM identity_registry");
        for (const auto &[key,active] : identities)
            db.insert("identity_registry",{s(key.first),s(key.second),active ? "active" : "retired"});
    }
}
}
static std::int64_t save_project_impl(const QString &path, const ProjectDocument &d,
                                    std::optional<ProjectDocument::StorageLineage> *saved_lineage = nullptr) {
    validate(d);
    if (d.storage_lineage &&
        ((d.storage_lineage->schema_version != 2 && d.storage_lineage->schema_version != 3) || d.storage_lineage->project_id != d.project.id ||
         !d.structure || d.topology.revision == 0 || !QFileInfo::exists(path) ||
         d.storage_lineage->store_path != lineage_path(path).toStdString()))
        throw Error("Copying a loaded structured project requires a registry-preserving owner operation.");
    if (!QFileInfo::exists(path) && d.topology.revision != 0)
        throw Error("A new project file requires revision zero.");
    Database db(path, false);
    db.exec("BEGIN IMMEDIATE");
    try {
        int version = d.structure ? 2 : 1;
        IdentityRegistry identities;
        if (!db.existed) {
            if (d.topology.revision != 0)
                throw Error("A new project file requires revision zero.");
            schema(db,version);
            if (version >= 2) {
                identities = updated_registry({},d);
                db.insert("store_identity", {1, QUuid::createUuid().toString(QUuid::WithoutBraces)});
            }
        } else {
            version = db.check(project_application);
            const auto before = read_document(db,version,&identities);
            if (d.storage_lineage && d.storage_lineage != before.storage_lineage)
                throw Error("Project store identity changed; reopen before editing.");
            if (before.project.id != d.project.id || before.topology.revision != d.topology.revision)
                throw Error("Project revision conflict; reopen before editing.");
            if (version == 1 && d.structure)
                throw Error("Project structure requires explicit schema migration; nothing was saved.");
            if (version >= 2 && !d.structure)
                throw Error("Project structure cannot be dropped or downgraded.");
            validate_update(before,d);
            if (version >= 2) identities = updated_registry(std::move(identities),d);
        }
        auto revision = d.topology.revision + 1;
        if (revision >= 9007199254740991LL)
            throw Error("Project revision limit exceeded.");
        replace_project_rows(db,d,version,revision,identities);
        if (version >= 2 && saved_lineage)
            *saved_lineage = storage_lineage(db,d.project.id);
        db.exec("COMMIT");
        return revision;
    } catch (...) {
        db.exec("ROLLBACK");
        throw;
    }
}
std::int64_t save_project(const QString &path, const ProjectDocument &document) {
    if (document.structure)
        throw Error("Structured saves require mutable native owner state to retain storage lineage.");
    return save_project_impl(path, document);
}
std::int64_t save_project(const QString &path, ProjectDocument &document) {
    // Prepare all potentially allocating metadata before committing. Moving the
    // prepared marker afterwards cannot fail or turn a committed write into an
    // ambiguous readback error. No registry is exposed in the domain document.
    auto lineage = document.storage_lineage;
    static_assert(std::is_nothrow_move_assignable_v<decltype(lineage)>);
    const auto revision = save_project_impl(path, document, &lineage);
    document.storage_lineage = std::move(lineage);
    return revision;
}
namespace {
void digest_field(QCryptographicHash &hash, const QByteArray &bytes) {
    hash.addData(QByteArray::number(bytes.size()));
    hash.addData(QByteArrayLiteral(":"));
    hash.addData(bytes);
}
QString owned_digest(const ProjectDocument &document) {
    std::map<QString, std::map<QString, QByteArray>> tables;
    qsizetype bytes = 0;
    visit_project_rows(document, document.topology.revision, [&](const QString &table, const QVariantList &row) {
        const auto encoded = QJsonDocument(QJsonArray::fromVariantList(row)).toJson(QJsonDocument::Compact);
        bytes += encoded.size();
        if (bytes > 64 * 1024 * 1024)
            throw ProjectCopyError(ProjectCopyCode::BudgetExceeded);
        if (!tables[table].emplace(row.front().toString(), encoded).second)
            throw ProjectCopyError(ProjectCopyCode::OwnerUnavailable);
    });
    QCryptographicHash hash(QCryptographicHash::Sha256);
    digest_field(hash,QByteArrayLiteral("lmti.project.owned-data.v1"));
    digest_field(hash,document.structure ? QByteArrayLiteral("structured") : QByteArrayLiteral("flat"));
    for (const auto &[table, rows] : tables) {
        digest_field(hash,table.toUtf8());
        digest_field(hash,QByteArray::number(static_cast<qulonglong>(rows.size())));
        for (const auto &[id,row] : rows) { digest_field(hash,id.toUtf8()); digest_field(hash,row); }
    }
    return QString::fromLatin1(hash.result().toHex());
}
QString registry_digest(const IdentityRegistry &rows) {
    QCryptographicHash hash(QCryptographicHash::Sha256);
    digest_field(hash,QByteArrayLiteral("lmti.project.identity-registry.v1"));
    for (const auto &[key,active] : rows) {
        digest_field(hash,QByteArray::fromStdString(key.first));
        digest_field(hash,QByteArray::fromStdString(key.second));
        digest_field(hash,active ? QByteArrayLiteral("active") : QByteArrayLiteral("retired"));
    }
    return QString::fromLatin1(hash.result().toHex());
}
void validate_copy_registry(const ProjectDocument &document, const IdentityRegistry &rows) {
    if (rows.size() > max_identity_records) throw ProjectCopyError(ProjectCopyCode::BudgetExceeded);
    const auto graph = active_identities(document);
    std::set<IdentityKey> active;
    for (const auto &[key,present] : rows) {
        validate_id(key.second);
        if (key.first != "asset" && key.first != "component" && key.first != "site" &&
            key.first != "subsystem" && key.first != "area" && key.first != "environment")
            throw ProjectCopyError(ProjectCopyCode::OwnerUnavailable);
        if (present) active.insert(key);
        else if (graph.contains(key)) throw ProjectCopyError(ProjectCopyCode::OwnerUnavailable);
    }
    if (active != graph) throw ProjectCopyError(ProjectCopyCode::OwnerUnavailable);
}
void copy_sidecars(const QString &path) {
    // SQLite opens these fixed neighboring files internally. Bound physical WAL
    // work as well as logical database pages, and reject redirected sidecars.
    for (const auto &[suffix,cap] : std::map<QString,qint64>{{"-wal",128*1024*1024},
            {"-journal",128*1024*1024},{"-shm",1024*1024}}) {
        const auto sidecar = detail::local_owner_path(path+suffix,false);
        const QFileInfo file(sidecar);
        if (file.exists() && file.size() > cap)
            throw ProjectCopyError(ProjectCopyCode::BudgetExceeded);
    }
}
detail::CopySnapshot capture_copy_on_connection(Database &db, const QString &canonical) {
    const auto version = db.check(project_application);
    if (version == 3) throw ProjectCopyError(ProjectCopyCode::UnsupportedSchema);
    known_project_columns(db,version); // Copy refuses unknown extension data, including v1.
    const auto pages = db.scalar("PRAGMA page_count"), size = db.scalar("PRAGMA page_size");
    if (pages < 1 || size < 512 || size > 65536 || pages > (64 * 1024 * 1024) / size)
        throw ProjectCopyError(ProjectCopyCode::BudgetExceeded);
    detail::CopySnapshot result;
    result.document = read_document(db,version,&result.registry);
    result.token = {version,s(result.document.project.id),lineage_path(canonical),
        result.document.storage_lineage ? s(result.document.storage_lineage->store_uuid) : QString{},
        result.document.topology.revision,owned_digest(result.document),registry_digest(result.registry)};
    db.check_copy_budget();
    return result;
}
std::filesystem::path native_copy_path(const QString &path) {
#ifdef Q_OS_WIN
    return std::filesystem::path(path.toStdWString());
#else
    return std::filesystem::path(QFile::encodeName(path).constData());
#endif
}
class ProjectReservation {
    // Keep the read transaction alive until the write-capable connection has
    // closed. Otherwise last-close WAL checkpointing could rewrite the source.
    std::unique_ptr<Database> keeper_, writer_;
    void release() noexcept {
        if (writer_) {
            writer_->copy_budget = false;
            try { writer_->exec("ROLLBACK"); } catch (...) {}
            writer_.reset();
        }
        if (keeper_) {
            keeper_->copy_budget = false;
            try { keeper_->exec("ROLLBACK"); } catch (...) {}
            keeper_.reset();
        }
    }
  public:
    QString path;
    detail::CopySnapshot snapshot;
    explicit ProjectReservation(const QString &canonical) : path(canonical) {
        try {
            copy_sidecars(path);
            keeper_ = std::make_unique<Database>(path,true);
            keeper_->copy_budget = true; keeper_->copy_timer.start();
            keeper_->exec("BEGIN");
            // Establish a real shared read lock before the writer touches WAL.
            // A hot rollback journal which needs writes is refused here.
            keeper_->check(project_application);
            writer_ = std::make_unique<Database>(path,false,true);
            writer_->copy_budget = true; writer_->copy_timer.start();
            writer_->exec("PRAGMA trusted_schema=OFF");
            writer_->exec("PRAGMA foreign_keys=ON");
            writer_->exec("BEGIN IMMEDIATE");
            writer_->exec("PRAGMA query_only=ON");
#ifdef LMTI_PROJECT_RESERVATION_TEST_HOOKS
            detail::reservation_test_point(detail::ReservationTestPoint::AfterBegin,path);
#endif
            snapshot = capture_copy_on_connection(*writer_,path);
            check_held();
        } catch (...) { release(); throw; }
    }
    ~ProjectReservation() { release(); }
    void check_held() const {
        writer_->check_copy_budget(); keeper_->check_copy_budget();
        if (detail::local_owner_path(path) != path)
            throw ProjectCopyError(ProjectCopyCode::SourceChanged);
        copy_sidecars(path);
    }
};
}
struct detail::HeldProjectCopies::Impl {
    QElapsedTimer timer;
    std::array<std::unique_ptr<ProjectReservation>,2> ordered;
    bool reversed = false;
    Impl(const QString &first_path, const QString &second_path) {
        timer.start();
        // Validate both lexical forms before probing either filesystem path.
        detail::local_owner_path_lexical(first_path);
        detail::local_owner_path_lexical(second_path);
        const auto first = detail::local_owner_path(first_path);
        const auto second = detail::local_owner_path(second_path);
        const auto first_key = lineage_path(first), second_key = lineage_path(second);
        std::error_code error;
        const bool alias = std::filesystem::equivalent(native_copy_path(first),native_copy_path(second),error);
        if (error) throw ProjectCopyError(ProjectCopyCode::OwnerUnavailable);
        if (first_key == second_key || alias)
            throw ProjectCopyError(ProjectCopyCode::InvalidInput);
        reversed = second_key < first_key;
        ordered[0] = std::make_unique<ProjectReservation>(reversed ? second : first);
        ordered[1] = std::make_unique<ProjectReservation>(reversed ? first : second);
    }
    ~Impl() {
        // Reverse lock order, with each keeper outliving its writer connection.
        ordered[1].reset(); ordered[0].reset();
    }
};
detail::HeldProjectCopies::HeldProjectCopies(const QString &first_path, const QString &second_path) {
    try { impl_ = std::make_unique<Impl>(first_path,second_path); check_held(); }
    catch (const ProjectCopyError &) { throw; }
    catch (const std::exception &) { throw ProjectCopyError(ProjectCopyCode::OwnerUnavailable); }
}
detail::HeldProjectCopies::~HeldProjectCopies() = default;
#ifdef LMTI_PROJECT_RESERVATION_TEST_HOOKS
void detail::test_project_reservation_existing_open(const QString &path) {
    try { Database probe(detail::local_owner_path(path),false,true); }
    catch (const std::exception &) { throw ProjectCopyError(ProjectCopyCode::OwnerUnavailable); }
}
#endif
const detail::CopySnapshot &detail::HeldProjectCopies::first() const noexcept {
    return impl_->ordered[impl_->reversed ? 1 : 0]->snapshot;
}
const detail::CopySnapshot &detail::HeldProjectCopies::second() const noexcept {
    return impl_->ordered[impl_->reversed ? 0 : 1]->snapshot;
}
void detail::HeldProjectCopies::check_held() const {
    try {
        if (impl_->timer.hasExpired(30000)) throw ProjectCopyError(ProjectCopyCode::BudgetExceeded);
        for (const auto &item : impl_->ordered) item->check_held();
    } catch (const ProjectCopyError &) { throw; }
    catch (const std::exception &) { throw ProjectCopyError(ProjectCopyCode::OwnerUnavailable); }
}
detail::CopySnapshot detail::capture_project_copy(const QString &path) {
    const auto canonical = detail::local_owner_path(path);
    copy_sidecars(canonical);
    Database db(canonical,true);
    db.copy_budget = true; db.copy_timer.start();
    db.exec("BEGIN");
    auto result = capture_copy_on_connection(db,canonical);
    db.exec("COMMIT");
    copy_sidecars(canonical);
    return result;
}
detail::CopySnapshot detail::transform_project_copy(CopySnapshot snapshot, ProjectCopyMode mode) {
    if ((mode != ProjectCopyMode::MigrateV1 && mode != ProjectCopyMode::CloneV2) ||
        (mode == ProjectCopyMode::MigrateV1 ? snapshot.token.schema != 1 : snapshot.token.schema != 2))
        throw ProjectCopyError(ProjectCopyCode::UnsupportedSchema);
    // The domain requires revision < 2^53-1, including the newly written value.
    if (snapshot.document.topology.revision >= 9007199254740990LL)
        throw ProjectCopyError(ProjectCopyCode::BudgetExceeded);
    auto &document = snapshot.document;
    if (mode == ProjectCopyMode::MigrateV1) {
        std::set<std::string> sites;
        for (const auto &asset : document.topology.assets) sites.insert(asset.site);
        if (sites.size() > max_project_records) throw ProjectCopyError(ProjectCopyCode::BudgetExceeded);
        document.structure.emplace();
        for (const auto &site : sites) document.structure->sites.push_back({site,site,Privacy::Internal});
        snapshot.registry = updated_registry({},document);
    }
    document.storage_lineage.reset(); // Only this private copy path initializes a new lineage.
    ++document.topology.revision;
    validate(document);
    validate_copy_registry(document,snapshot.registry);
    snapshot.token = {2,s(document.project.id),{}, {},document.topology.revision,
                      owned_digest(document),registry_digest(snapshot.registry)};
    return snapshot;
}
void detail::initialize_project_copy(const QString &new_path, const CopySnapshot &snapshot, const QString &new_uuid) {
    validate(snapshot.document);
    if (!snapshot.document.structure || snapshot.document.storage_lineage || snapshot.token.schema != 2 ||
        snapshot.token.project_id != s(snapshot.document.project.id) ||
        snapshot.document.topology.revision < 2 || snapshot.document.topology.revision != snapshot.token.revision ||
        snapshot.token.content_digest != owned_digest(snapshot.document) ||
        snapshot.token.registry_digest != registry_digest(snapshot.registry) || QUuid(new_uuid).isNull() ||
        QUuid(new_uuid).toString(QUuid::WithoutBraces) != new_uuid)
        throw ProjectCopyError(ProjectCopyCode::InvalidInput);
    validate_copy_registry(snapshot.document,snapshot.registry);
    detail::local_owner_path(new_path,false);
    QFile reservation(new_path);
    if (!reservation.open(QIODevice::WriteOnly | QIODevice::NewOnly))
        throw ProjectCopyError(ProjectCopyCode::OwnerUnavailable);
    reservation.close();
    Database db(new_path,false);
    db.copy_budget = true; db.copy_timer.start();
    if (db.scalar("PRAGMA page_count") != 0) throw ProjectCopyError(ProjectCopyCode::OwnerUnavailable);
    db.exec("PRAGMA journal_mode=DELETE");
    db.exec("PRAGMA synchronous=FULL");
    db.exec("BEGIN IMMEDIATE");
    try {
        schema(db,2);
        db.insert("store_identity",{1,new_uuid});
        visit_project_rows(snapshot.document,snapshot.document.topology.revision,
            [&](const QString &table,const QVariantList &row) { db.insert(table,row); });
        for (const auto &[key,active] : snapshot.registry)
            db.insert("identity_registry",{s(key.first),s(key.second),active ? "active" : "retired"});
        db.exec("COMMIT");
    } catch (...) {
        // Rollback is best effort; callers retain the reserved directory and
        // report recovery_required for every error after reservation.
        db.copy_budget = false;
        try { db.exec("ROLLBACK"); } catch (...) {}
        throw;
    }
}
namespace {
#ifdef LMTI_HIERARCHY_OWNER_TEST_HOOKS
thread_local HierarchyOwnerTestHook hierarchy_owner_test_hook = nullptr;
void hierarchy_test_point(HierarchyOwnerTestPoint point) {
    if (hierarchy_owner_test_hook) hierarchy_owner_test_hook(point);
}
#endif
[[noreturn]] void hierarchy_failure() {
    // Called only from a catch handler. Never forward SQL, filesystem paths,
    // graph contents or an arbitrary exception message through this boundary.
    try { throw; }
    catch (const HierarchyError &) { throw; }
    catch (const ProjectCopyError &error) {
        throw HierarchyError(error.code == ProjectCopyCode::BudgetExceeded
            ? HierarchyCode::BudgetExceeded : HierarchyCode::OwnerUnavailable);
    }
    catch (...) { throw HierarchyError(HierarchyCode::OwnerUnavailable); }
}
void hierarchy_single_link(const QString &path) {
    std::error_code error;
    const auto count = std::filesystem::hard_link_count(native_copy_path(path),error);
    if (error || count != 1) throw HierarchyError(HierarchyCode::OwnerUnavailable);
}
QString hierarchy_path(const QString &path) {
    // The shared helper rejects raw UNC/device/ADS/traversal before any probe,
    // then checks every ancestor and the leaf for links/junctions.
    const auto canonical = detail::local_owner_path(path);
    hierarchy_single_link(canonical);
    copy_sidecars(canonical);
    for (const auto *suffix : {"-wal","-journal","-shm"}) {
        const auto sidecar = detail::local_owner_path(canonical + QString::fromLatin1(suffix),false);
        if (QFileInfo::exists(sidecar)) hierarchy_single_link(sidecar);
    }
    return canonical;
}
QJsonArray hierarchy_subsystem(const Subsystem &row) {
    return {s(row.id),s(row.label),s(row.parent_subsystem_id),s(name(row.privacy))};
}
QJsonArray hierarchy_component(const SoftwareComponent &row) {
    return {s(row.id),s(row.label),s(row.repository_id),s(name(row.kind)),s(name(row.privacy))};
}
QString hierarchy_proposal_digest(const LogicalHierarchyScope &scope,
                                 const LogicalHierarchyProposal &proposal) {
    QJsonArray changes;
    for (const auto &change : proposal.changes) {
        changes.append(std::visit([](const auto &op) -> QJsonArray {
            using T = std::decay_t<decltype(op)>;
            if constexpr (std::is_same_v<T,AddSubsystem>)
                return {"add",hierarchy_subsystem(op.desired)};
            else if constexpr (std::is_same_v<T,RenameSubsystem>)
                return {"rename",hierarchy_subsystem(op.expected),s(op.desired_label)};
            else if constexpr (std::is_same_v<T,ReparentSubsystem>)
                return {"reparent",hierarchy_subsystem(op.expected),s(op.desired_parent_id)};
            else if constexpr (std::is_same_v<T,RetireEmptySubsystem>)
                return {"retire",hierarchy_subsystem(op.expected)};
            else {
                const QJsonValue expected = op.expected
                    ? QJsonValue(QJsonArray{s(op.expected->component_id),s(op.expected->subsystem_id)})
                    : QJsonValue(QJsonValue::Null);
                const QJsonValue desired = op.desired_subsystem_id
                    ? QJsonValue(s(*op.desired_subsystem_id)) : QJsonValue(QJsonValue::Null);
                return {"membership",hierarchy_component(op.expected_component),expected,desired};
            }
        },change));
    }
    const QJsonArray fields{QStringLiteral("lmti.logical-hierarchy.review.v1"),
        s(scope.project_id),scope.allow_logical_write,scope.allow_internal,
        s(proposal.project_id),QString::number(proposal.expected_revision),changes};
    const auto bytes = QJsonDocument(fields).toJson(QJsonDocument::Compact);
    if (bytes.size() > 32768) throw HierarchyError(HierarchyCode::BudgetExceeded);
    return QString::fromLatin1(QCryptographicHash::hash(bytes,QCryptographicHash::Sha256).toHex());
}
QString hierarchy_diff_digest(const LogicalHierarchyDiff &diff) {
    // Hash complete typed rows and all before/after ancestor paths. Per-row
    // framing keeps memory bounded without truncating a large valid review.
    QCryptographicHash hash(QCryptographicHash::Sha256);
    digest_field(hash,QByteArrayLiteral("lmti.logical-hierarchy.diff.v1"));
    const auto row = [&](const QJsonArray &fields) {
        digest_field(hash,QJsonDocument(fields).toJson(QJsonDocument::Compact));
    };
    const auto subsystem = [](const std::optional<Subsystem> &value) -> QJsonValue {
        return value ? QJsonValue(hierarchy_subsystem(*value)) : QJsonValue(QJsonValue::Null);
    };
    const auto membership = [](const std::optional<ComponentMembership> &value) -> QJsonValue {
        return value ? QJsonValue(QJsonArray{s(value->component_id),s(value->subsystem_id)})
                     : QJsonValue(QJsonValue::Null);
    };
    const auto privacy = [](const std::optional<Privacy> &value) -> QJsonValue {
        return value ? QJsonValue(s(name(*value))) : QJsonValue(QJsonValue::Null);
    };
    const auto ancestors = [](const std::vector<std::string> &values) {
        QJsonArray result;
        for (const auto &value : values) result.append(s(value));
        return result;
    };
    row({"subsystems",QString::number(static_cast<qulonglong>(diff.subsystems.size()))});
    for (const auto &value : diff.subsystems)
        row({s(value.id),subsystem(value.before),subsystem(value.after)});
    row({"memberships",QString::number(static_cast<qulonglong>(diff.memberships.size()))});
    for (const auto &value : diff.memberships)
        row({s(value.component_id),membership(value.before),membership(value.after)});
    row({"affected",QString::number(static_cast<qulonglong>(diff.affected.size()))});
    for (const auto &value : diff.affected)
        row({value.kind == HierarchyEntityKind::Subsystem ? "subsystem" : "component",
             s(value.id),privacy(value.before_classification),privacy(value.after_classification),
             ancestors(value.before_ancestors),ancestors(value.after_ancestors)});
    return QString::fromLatin1(hash.result().toHex());
}
void hierarchy_scope_shape(const LogicalHierarchyScope &scope) {
    try { validate_id(scope.project_id); }
    catch (const Error &) { throw HierarchyError(HierarchyCode::InvalidArgument); }
    if (!scope.allow_logical_write) throw HierarchyError(HierarchyCode::ScopeDenied);
}
bool hierarchy_digest_shape(const QString &value) {
    if (value.size() != 64) return false;
    for (const auto ch : value)
        if (!(ch >= QLatin1Char('0') && ch <= QLatin1Char('9')) &&
            !(ch >= QLatin1Char('a') && ch <= QLatin1Char('f'))) return false;
    return true;
}
void hierarchy_token_shape(const LogicalHierarchyScope &scope, const HierarchyReviewToken &token) {
    // This entire function is pure: in particular, do not call lineage_path()
    // or canonicalFilePath() for a caller-controlled token path.
    try {
        hierarchy_scope_shape(scope);
        if (token.scope != scope) throw HierarchyError(HierarchyCode::ScopeDenied);
        const auto &snapshot = token.snapshot;
        if (token.version != 1 || snapshot.schema != 2 ||
            snapshot.project_id != s(scope.project_id) ||
            snapshot.store_uuid.size() != 36 ||
            snapshot.revision < 1 || snapshot.revision >= 9007199254740991LL ||
            token.proposal.expected_revision != snapshot.revision ||
            !hierarchy_digest_shape(snapshot.content_digest) ||
            !hierarchy_digest_shape(snapshot.registry_digest) ||
            !hierarchy_digest_shape(token.proposal_digest) ||
            !hierarchy_digest_shape(token.diff_digest))
            throw HierarchyError(HierarchyCode::InvalidArgument);
        const QUuid uuid(snapshot.store_uuid);
        if (uuid.isNull() || uuid.toString(QUuid::WithoutBraces) != snapshot.store_uuid)
            throw HierarchyError(HierarchyCode::InvalidArgument);
        auto key = detail::local_owner_path_lexical(snapshot.canonical_path);
#ifdef Q_OS_WIN
        key = key.toCaseFolded();
#endif
        if (key != snapshot.canonical_path)
            throw HierarchyError(HierarchyCode::InvalidArgument);
        const auto normalized = normalize_logical_hierarchy_proposal(scope,token.proposal);
        if (normalized != token.proposal ||
            hierarchy_proposal_digest(scope,normalized) != token.proposal_digest)
            throw HierarchyError(HierarchyCode::InvalidArgument);
        if (snapshot.revision >= 9007199254740990LL)
            throw HierarchyError(HierarchyCode::BudgetExceeded);
    } catch (const HierarchyError &) {
        throw;
    } catch (const Error &) {
        throw HierarchyError(HierarchyCode::InvalidArgument);
    }
}
IdentityRegistry hierarchy_registry(const IdentityRegistry &before, const ProjectDocument &after) {
    const auto active = active_identities(after);
    std::size_t additional = 0;
    for (const auto &key : active) {
        const auto found = before.find(key);
        if (found == before.end()) ++additional;
        else if (!found->second) throw HierarchyError(HierarchyCode::Conflict);
    }
    if (before.size() > max_identity_records ||
        additional > max_identity_records - before.size())
        throw HierarchyError(HierarchyCode::BudgetExceeded);
    return updated_registry(before,after);
}
detail::CopySnapshot hierarchy_snapshot(Database &db, const QString &canonical) {
    if (db.check(project_application) != 2) throw HierarchyError(HierarchyCode::Unsupported);
    // Capture only: no copy transform, increment or library operation. This
    // includes all typed rows, exact schema, UUID and the private full registry.
    return capture_copy_on_connection(db,canonical);
}
void hierarchy_revision(const detail::CopySnapshot &snapshot) {
    if (snapshot.token.revision >= 9007199254740990LL)
        throw HierarchyError(HierarchyCode::BudgetExceeded);
}
}
struct HierarchyReview::Data {
    const ProjectCopyToken snapshot;
    const LogicalHierarchyScope scope;
    const LogicalHierarchyProposal proposal;
    const QString proposal_digest;
    const LogicalHierarchyDiff diff;
    std::atomic_bool consumed{false};
    Data(ProjectCopyToken token, LogicalHierarchyScope authority, LogicalHierarchyProposal batch,
         QString digest, LogicalHierarchyDiff changes)
        : snapshot(std::move(token)), scope(std::move(authority)), proposal(std::move(batch)),
          proposal_digest(std::move(digest)), diff(std::move(changes)) {}
};
HierarchyReview::HierarchyReview(std::shared_ptr<Data> data) : data_(std::move(data)) {}
const LogicalHierarchyProposal &HierarchyReview::proposal() const {
    if (!data_) throw HierarchyError(HierarchyCode::InvalidArgument);
    return data_->proposal;
}
const LogicalHierarchyDiff &HierarchyReview::diff() const {
    if (!data_) throw HierarchyError(HierarchyCode::InvalidArgument);
    return data_->diff;
}
std::int64_t HierarchyReview::reviewed_revision() const {
    if (!data_) throw HierarchyError(HierarchyCode::InvalidArgument);
    return data_->snapshot.revision;
}
#ifdef LMTI_HIERARCHY_OWNER_TEST_HOOKS
void set_hierarchy_owner_test_hook(HierarchyOwnerTestHook hook) { hierarchy_owner_test_hook = hook; }
#endif
HierarchyReview preview_logical_hierarchy(const QString &path, const LogicalHierarchyScope &scope,
                                         const LogicalHierarchyProposal &proposal) {
    try {
        auto normalized = normalize_logical_hierarchy_proposal(scope,proposal);
        auto digest = hierarchy_proposal_digest(scope,normalized);
        const auto canonical = hierarchy_path(path);
        Database db(canonical,true);
        db.copy_budget = true; db.copy_timer.start();
        db.exec("BEGIN");
        auto snapshot = hierarchy_snapshot(db,canonical);
        hierarchy_revision(snapshot);
        auto transition = apply_logical_hierarchy(snapshot.document,scope,normalized);
        (void)hierarchy_registry(snapshot.registry,transition.document);
        auto reviewed = std::make_shared<HierarchyReview::Data>(std::move(snapshot.token),scope,
            std::move(normalized),std::move(digest),std::move(transition.diff));
        if (lineage_path(hierarchy_path(path)) != reviewed->snapshot.canonical_path)
            throw HierarchyError(HierarchyCode::Conflict);
        db.exec("COMMIT");
        return HierarchyReview(std::move(reviewed));
    } catch (...) { hierarchy_failure(); }
}
HierarchyReviewToken export_logical_hierarchy_review(const HierarchyReview &review) {
    try {
        if (!review.data_) throw HierarchyError(HierarchyCode::InvalidArgument);
        const auto &data = *review.data_;
        if (data.consumed.load()) throw HierarchyError(HierarchyCode::Conflict);
        HierarchyReviewToken result{1,data.snapshot,data.scope,data.proposal,
                                    data.proposal_digest,hierarchy_diff_digest(data.diff)};
        hierarchy_token_shape(data.scope,result);
        // Export linearizes at this final check. A token exported before a
        // concurrent consume is not a cross-process one-use capability.
        if (data.consumed.load()) throw HierarchyError(HierarchyCode::Conflict);
        return result;
    } catch (...) { hierarchy_failure(); }
}
HierarchyReview restore_logical_hierarchy_review(const QString &path,
    const LogicalHierarchyScope &scope, const HierarchyReviewToken &token) {
    try {
        hierarchy_token_shape(scope,token); // Complete validation before any filesystem probe.
        const auto canonical = hierarchy_path(path);
        if (lineage_path(canonical) != token.snapshot.canonical_path)
            throw HierarchyError(HierarchyCode::Conflict);
        Database db(canonical,true);
        db.copy_budget = true; db.copy_timer.start();
        db.exec("BEGIN");
        const auto snapshot = hierarchy_snapshot(db,canonical);
        if (snapshot.token != token.snapshot) throw HierarchyError(HierarchyCode::Conflict);
        hierarchy_revision(snapshot);
        auto transition = apply_logical_hierarchy(snapshot.document,scope,token.proposal);
        (void)hierarchy_registry(snapshot.registry,transition.document);
        if (hierarchy_diff_digest(transition.diff) != token.diff_digest)
            throw HierarchyError(HierarchyCode::Conflict);
        // Retain the supplied original pins; equality above is not permission
        // to issue a freshly reviewed token for changed state.
        auto restored = std::make_shared<HierarchyReview::Data>(token.snapshot,token.scope,
            token.proposal,token.proposal_digest,std::move(transition.diff));
        if (lineage_path(hierarchy_path(path)) != token.snapshot.canonical_path)
            throw HierarchyError(HierarchyCode::Conflict);
        db.exec("COMMIT");
        return HierarchyReview(std::move(restored));
    } catch (...) { hierarchy_failure(); }
}
HierarchyState inspect_logical_hierarchy(const QString &path, const LogicalHierarchyScope &scope) {
    try {
        hierarchy_scope_shape(scope);
        const auto canonical = hierarchy_path(path);
        Database db(canonical,true);
        db.copy_budget = true; db.copy_timer.start();
        db.exec("BEGIN");
        auto snapshot = hierarchy_snapshot(db,canonical);
        auto projection = project_logical_hierarchy(snapshot.document,scope);
        HierarchyState result{std::move(snapshot.token),std::move(projection)};
        if (lineage_path(hierarchy_path(path)) != result.snapshot.canonical_path)
            throw HierarchyError(HierarchyCode::Conflict);
        db.exec("COMMIT");
        return result;
    } catch (...) { hierarchy_failure(); }
}
HierarchyState detail::read_original_hierarchy(const QString &path,
    const LogicalHierarchyScope &scope,const std::string &expected_store_uuid) {
    try {
        hierarchy_scope_shape(scope);
        // The caller retains the original namespace. Check immutable identity
        // before graph content, in this same transaction used for full capture.
        Database db(path,true);
        db.copy_budget = true; db.copy_timer.start();
        db.exec("BEGIN");
        if (db.check(project_application) != 2) throw OriginalProjectChanged();
        const auto info = metadata(db);
        if (info.project.id != scope.project_id ||
            storage_lineage(db,info.project.id).store_uuid != expected_store_uuid)
            throw OriginalProjectChanged();
#ifdef LMTI_ORIGINAL_READ_TEST_HOOKS
        original_read_test_point(OriginalReadPhase::BeforeProjectContent,path);
#endif
        auto snapshot = hierarchy_snapshot(db,path);
        auto projection = project_logical_hierarchy(snapshot.document,scope);
        HierarchyState result{std::move(snapshot.token),std::move(projection)};
        db.exec("COMMIT");
        return result;
    } catch (const OriginalProjectChanged &) { throw; }
    catch (...) { hierarchy_failure(); }
}
HierarchyCommitResult commit_logical_hierarchy(const QString &path, const LogicalHierarchyScope &scope,
                                               const HierarchyReview &review) {
    try {
        if (!review.data_) throw HierarchyError(HierarchyCode::InvalidArgument);
        const auto &data = *review.data_;
        if (scope != data.scope) throw HierarchyError(HierarchyCode::ScopeDenied);
        const auto normalized = normalize_logical_hierarchy_proposal(scope,data.proposal);
        if (normalized != data.proposal ||
            hierarchy_proposal_digest(scope,normalized) != data.proposal_digest)
            throw HierarchyError(HierarchyCode::Conflict);
        if (data.consumed.load()) throw HierarchyError(HierarchyCode::Conflict);
        const auto canonical = hierarchy_path(path);
        if (lineage_path(canonical) != data.snapshot.canonical_path)
            throw HierarchyError(HierarchyCode::Conflict);

        // A read-only keeper prevents a refused writer's last-close WAL
        // checkpoint from rewriting the source. It is released before a real
        // COMMIT so rollback-journal mode can obtain its exclusive commit lock.
        auto keeper = std::make_unique<Database>(canonical,true);
        keeper->copy_budget = true; keeper->copy_timer.start();
        keeper->exec("BEGIN");
        keeper->check(project_application);
        Database db(canonical,false,true); // Existing-only encoded mode=rw URI.
        db.copy_budget = true; db.copy_timer.start();
        db.exec("PRAGMA trusted_schema=OFF");
        db.exec("PRAGMA foreign_keys=ON");
        db.exec("BEGIN IMMEDIATE");
        bool mutation_started = false, commit_attempted = false;
        try {
            const auto snapshot = hierarchy_snapshot(db,canonical);
            if (snapshot.token != data.snapshot) throw HierarchyError(HierarchyCode::Conflict);
            hierarchy_revision(snapshot);
            auto transition = apply_logical_hierarchy(snapshot.document,scope,normalized);
            if (transition.diff != data.diff) throw HierarchyError(HierarchyCode::Conflict);
            const auto identities = hierarchy_registry(snapshot.registry,transition.document);
            // Trivial known-result construction and all allocating validation
            // happen before COMMIT. No readback or payload allocation follows.
            const HierarchyCommitResult success{HierarchyCommitState::Committed,snapshot.token.revision+1};
            if (lineage_path(hierarchy_path(path)) != data.snapshot.canonical_path)
                throw HierarchyError(HierarchyCode::Conflict);
            bool expected = false;
            if (!review.data_->consumed.compare_exchange_strong(expected,true))
                throw HierarchyError(HierarchyCode::Conflict);
            mutation_started = true;
            replace_project_rows(db,transition.document,2,success.revision,identities);
#ifdef LMTI_HIERARCHY_OWNER_TEST_HOOKS
            hierarchy_test_point(HierarchyOwnerTestPoint::BeforeCommit);
#endif
            if (lineage_path(hierarchy_path(path)) != data.snapshot.canonical_path)
                throw HierarchyError(HierarchyCode::Conflict);
            keeper->copy_budget = false;
            keeper->exec("ROLLBACK");
            keeper.reset();
            commit_attempted = true;
            db.exec("COMMIT");
#ifdef LMTI_HIERARCHY_OWNER_TEST_HOOKS
            // An isolated lost-response seam; the production target has no
            // operation at this point which can demote a known committed result.
            hierarchy_test_point(HierarchyOwnerTestPoint::AfterCommit);
#endif
            return success;
        } catch (...) {
            db.copy_budget = false;
            bool rollback_failed = false;
            try { db.exec("ROLLBACK"); } catch (...) { rollback_failed = true; }
            if (commit_attempted || (mutation_started && rollback_failed))
                return {HierarchyCommitState::Unknown,0};
            hierarchy_failure();
        }
    } catch (...) { hierarchy_failure(); }
}
namespace {
#ifdef LMTI_PHYSICAL_HIERARCHY_OWNER_TEST_HOOKS
thread_local PhysicalHierarchyOwnerTestHook physical_owner_test_hook = nullptr;
void physical_test_point(PhysicalHierarchyOwnerTestPoint point) {
    if (physical_owner_test_hook) physical_owner_test_hook(point);
}
#endif
[[noreturn]] void physical_failure() {
    // Shared storage primitives retain logical errors internally. Translate
    // every explicit code, never enum-cast or leak their exception messages.
    try { throw; }
    catch (const PhysicalHierarchyError &) { throw; }
    catch (const HierarchyError &error) {
        switch (error.code()) {
        case HierarchyCode::InvalidArgument: throw PhysicalHierarchyError(PhysicalHierarchyCode::InvalidArgument);
        case HierarchyCode::ScopeDenied: throw PhysicalHierarchyError(PhysicalHierarchyCode::ScopeDenied);
        case HierarchyCode::Conflict: throw PhysicalHierarchyError(PhysicalHierarchyCode::Conflict);
        case HierarchyCode::Unsupported: throw PhysicalHierarchyError(PhysicalHierarchyCode::Unsupported);
        case HierarchyCode::BudgetExceeded: throw PhysicalHierarchyError(PhysicalHierarchyCode::BudgetExceeded);
        case HierarchyCode::OwnerUnavailable: throw PhysicalHierarchyError(PhysicalHierarchyCode::OwnerUnavailable);
        }
        throw PhysicalHierarchyError(PhysicalHierarchyCode::OwnerUnavailable);
    }
    catch (const ProjectCopyError &error) {
        throw PhysicalHierarchyError(error.code == ProjectCopyCode::BudgetExceeded
            ? PhysicalHierarchyCode::BudgetExceeded : PhysicalHierarchyCode::OwnerUnavailable);
    }
    catch (...) { throw PhysicalHierarchyError(PhysicalHierarchyCode::OwnerUnavailable); }
}
QJsonArray physical_site(const Site &r) { return {s(r.id),s(r.label),s(name(r.privacy))}; }
QJsonArray physical_area(const Area &r) {
    return {s(r.id),s(r.label),s(r.site_id),s(r.parent_area_id),s(name(r.privacy))};
}
QJsonArray physical_environment(const Environment &r) { return {s(r.id),s(r.label),s(name(r.privacy))}; }
QJsonArray physical_anchor(const PhysicalAssetAnchor &r) {
    return {s(r.id),s(r.label),s(r.site),s(name(r.kind)),s(name(r.privacy))};
}
QJsonValue physical_placement(const std::optional<AssetPlacement> &r) {
    if (!r) return QJsonValue(QJsonValue::Null);
    const QJsonValue role = r->role ? QJsonValue(s(name(*r->role))) : QJsonValue(QJsonValue::Null);
    return QJsonArray{s(r->asset_id),s(r->area_id),s(r->parent_asset_id),s(r->environment_id),role};
}
QString physical_proposal_digest(const PhysicalHierarchyScope &scope,
                                 const PhysicalHierarchyProposal &proposal) {
    QJsonArray changes;
    for (const auto &change : proposal.changes) {
        changes.append(std::visit([](const auto &op) -> QJsonArray {
            using T = std::decay_t<decltype(op)>;
            if constexpr (std::is_same_v<T,AddSite>) return {"add_site",physical_site(op.desired)};
            else if constexpr (std::is_same_v<T,RenameSite>)
                return {"rename_site",physical_site(op.expected),s(op.desired_label)};
            else if constexpr (std::is_same_v<T,RetireEmptySite>) return {"retire_site",physical_site(op.expected)};
            else if constexpr (std::is_same_v<T,AddArea>) return {"add_area",physical_area(op.desired)};
            else if constexpr (std::is_same_v<T,RenameArea>)
                return {"rename_area",physical_area(op.expected),s(op.desired_label)};
            else if constexpr (std::is_same_v<T,ReparentArea>)
                return {"reparent_area",physical_area(op.expected),s(op.desired_parent_id)};
            else if constexpr (std::is_same_v<T,RetireEmptyArea>) return {"retire_area",physical_area(op.expected)};
            else if constexpr (std::is_same_v<T,AddEnvironment>) return {"add_environment",physical_environment(op.desired)};
            else if constexpr (std::is_same_v<T,RenameEnvironment>)
                return {"rename_environment",physical_environment(op.expected),s(op.desired_label)};
            else if constexpr (std::is_same_v<T,RetireEmptyEnvironment>)
                return {"retire_environment",physical_environment(op.expected)};
            else return {"placement",physical_anchor(op.expected_asset),
                         physical_placement(op.expected),physical_placement(op.desired)};
        },change));
    }
    const QJsonArray fields{QStringLiteral("lmti.physical-hierarchy.review.v1"),
        s(scope.project_id),scope.allow_physical_write,scope.allow_internal,
        s(proposal.project_id),QString::number(proposal.expected_revision),changes};
    const auto bytes = QJsonDocument(fields).toJson(QJsonDocument::Compact);
    if (bytes.size() > static_cast<qsizetype>(max_physical_hierarchy_request_bytes))
        throw PhysicalHierarchyError(PhysicalHierarchyCode::BudgetExceeded);
    return QString::fromLatin1(QCryptographicHash::hash(bytes,QCryptographicHash::Sha256).toHex());
}
QString physical_diff_digest(const PhysicalHierarchyDiff &diff) {
    QCryptographicHash hash(QCryptographicHash::Sha256);
    digest_field(hash,QByteArrayLiteral("lmti.physical-hierarchy.diff.v1"));
    const auto row = [&](const QJsonArray &fields) {
        digest_field(hash,QJsonDocument(fields).toJson(QJsonDocument::Compact));
    };
    const auto value = [](const auto &v, const auto &encode) -> QJsonValue {
        return v ? QJsonValue(encode(*v)) : QJsonValue(QJsonValue::Null);
    };
    const auto privacy = [](const std::optional<Privacy> &v) -> QJsonValue {
        return v ? QJsonValue(s(name(*v))) : QJsonValue(QJsonValue::Null);
    };
    const auto path = [](const PhysicalHierarchyPath &v) {
        QJsonArray areas,assets;
        for (const auto &id : v.area_ancestors) areas.append(s(id));
        for (const auto &id : v.asset_ancestors) assets.append(s(id));
        return QJsonArray{s(v.site_id),areas,assets,s(v.environment_id)};
    };
    row({"sites",QString::number(static_cast<qulonglong>(diff.sites.size()))});
    for (const auto &r : diff.sites)
        row({s(r.id),value(r.before,physical_site),value(r.after,physical_site)});
    row({"areas",QString::number(static_cast<qulonglong>(diff.areas.size()))});
    for (const auto &r : diff.areas)
        row({s(r.id),value(r.before,physical_area),value(r.after,physical_area)});
    row({"environments",QString::number(static_cast<qulonglong>(diff.environments.size()))});
    for (const auto &r : diff.environments)
        row({s(r.id),value(r.before,physical_environment),value(r.after,physical_environment)});
    row({"placements",QString::number(static_cast<qulonglong>(diff.placements.size()))});
    for (const auto &r : diff.placements)
        row({s(r.asset_id),physical_placement(r.before),physical_placement(r.after)});
    row({"affected",QString::number(static_cast<qulonglong>(diff.affected.size()))});
    for (const auto &r : diff.affected) {
        QString kind;
        switch (r.kind) {
        case PhysicalHierarchyEntityKind::Site: kind = "site"; break;
        case PhysicalHierarchyEntityKind::Area: kind = "area"; break;
        case PhysicalHierarchyEntityKind::Environment: kind = "environment"; break;
        case PhysicalHierarchyEntityKind::Asset: kind = "asset"; break;
        default: throw PhysicalHierarchyError(PhysicalHierarchyCode::InvalidArgument);
        }
        row({kind,s(r.id),privacy(r.before_classification),privacy(r.after_classification),
             path(r.before_path),path(r.after_path)});
    }
    return QString::fromLatin1(hash.result().toHex());
}
void physical_scope_shape(const PhysicalHierarchyScope &scope) {
    try { validate_id(scope.project_id); }
    catch (const Error &) { throw PhysicalHierarchyError(PhysicalHierarchyCode::InvalidArgument); }
    if (!scope.allow_physical_write) throw PhysicalHierarchyError(PhysicalHierarchyCode::ScopeDenied);
}
void physical_token_shape(const PhysicalHierarchyScope &scope, const PhysicalHierarchyReviewToken &token) {
    // Pure lexical/token checks: no canonicalFilePath, file open or path probe.
    try {
        physical_scope_shape(scope);
        if (token.scope != scope) throw PhysicalHierarchyError(PhysicalHierarchyCode::ScopeDenied);
        const auto &snapshot = token.snapshot;
        if (token.version != 1 || token.domain != QStringLiteral("lmti.physical-hierarchy.review.v1") ||
            snapshot.schema != 2 || snapshot.project_id != s(scope.project_id) ||
            snapshot.store_uuid.size() != 36 ||
            snapshot.revision < 1 || snapshot.revision >= 9007199254740991LL ||
            token.proposal.expected_revision != snapshot.revision ||
            !hierarchy_digest_shape(snapshot.content_digest) || !hierarchy_digest_shape(snapshot.registry_digest) ||
            !hierarchy_digest_shape(token.proposal_digest) || !hierarchy_digest_shape(token.diff_digest))
            throw PhysicalHierarchyError(PhysicalHierarchyCode::InvalidArgument);
        const QUuid uuid(snapshot.store_uuid);
        if (uuid.isNull() || uuid.toString(QUuid::WithoutBraces) != snapshot.store_uuid)
            throw PhysicalHierarchyError(PhysicalHierarchyCode::InvalidArgument);
        auto key = detail::local_owner_path_lexical(snapshot.canonical_path);
#ifdef Q_OS_WIN
        key = key.toCaseFolded();
#endif
        if (key != snapshot.canonical_path) throw PhysicalHierarchyError(PhysicalHierarchyCode::InvalidArgument);
        const auto normalized = normalize_physical_hierarchy_proposal(scope,token.proposal);
        if (normalized != token.proposal || physical_proposal_digest(scope,normalized) != token.proposal_digest)
            throw PhysicalHierarchyError(PhysicalHierarchyCode::InvalidArgument);
        if (snapshot.revision >= 9007199254740990LL)
            throw PhysicalHierarchyError(PhysicalHierarchyCode::BudgetExceeded);
    } catch (const PhysicalHierarchyError &) { throw; }
    catch (const Error &) { throw PhysicalHierarchyError(PhysicalHierarchyCode::InvalidArgument); }
}
}
struct PhysicalHierarchyReview::Data {
    const ProjectCopyToken snapshot;
    const PhysicalHierarchyScope scope;
    const PhysicalHierarchyProposal proposal;
    const QString proposal_digest;
    const PhysicalHierarchyDiff diff;
    std::atomic_bool consumed{false};
    Data(ProjectCopyToken token, PhysicalHierarchyScope authority, PhysicalHierarchyProposal batch,
         QString digest, PhysicalHierarchyDiff changes)
        : snapshot(std::move(token)), scope(std::move(authority)), proposal(std::move(batch)),
          proposal_digest(std::move(digest)), diff(std::move(changes)) {}
};
PhysicalHierarchyReview::PhysicalHierarchyReview(std::shared_ptr<Data> data) : data_(std::move(data)) {}
const PhysicalHierarchyProposal &PhysicalHierarchyReview::proposal() const {
    if (!data_) throw PhysicalHierarchyError(PhysicalHierarchyCode::InvalidArgument);
    return data_->proposal;
}
const PhysicalHierarchyDiff &PhysicalHierarchyReview::diff() const {
    if (!data_) throw PhysicalHierarchyError(PhysicalHierarchyCode::InvalidArgument);
    return data_->diff;
}
std::int64_t PhysicalHierarchyReview::reviewed_revision() const {
    if (!data_) throw PhysicalHierarchyError(PhysicalHierarchyCode::InvalidArgument);
    return data_->snapshot.revision;
}
#ifdef LMTI_PHYSICAL_HIERARCHY_OWNER_TEST_HOOKS
void set_physical_hierarchy_owner_test_hook(PhysicalHierarchyOwnerTestHook hook) {
    physical_owner_test_hook = hook;
}
#endif
PhysicalHierarchyReview preview_physical_hierarchy(const QString &path, const PhysicalHierarchyScope &scope,
                                                   const PhysicalHierarchyProposal &proposal) {
    try {
        auto normalized = normalize_physical_hierarchy_proposal(scope,proposal);
        auto digest = physical_proposal_digest(scope,normalized);
        const auto canonical = hierarchy_path(path);
        Database db(canonical,true);
        db.copy_budget = true; db.copy_timer.start();
        db.exec("BEGIN");
        auto snapshot = hierarchy_snapshot(db,canonical);
        hierarchy_revision(snapshot);
        auto transition = apply_physical_hierarchy(snapshot.document,scope,normalized);
        (void)hierarchy_registry(snapshot.registry,transition.document);
        auto reviewed = std::make_shared<PhysicalHierarchyReview::Data>(std::move(snapshot.token),scope,
            std::move(normalized),std::move(digest),std::move(transition.diff));
        if (lineage_path(hierarchy_path(path)) != reviewed->snapshot.canonical_path)
            throw PhysicalHierarchyError(PhysicalHierarchyCode::Conflict);
        db.exec("COMMIT");
        return PhysicalHierarchyReview(std::move(reviewed));
    } catch (...) { physical_failure(); }
}
PhysicalHierarchyReviewToken export_physical_hierarchy_review(const PhysicalHierarchyReview &review) {
    try {
        if (!review.data_) throw PhysicalHierarchyError(PhysicalHierarchyCode::InvalidArgument);
        const auto &data = *review.data_;
        if (data.consumed.load()) throw PhysicalHierarchyError(PhysicalHierarchyCode::Conflict);
        PhysicalHierarchyReviewToken result{1,QStringLiteral("lmti.physical-hierarchy.review.v1"),
            data.snapshot,data.scope,data.proposal,data.proposal_digest,physical_diff_digest(data.diff)};
        physical_token_shape(data.scope,result);
        if (data.consumed.load()) throw PhysicalHierarchyError(PhysicalHierarchyCode::Conflict);
        return result;
    } catch (...) { physical_failure(); }
}
PhysicalHierarchyReview restore_physical_hierarchy_review(const QString &path,
    const PhysicalHierarchyScope &scope, const PhysicalHierarchyReviewToken &token) {
    try {
        physical_token_shape(scope,token);
        const auto canonical = hierarchy_path(path);
        if (lineage_path(canonical) != token.snapshot.canonical_path)
            throw PhysicalHierarchyError(PhysicalHierarchyCode::Conflict);
        Database db(canonical,true);
        db.copy_budget = true; db.copy_timer.start();
        db.exec("BEGIN");
        const auto snapshot = hierarchy_snapshot(db,canonical);
        if (snapshot.token != token.snapshot) throw PhysicalHierarchyError(PhysicalHierarchyCode::Conflict);
        hierarchy_revision(snapshot);
        auto transition = apply_physical_hierarchy(snapshot.document,scope,token.proposal);
        (void)hierarchy_registry(snapshot.registry,transition.document);
        if (physical_diff_digest(transition.diff) != token.diff_digest)
            throw PhysicalHierarchyError(PhysicalHierarchyCode::Conflict);
        auto restored = std::make_shared<PhysicalHierarchyReview::Data>(token.snapshot,token.scope,
            token.proposal,token.proposal_digest,std::move(transition.diff));
        if (lineage_path(hierarchy_path(path)) != token.snapshot.canonical_path)
            throw PhysicalHierarchyError(PhysicalHierarchyCode::Conflict);
        db.exec("COMMIT");
        return PhysicalHierarchyReview(std::move(restored));
    } catch (...) { physical_failure(); }
}
PhysicalHierarchyState inspect_physical_hierarchy(const QString &path, const PhysicalHierarchyScope &scope) {
    try {
        physical_scope_shape(scope);
        const auto canonical = hierarchy_path(path);
        Database db(canonical,true);
        db.copy_budget = true; db.copy_timer.start();
        db.exec("BEGIN");
        auto snapshot = hierarchy_snapshot(db,canonical);
        auto projection = project_physical_hierarchy(snapshot.document,scope);
        PhysicalHierarchyState result{std::move(snapshot.token),std::move(projection)};
        if (lineage_path(hierarchy_path(path)) != result.snapshot.canonical_path)
            throw PhysicalHierarchyError(PhysicalHierarchyCode::Conflict);
        db.exec("COMMIT");
        return result;
    } catch (...) { physical_failure(); }
}
PhysicalHierarchyState detail::read_original_physical_hierarchy(const QString &path,
    const PhysicalHierarchyScope &scope,const std::string &expected_store_uuid) {
    try {
        physical_scope_shape(scope);
        // The caller retains the original namespace. One read transaction
        // validates immutable identity before capturing any graph content.
        Database db(path,true);
        db.copy_budget = true; db.copy_timer.start();
        db.exec("BEGIN");
        if (db.check(project_application) != 2) throw OriginalProjectChanged();
        const auto info = metadata(db);
        if (info.project.id != scope.project_id ||
            storage_lineage(db,info.project.id).store_uuid != expected_store_uuid)
            throw OriginalProjectChanged();
#ifdef LMTI_ORIGINAL_READ_TEST_HOOKS
        original_read_test_point(OriginalReadPhase::BeforeProjectContent,path);
#endif
        auto snapshot = hierarchy_snapshot(db,path);
        auto projection = project_physical_hierarchy(snapshot.document,scope);
        PhysicalHierarchyState result{std::move(snapshot.token),std::move(projection)};
        db.exec("COMMIT");
        return result;
    } catch (const OriginalProjectChanged &) { throw; }
    catch (...) { physical_failure(); }
}
PhysicalHierarchyCommitResult commit_physical_hierarchy(const QString &path,
    const PhysicalHierarchyScope &scope, const PhysicalHierarchyReview &review) {
    try {
        if (!review.data_) throw PhysicalHierarchyError(PhysicalHierarchyCode::InvalidArgument);
        const auto &data = *review.data_;
        if (scope != data.scope) throw PhysicalHierarchyError(PhysicalHierarchyCode::ScopeDenied);
        const auto normalized = normalize_physical_hierarchy_proposal(scope,data.proposal);
        if (normalized != data.proposal || physical_proposal_digest(scope,normalized) != data.proposal_digest)
            throw PhysicalHierarchyError(PhysicalHierarchyCode::Conflict);
        if (data.consumed.load()) throw PhysicalHierarchyError(PhysicalHierarchyCode::Conflict);
        const auto canonical = hierarchy_path(path);
        if (lineage_path(canonical) != data.snapshot.canonical_path)
            throw PhysicalHierarchyError(PhysicalHierarchyCode::Conflict);
        auto keeper = std::make_unique<Database>(canonical,true);
        keeper->copy_budget = true; keeper->copy_timer.start();
        keeper->exec("BEGIN");
        keeper->check(project_application);
        Database db(canonical,false,true);
        db.copy_budget = true; db.copy_timer.start();
        db.exec("PRAGMA trusted_schema=OFF");
        db.exec("PRAGMA foreign_keys=ON");
        db.exec("BEGIN IMMEDIATE");
        bool mutation_started = false, commit_attempted = false;
        try {
            const auto snapshot = hierarchy_snapshot(db,canonical);
            if (snapshot.token != data.snapshot) throw PhysicalHierarchyError(PhysicalHierarchyCode::Conflict);
            hierarchy_revision(snapshot);
            auto transition = apply_physical_hierarchy(snapshot.document,scope,normalized);
            if (transition.diff != data.diff) throw PhysicalHierarchyError(PhysicalHierarchyCode::Conflict);
            const auto identities = hierarchy_registry(snapshot.registry,transition.document);
            const PhysicalHierarchyCommitResult success{
                PhysicalHierarchyCommitState::Committed,snapshot.token.revision+1};
            if (lineage_path(hierarchy_path(path)) != data.snapshot.canonical_path)
                throw PhysicalHierarchyError(PhysicalHierarchyCode::Conflict);
            bool expected = false;
            if (!review.data_->consumed.compare_exchange_strong(expected,true))
                throw PhysicalHierarchyError(PhysicalHierarchyCode::Conflict);
            mutation_started = true;
            replace_project_rows(db,transition.document,2,success.revision,identities);
#ifdef LMTI_PHYSICAL_HIERARCHY_OWNER_TEST_HOOKS
            physical_test_point(PhysicalHierarchyOwnerTestPoint::BeforeCommit);
#endif
            if (lineage_path(hierarchy_path(path)) != data.snapshot.canonical_path)
                throw PhysicalHierarchyError(PhysicalHierarchyCode::Conflict);
            keeper->copy_budget = false;
            keeper->exec("ROLLBACK");
            keeper.reset();
            commit_attempted = true;
            db.exec("COMMIT");
#ifdef LMTI_PHYSICAL_HIERARCHY_OWNER_TEST_HOOKS
            // Isolated lost-response fault; no shipped post-COMMIT operation.
            physical_test_point(PhysicalHierarchyOwnerTestPoint::AfterCommit);
#endif
            return success;
        } catch (...) {
            db.copy_budget = false;
            bool rollback_failed = false;
            try { db.exec("ROLLBACK"); } catch (...) { rollback_failed = true; }
            if (commit_attempted || (mutation_started && rollback_failed))
                return {PhysicalHierarchyCommitState::Unknown,0};
            physical_failure();
        }
    } catch (...) { physical_failure(); }
}

std::vector<RecentProject> recent_projects(const QString &catalog) {
    if (!QFileInfo::exists(catalog))
        return {};
    Database db(catalog, true);
    db.check(catalog_application);
    std::vector<RecentProject> result;
    for (const auto &r : db.rows("SELECT id,label,path FROM recent ORDER BY opened DESC", 30))
        result.push_back({s(str(r, 0)), s(str(r, 1)), s(str(r, 2))});
    return result;
}
void remember_project(const QString &catalog, const RecentProject &p) {
    if (p.path.size() > 1024 || !QFileInfo(p.path).isAbsolute())
        throw Error("Invalid project locator.");
    Database db(catalog, false);
    if (db.existed)
        db.check(catalog_application);
    db.exec("BEGIN IMMEDIATE");
    try {
        if (!db.existed) {
            db.exec("PRAGMA application_id=1280131905"); // LMCA
            db.exec("PRAGMA user_version=1");
            db.exec("CREATE TABLE recent(id TEXT PRIMARY KEY,label TEXT NOT NULL,path TEXT NOT NULL,opened "
                    "INTEGER NOT NULL)");
        }
        QSqlQuery q(db.db);
        if (!q.prepare("INSERT INTO recent VALUES(?,?,?,unixepoch()) ON CONFLICT(id) DO UPDATE SET "
                       "label=excluded.label,path=excluded.path,opened=excluded.opened"))
            throw Error("Cannot prepare catalog update.");
        q.addBindValue(p.id);
        q.addBindValue(p.label);
        q.addBindValue(p.path);
        if (!q.exec())
            throw Error("Cannot update recent projects.");
        db.exec("DELETE FROM recent WHERE id NOT IN(SELECT id FROM recent ORDER BY opened DESC LIMIT 30)");
        db.exec("COMMIT");
    } catch (...) {
        db.exec("ROLLBACK");
        throw;
    }
}
} // namespace lmti

#include "project_desired_asset_store_p.hpp"
