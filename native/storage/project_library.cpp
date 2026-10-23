#include "lmti/project_library.hpp"
#include "project_copy_p.hpp"
#include "../common/local_owner_path.hpp"
#include <QCryptographicHash>
#include <QDateTime>
#include <QElapsedTimer>
#include <QDir>
#include <QFile>
#include <QFileInfo>
#include <QJsonArray>
#include <QJsonDocument>
#include <QRegularExpression>
#include <QSet>
#include <QSqlDatabase>
#include <QSqlError>
#include <QSqlQuery>
#include <QUuid>
#include <QUrl>
#include <QVariant>
#include <algorithm>
#include <filesystem>
#include <optional>
#ifdef Q_OS_WIN
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#else
#include <sys/stat.h>
#endif

namespace lmti {
namespace {
constexpr int library_application = 0x4c4d4c42;
constexpr qint64 safe_integer = 9007199254740991LL;
void need(bool value,LibraryCode code = LibraryCode::OwnerUnavailable) {
    if (!value) throw LibraryError(code);
}
QString key(const QString &value) {
    auto result = detail::local_owner_path_lexical(value);
#ifdef Q_OS_WIN
    result = result.toCaseFolded();
#endif
    return result;
}
void local_path(const QString &path,bool optional = false) {
    if (optional && path.isEmpty()) return;
    detail::local_owner_path_lexical(path); // Metadata only, no reference probes.
}
bool uuid(const QString &value) {
    const QUuid parsed(value);
    return !parsed.isNull() && parsed.toString(QUuid::WithoutBraces) == value;
}
bool hex(const QString &value) { return QRegularExpression("^[0-9a-f]{64}$").match(value).hasMatch(); }
void entry_valid(const LibraryEntry &entry) {
    ProjectDocument d;
    d.project = {entry.id.toStdString(),entry.label.toStdString(),"",Privacy::Internal};
    validate(d); local_path(entry.path); local_path(entry.folder,true);
    need(entry.opened >= 0 && entry.opened <= safe_integer,LibraryCode::InvalidInput);
}
QString table_sql(const QString &table) {
    return "CREATE TABLE " + table + "(id TEXT PRIMARY KEY,label TEXT NOT NULL,path TEXT NOT NULL,folder "
           "TEXT,pinned INTEGER NOT NULL CHECK(pinned IN(0,1)),opened INTEGER NOT NULL,folder_key TEXT UNIQUE)";
}
const QString identity_sql = "CREATE TABLE library_identity(singleton INTEGER PRIMARY KEY CHECK(singleton=1),"
    "library_uuid TEXT NOT NULL,binding_generation INTEGER NOT NULL CHECK(binding_generation>=1),"
    "upgrade_operation_id TEXT NOT NULL,legacy_digest TEXT NOT NULL)";
const QString identity_v3_sql = "CREATE TABLE library_identity(singleton INTEGER PRIMARY KEY CHECK(singleton=1),"
    "library_uuid TEXT NOT NULL,binding_generation INTEGER NOT NULL CHECK(binding_generation>=1),"
    "upgrade_operation_id TEXT NOT NULL,legacy_digest TEXT NOT NULL,"
    "activation_format_operation_id TEXT NOT NULL,activation_format_backup_digest TEXT NOT NULL)";
const QString activation_sql = "CREATE TABLE library_activations("
    "operation_id TEXT PRIMARY KEY,operation_revision INTEGER NOT NULL CHECK(operation_revision IN(1,2)),"
    "state TEXT NOT NULL CHECK(state IN('prepared','activated','abandoned')),"
    "library_schema INTEGER NOT NULL CHECK(library_schema=3),library_path TEXT NOT NULL,library_uuid TEXT NOT NULL,"
    "prepared_generation INTEGER NOT NULL,prepared_bindings_digest TEXT NOT NULL,project_id TEXT NOT NULL,"
    "source_path TEXT NOT NULL,source_folder TEXT,source_folder_key TEXT,copy_operation_id TEXT NOT NULL,"
    "copy_parent TEXT NOT NULL,copy_mode TEXT NOT NULL,site_policy TEXT NOT NULL,"
    "source_schema INTEGER NOT NULL,source_store_uuid TEXT NOT NULL,source_revision INTEGER NOT NULL,"
    "source_content_digest TEXT NOT NULL,source_registry_digest TEXT NOT NULL,"
    "target_schema INTEGER NOT NULL CHECK(target_schema=2),target_path TEXT NOT NULL,target_store_uuid TEXT NOT NULL,"
    "target_revision INTEGER NOT NULL,target_content_digest TEXT NOT NULL,target_registry_digest TEXT NOT NULL,"
    "activated_generation INTEGER)";
QString compact(QString sql) {
    sql.remove(QRegularExpression("\\s+")); sql = sql.toLower();
    sql.replace("createtable\"library_entries\"(","createtablelibrary_entries(");
    return sql;
}
void sidecars(const QString &path) {
    for (const auto &suffix : {QString("-wal"),QString("-shm"),QString("-journal")}) {
        const auto candidate = path + suffix;
        detail::local_owner_path(candidate,false);
        const QFileInfo file(candidate);
        if (file.exists()) need(file.size() <= (suffix == "-shm" ? 1024*1024 : 128*1024*1024),LibraryCode::BudgetExceeded);
    }
}
class LibraryDb {
    QString connection_;
  public:
    QSqlDatabase db;
    QString path;
    bool fresh = false;
    LibraryDb(const QString &requested,bool read,bool fresh_only = false,bool require_existing = false,
              bool immutable_backup = false) {
        path = detail::local_owner_path(requested,read || require_existing);
        const QFileInfo file(path);
        const bool existed = file.exists();
        need(!fresh_only || !existed,LibraryCode::Conflict);
        need(!existed || file.size() <= 64*1024*1024,LibraryCode::BudgetExceeded);
        sidecars(path);
        if (!existed) {
            need(!read && !require_existing);
            for (const auto *suffix : {"-wal","-shm","-journal"})
                need(!QFileInfo::exists(path + suffix),LibraryCode::Conflict);
            QFile reservation(path);
            need(reservation.open(QIODevice::WriteOnly | QIODevice::NewOnly),LibraryCode::Conflict);
            reservation.close(); fresh = true;
        }
        connection_ = QUuid::createUuid().toString(QUuid::WithoutBraces);
        db = QSqlDatabase::addDatabase("QSQLITE",connection_);
        if (read) {
            if (immutable_backup) {
                auto uri = QUrl::fromLocalFile(path); uri.setQuery("mode=ro&immutable=1");
                db.setDatabaseName(uri.toString(QUrl::FullyEncoded));
                db.setConnectOptions("QSQLITE_OPEN_URI;QSQLITE_OPEN_READONLY;QSQLITE_BUSY_TIMEOUT=2000");
            } else {
                db.setDatabaseName(path);
                db.setConnectOptions("QSQLITE_OPEN_READONLY;QSQLITE_BUSY_TIMEOUT=2000");
            }
        } else {
            // Even a new database has already been exclusively reserved above.
            // A disappearance before SQLite opens must not create a replacement.
            auto uri = QUrl::fromLocalFile(path); uri.setQuery("mode=rw");
            db.setDatabaseName(uri.toString(QUrl::FullyEncoded));
            db.setConnectOptions("QSQLITE_OPEN_URI;QSQLITE_BUSY_TIMEOUT=2000");
        }
        try {
            need(db.open()); exec("PRAGMA trusted_schema=OFF");
            if (read) exec("PRAGMA query_only=ON");
            else exec("PRAGMA synchronous=FULL");
            if (fresh) {
                exec("BEGIN IMMEDIATE");
                exec(QString("PRAGMA application_id=%1").arg(library_application));
                exec("PRAGMA user_version=1"); exec(table_sql("library")); exec("COMMIT");
            }
        } catch (...) {
            db.close(); db = {}; QSqlDatabase::removeDatabase(connection_); throw;
        }
    }
    ~LibraryDb() { db.close(); db = {}; QSqlDatabase::removeDatabase(connection_); }
    void exec(const QString &sql) { QSqlQuery q(db); need(q.exec(sql)); }
    void rollback() noexcept { try { exec("ROLLBACK"); } catch (...) {} }
    qint64 number(const QString &sql) {
        QSqlQuery q(db); need(q.exec(sql) && q.next());
        const auto value = q.value(0);
        need(value.metaType().id() == QMetaType::Int || value.metaType().id() == QMetaType::LongLong,LibraryCode::UnsupportedFormat);
        return value.toLongLong();
    }
    void change(const QString &sql,const QVariantList &values) {
        QSqlQuery q(db); need(q.prepare(sql));
        for (const auto &value : values) q.addBindValue(value);
        need(q.exec() && q.numRowsAffected() == 1,LibraryCode::Conflict);
    }
};
QString text(QSqlQuery &q,int i) {
    const auto value = q.value(i);
    need(!value.isNull() && value.metaType().id() == QMetaType::QString && value.toString().toUtf8().size() <= 1024,LibraryCode::UnsupportedFormat);
    return value.toString();
}
qint64 integer(QSqlQuery &q,int i) {
    const auto value = q.value(i);
    need(!value.isNull() && (value.metaType().id() == QMetaType::Int || value.metaType().id() == QMetaType::LongLong),LibraryCode::UnsupportedFormat);
    return value.toLongLong();
}
struct Row { LibraryEntry entry; std::optional<QString> folder,folder_key; };
struct Snapshot {
    LibraryInspection view;
    std::vector<Row> rows;
    std::vector<LibraryActivationReceipt> receipts;
    QString table() const { return view.token.schema == 1 ? "library" : "library_entries"; }
};
void read_activations(LibraryDb &db,Snapshot &value);
void exact_schema(LibraryDb &db,int version) {
    const QString table = version == 1 ? "library" : "library_entries";
    QSqlQuery query(db.db);
    need(query.exec("SELECT name,sql FROM sqlite_schema WHERE type='table' AND name NOT GLOB 'sqlite_*'"));
    QSet<QString> names;
    while (query.next()) {
        const auto name = text(query,0);
        need(query.value(1).metaType().id() == QMetaType::QString &&
             query.value(1).toString().toUtf8().size() <= 8192,LibraryCode::UnsupportedFormat);
        const auto sql = query.value(1).toString();
        need(!names.contains(name),LibraryCode::UnsupportedFormat); names.insert(name);
        need((name == table && compact(sql) == compact(table_sql(table))) ||
             (version >= 2 && name == "library_identity" &&
                 compact(sql) == compact(version == 2 ? identity_sql : identity_v3_sql)) ||
             (version == 3 && name == "library_activations" && compact(sql) == compact(activation_sql)),LibraryCode::UnsupportedFormat);
    }
    need(!query.lastError().isValid() && names.size() == version && names.contains(table),LibraryCode::UnsupportedFormat);
    need(db.number("SELECT count(*) FROM sqlite_schema WHERE type='index'") == (version == 3 ? 3 : 2),LibraryCode::UnsupportedFormat);
    need(db.number("SELECT count(*) FROM sqlite_schema WHERE type='index' AND sql IS NOT NULL") == 0,LibraryCode::UnsupportedFormat);
}
void field(QCryptographicHash &hash,const QByteArray &value) {
    hash.addData(QByteArray::number(value.size())); hash.addData(QByteArrayLiteral(":")); hash.addData(value);
}
QString rows_digest(const std::vector<Row> &rows,bool complete) {
    QCryptographicHash hash(QCryptographicHash::Sha256);
    field(hash,complete ? QByteArrayLiteral("lmti.library.full.v1") : QByteArrayLiteral("lmti.library.bindings.v1"));
    for (const auto &row : rows) {
        QJsonArray values{row.entry.id,row.entry.path,
                         row.folder ? QJsonValue(*row.folder) : QJsonValue(QJsonValue::Null),
                         row.folder_key ? QJsonValue(*row.folder_key) : QJsonValue(QJsonValue::Null)};
        if (complete) { values.append(row.entry.label); values.append(row.entry.pinned); values.append(row.entry.opened); }
        field(hash,QJsonDocument(values).toJson(QJsonDocument::Compact));
    }
    return QString::fromLatin1(hash.result().toHex());
}
Snapshot snapshot(LibraryDb &db,bool exact_v1 = false) {
    sidecars(db.path);
    need(db.number("PRAGMA application_id") == library_application,LibraryCode::UnsupportedFormat);
    const auto version = db.number("PRAGMA user_version");
    need(version == 1 || version == 2 || version == 3,LibraryCode::UnsupportedFormat);
    need(db.number("SELECT count(*) FROM sqlite_schema WHERE type IN('trigger','view')") == 0,LibraryCode::UnsupportedFormat);
    const auto pages = db.number("PRAGMA page_count"), size = db.number("PRAGMA page_size");
    need(pages > 0 && size >= 512 && size <= 65536 && pages <= (64*1024*1024)/size,LibraryCode::BudgetExceeded);
    if (version == 1)
        need(db.number("SELECT count(*) FROM sqlite_schema WHERE lower(name) IN('library_entries','library_identity','library_activations','copy_operations','copy_activations')") == 0,LibraryCode::UnsupportedFormat);
    if (version >= 2 || exact_v1) exact_schema(db,static_cast<int>(version));
    need(db.number("SELECT count(*) FROM " + QString(version == 1 ? "library" : "library_entries")) <= static_cast<qint64>(max_library_entries),LibraryCode::BudgetExceeded);
    Snapshot result;
    result.view.token.schema = static_cast<int>(version); result.view.token.canonical_path = key(db.path);
    if (version >= 2) {
        QSqlQuery q(db.db);
        need(q.exec("SELECT singleton,library_uuid,binding_generation,upgrade_operation_id,legacy_digest" +
            QString(version == 3 ? ",activation_format_operation_id,activation_format_backup_digest" : "") + " FROM library_identity"));
        need(q.next() && integer(q,0) == 1,LibraryCode::UnsupportedFormat);
        result.view.token.library_uuid = text(q,1); result.view.token.generation = integer(q,2);
        result.view.upgrade_operation_id = text(q,3); result.view.legacy_digest = text(q,4);
        if (version == 3) {
            result.view.activation_format_operation_id = text(q,5);
            result.view.activation_format_backup_digest = text(q,6);
            need(uuid(result.view.activation_format_operation_id) && hex(result.view.activation_format_backup_digest),LibraryCode::UnsupportedFormat);
        }
        need(uuid(result.view.token.library_uuid) && uuid(result.view.upgrade_operation_id) && hex(result.view.legacy_digest) &&
             result.view.token.generation >= 1 && result.view.token.generation <= safe_integer && !q.next() && !q.lastError().isValid(),LibraryCode::UnsupportedFormat);
    }
    QSqlQuery q(db.db);
    need(q.exec("SELECT id,label,path,folder,pinned,opened,folder_key FROM " + result.table() + " ORDER BY id LIMIT 501"));
    QSet<QString> ids,folders;
    while (q.next()) {
        const auto pin = integer(q,4); need(pin == 0 || pin == 1,LibraryCode::UnsupportedFormat);
        Row row{{text(q,0),text(q,1),text(q,2),{},pin == 1,integer(q,5)},std::nullopt,std::nullopt};
        if (!q.value(3).isNull()) row.folder = text(q,3);
        if (!q.value(6).isNull()) row.folder_key = text(q,6);
        row.entry.folder = row.folder.value_or(QString{});
        entry_valid(row.entry);
        need(!ids.contains(row.entry.id),LibraryCode::UnsupportedFormat); ids.insert(row.entry.id);
        need(row.folder_key.value_or(QString{}) == (row.entry.folder.isEmpty() ? QString{} : key(row.entry.folder)),LibraryCode::UnsupportedFormat);
        if (row.folder_key) { need(!folders.contains(*row.folder_key),LibraryCode::UnsupportedFormat); folders.insert(*row.folder_key); }
        result.rows.push_back(row); need(result.rows.size() <= max_library_entries,LibraryCode::BudgetExceeded);
    }
    need(!q.lastError().isValid());
    result.view.token.digest = rows_digest(result.rows,version == 1);
    for (const auto &row : result.rows) result.view.entries.push_back(row.entry);
    std::sort(result.view.entries.begin(),result.view.entries.end(),[](const auto &a,const auto &b) {
        if (a.pinned != b.pinned) return a.pinned > b.pinned;
        if (a.opened != b.opened) return a.opened > b.opened;
        return a.id < b.id;
    });
    if (version == 3) read_activations(db,result);
    return result;
}
void token_shape(const LibraryToken &token) {
    need((token.schema == 1 || token.schema == 2 || token.schema == 3) && hex(token.digest),LibraryCode::InvalidInput);
    local_path(token.canonical_path);
    need(key(token.canonical_path) == token.canonical_path,LibraryCode::InvalidInput);
    need(token.schema == 1 ? token.library_uuid.isEmpty() && token.generation == 0 :
         uuid(token.library_uuid) && token.generation >= 1 && token.generation <= safe_integer,LibraryCode::InvalidInput);
}
QVariant optional(const std::optional<QString> &value);
QString activation_state(LibraryActivationState value) {
    switch (value) {
    case LibraryActivationState::Prepared: return "prepared";
    case LibraryActivationState::Activated: return "activated";
    case LibraryActivationState::Abandoned: return "abandoned";
    }
    throw LibraryError(LibraryCode::InvalidInput);
}
QString fixed_target(const QString &parent,const QString &operation) {
    local_path(parent); need(uuid(operation),LibraryCode::InvalidInput);
    return key(QDir(parent).filePath(operation + "/project.sqlite"));
}
void copy_token_shape(const ProjectCopyToken &token) {
    need(token.schema == 1 || token.schema == 2,LibraryCode::InvalidInput);
    validate_id(token.project_id.toStdString());
    need(key(token.canonical_path) == token.canonical_path && token.revision >= 1 &&
         token.revision < safe_integer && hex(token.content_digest) && hex(token.registry_digest) &&
         (token.schema == 1 ? token.store_uuid.isEmpty() : uuid(token.store_uuid)),LibraryCode::InvalidInput);
}
void preview_shape(const LibraryActivationPreview &value) {
    token_shape(value.library); need(value.library.schema == 3,LibraryCode::InvalidInput);
    validate_id(value.project_id.toStdString()); copy_token_shape(value.source); copy_token_shape(value.target);
    need(key(value.copy_parent) == value.copy_parent && uuid(value.copy_operation_id) &&
         (value.mode == ProjectCopyMode::MigrateV1 || value.mode == ProjectCopyMode::CloneV2) &&
         value.seeds_internal_sites == (value.mode == ProjectCopyMode::MigrateV1) &&
         value.source.schema == (value.seeds_internal_sites ? 1 : 2) && value.target.schema == 2 &&
         value.source.project_id == value.project_id && value.target.project_id == value.project_id &&
         value.target.revision == value.source.revision+1 && value.target.store_uuid != value.source.store_uuid &&
         value.source.canonical_path != value.target.canonical_path &&
         value.target.canonical_path == fixed_target(value.copy_parent,value.copy_operation_id),LibraryCode::InvalidInput);
}
void activation_token_shape(const LibraryActivationToken &token) {
    need(uuid(token.library_uuid) && uuid(token.operation_id) && hex(token.receipt_digest) &&
         (token.revision == 1 || token.revision == 2),LibraryCode::InvalidInput);
}
QVariantList receipt_values(const LibraryActivationReceipt &r) {
    const auto &p = r.prepared;
    return {r.token.operation_id,r.token.revision,activation_state(r.state),p.library.schema,
        p.library.canonical_path,p.library.library_uuid,p.library.generation,p.library.digest,p.project_id,
        p.source.canonical_path,optional(r.source_folder),optional(r.source_folder_key),p.copy_operation_id,
        p.copy_parent,p.mode == ProjectCopyMode::MigrateV1 ? "migrate_v1" : "clone_v2",
        p.seeds_internal_sites ? "internal_known_sites" : "unchanged",p.source.schema,p.source.store_uuid,
        static_cast<qint64>(p.source.revision),p.source.content_digest,p.source.registry_digest,
        p.target.schema,p.target.canonical_path,p.target.store_uuid,static_cast<qint64>(p.target.revision),
        p.target.content_digest,p.target.registry_digest,
        r.state == LibraryActivationState::Activated ? QVariant(r.activated_generation) : QVariant(QMetaType(QMetaType::LongLong))};
}
QString receipt_digest(const LibraryActivationReceipt &r) {
    QCryptographicHash hash(QCryptographicHash::Sha256);
    field(hash,QByteArrayLiteral("lmti.library.activation.v1"));
    field(hash,QJsonDocument(QJsonArray::fromVariantList(receipt_values(r))).toJson(QJsonDocument::Compact));
    return QString::fromLatin1(hash.result().toHex());
}
void receipt_shape(const LibraryActivationReceipt &r) {
    preview_shape(r.prepared);
    need(uuid(r.token.operation_id) && r.token.library_uuid == r.prepared.library.library_uuid &&
         r.token.revision == (r.state == LibraryActivationState::Prepared ? 1 : 2),LibraryCode::UnsupportedFormat);
    activation_state(r.state);
    if (r.source_folder) local_path(*r.source_folder,true);
    need(r.source_folder_key.value_or(QString{}) ==
         (r.source_folder.value_or(QString{}).isEmpty() ? QString{} : key(*r.source_folder)),LibraryCode::UnsupportedFormat);
    need(r.state == LibraryActivationState::Activated ?
         r.prepared.library.generation < safe_integer && r.activated_generation == r.prepared.library.generation+1 :
         r.activated_generation == 0,LibraryCode::UnsupportedFormat);
}
void read_activations(LibraryDb &db,Snapshot &value) {
    need(db.number("SELECT count(*) FROM library_activations") <= static_cast<qint64>(max_library_activations),LibraryCode::BudgetExceeded);
    QSqlQuery q(db.db);
    need(q.exec("SELECT operation_id,operation_revision,state,library_schema,library_path,library_uuid,"
        "prepared_generation,prepared_bindings_digest,project_id,source_path,source_folder,source_folder_key,"
        "copy_operation_id,copy_parent,copy_mode,site_policy,source_schema,source_store_uuid,source_revision,"
        "source_content_digest,source_registry_digest,target_schema,target_path,target_store_uuid,target_revision,"
        "target_content_digest,target_registry_digest,activated_generation FROM library_activations ORDER BY operation_id LIMIT 1001"));
    QSet<QString> ids;
    while (q.next()) {
        LibraryActivationReceipt r;
        r.token.operation_id = text(q,0); r.token.revision = integer(q,1);
        const auto state = text(q,2);
        need(state == "prepared" || state == "activated" || state == "abandoned",LibraryCode::UnsupportedFormat);
        r.state = state == "prepared" ? LibraryActivationState::Prepared :
            state == "activated" ? LibraryActivationState::Activated : LibraryActivationState::Abandoned;
        auto &p = r.prepared;
        const auto schema = integer(q,3); need(schema == 3,LibraryCode::UnsupportedFormat);
        p.library = {3,text(q,4),text(q,5),integer(q,6),text(q,7)};
        p.project_id = text(q,8);
        if (!q.value(10).isNull()) r.source_folder = text(q,10);
        if (!q.value(11).isNull()) r.source_folder_key = text(q,11);
        p.copy_operation_id = text(q,12); p.copy_parent = text(q,13);
        const auto mode = text(q,14), policy = text(q,15);
        need(mode == "migrate_v1" || mode == "clone_v2",LibraryCode::UnsupportedFormat);
        p.mode = mode == "migrate_v1" ? ProjectCopyMode::MigrateV1 : ProjectCopyMode::CloneV2;
        p.seeds_internal_sites = p.mode == ProjectCopyMode::MigrateV1;
        need(policy == (p.seeds_internal_sites ? "internal_known_sites" : "unchanged"),LibraryCode::UnsupportedFormat);
        const auto source_schema = integer(q,16), target_schema = integer(q,21);
        need((source_schema == 1 || source_schema == 2) && target_schema == 2,LibraryCode::UnsupportedFormat);
        p.source = {static_cast<int>(source_schema),p.project_id,text(q,9),text(q,17),integer(q,18),text(q,19),text(q,20)};
        p.target = {2,p.project_id,text(q,22),text(q,23),integer(q,24),text(q,25),text(q,26)};
        if (!q.value(27).isNull()) r.activated_generation = integer(q,27);
        need((r.state == LibraryActivationState::Activated) != q.value(27).isNull(),LibraryCode::UnsupportedFormat);
        r.token.library_uuid = p.library.library_uuid;
        receipt_shape(r); r.token.receipt_digest = receipt_digest(r);
        need(r.token.library_uuid == value.view.token.library_uuid &&
             p.library.generation <= value.view.token.generation &&
             r.activated_generation <= value.view.token.generation && !ids.contains(r.token.operation_id),LibraryCode::UnsupportedFormat);
        ids.insert(r.token.operation_id); value.receipts.push_back(std::move(r));
        need(value.receipts.size() <= max_library_activations,LibraryCode::BudgetExceeded);
    }
    need(!q.lastError().isValid());
}
QString full_v2_digest(const Snapshot &value) {
    need(value.view.token.schema == 2,LibraryCode::UnsupportedFormat);
    QCryptographicHash hash(QCryptographicHash::Sha256);
    field(hash,QByteArrayLiteral("lmti.library.full.v2"));
    field(hash,rows_digest(value.rows,true).toUtf8());
    field(hash,QJsonDocument(QJsonArray{value.view.token.library_uuid,value.view.token.generation,
        value.view.upgrade_operation_id,value.view.legacy_digest}).toJson(QJsonDocument::Compact));
    return QString::fromLatin1(hash.result().toHex());
}
void expected(const Snapshot &current,const LibraryToken &token,int version) {
    token_shape(token);
    need(current.view.token.schema == version,LibraryCode::UnsupportedFormat);
    need(token == current.view.token,LibraryCode::Conflict);
}
const Row *find(const Snapshot &snapshot,const QString &id) {
    auto found = std::find_if(snapshot.rows.begin(),snapshot.rows.end(),[&](const auto &row) { return row.entry.id == id; });
    return found == snapshot.rows.end() ? nullptr : &*found;
}
void bump(LibraryDb &db,const Snapshot &current) {
    need(current.view.token.generation < safe_integer,LibraryCode::BudgetExceeded);
    db.change("UPDATE library_identity SET binding_generation=? WHERE singleton=1 AND library_uuid=? AND binding_generation=?",
              {current.view.token.generation+1,current.view.token.library_uuid,current.view.token.generation});
}
#ifdef LMTI_LIBRARY_CORE_TEST_HOOKS
LibraryTestFault test_fault = LibraryTestFault::None;
void fault(LibraryTestFault point) {
    if (test_fault == point) { test_fault = LibraryTestFault::None; throw LibraryError(LibraryCode::RecoveryRequired); }
}
#endif
template<class Operation> auto write(const QString &path,Operation operation,bool require_existing = true) {
    LibraryDb db(path,false,false,require_existing);
    db.exec("BEGIN IMMEDIATE");
    bool commit_attempted = false;
    try {
        const auto before = snapshot(db); // Format and identity checked under lock.
        auto result = operation(db,before); // All result allocations precede COMMIT.
#ifdef LMTI_LIBRARY_CORE_TEST_HOOKS
        fault(LibraryTestFault::BeforeMutationCommit);
#endif
        commit_attempted = true; db.exec("COMMIT");
#ifdef LMTI_LIBRARY_CORE_TEST_HOOKS
        fault(LibraryTestFault::AfterMutationCommit);
#endif
        return result;
    } catch (...) {
        db.rollback();
        if (commit_attempted) throw LibraryError(LibraryCode::RecoveryRequired);
        throw;
    }
}
template<class Operation> auto bounded(Operation operation) {
    try { return operation(); }
    catch (const LibraryError &) { throw; }
    catch (const std::exception &) { throw LibraryError(LibraryCode::OwnerUnavailable); }
}
QVariant optional(const std::optional<QString> &value) {
    return value ? QVariant(*value) : QVariant(QMetaType(QMetaType::QString));
}
void typed_backup(const QString &path,const Snapshot &source) {
    {
        LibraryDb backup(path,false,true); backup.exec("BEGIN IMMEDIATE");
        try {
            for (const auto &row : source.rows)
                backup.change("INSERT INTO library VALUES(?,?,?,?,?,?,?)",{row.entry.id,row.entry.label,row.entry.path,
                    optional(row.folder),row.entry.pinned ? 1 : 0,row.entry.opened,optional(row.folder_key)});
            backup.exec("COMMIT");
        } catch (...) { backup.rollback(); throw; }
    }
    LibraryDb checked(path,true); checked.exec("BEGIN");
    const auto value = snapshot(checked,true);
    need(value.view.token.digest == source.view.token.digest,LibraryCode::RecoveryRequired);
    checked.exec("COMMIT");
}
void typed_backup_v2(const QString &path,const Snapshot &source) {
    const auto digest = full_v2_digest(source);
    {
        LibraryDb backup(path,false,true); backup.exec("BEGIN IMMEDIATE");
        try {
            backup.exec("ALTER TABLE library RENAME TO library_entries"); backup.exec(identity_sql);
            backup.change("INSERT INTO library_identity VALUES(1,?,?,?,?)",{
                source.view.token.library_uuid,source.view.token.generation,
                source.view.upgrade_operation_id,source.view.legacy_digest});
            for (const auto &row : source.rows)
                backup.change("INSERT INTO library_entries VALUES(?,?,?,?,?,?,?)",{row.entry.id,row.entry.label,row.entry.path,
                    optional(row.folder),row.entry.pinned ? 1 : 0,row.entry.opened,optional(row.folder_key)});
            backup.exec("PRAGMA user_version=2");
            need(full_v2_digest(snapshot(backup)) == digest,LibraryCode::RecoveryRequired);
            backup.exec("COMMIT");
        } catch (...) { backup.rollback(); throw; }
    }
    LibraryDb checked(path,true); checked.exec("BEGIN");
    need(full_v2_digest(snapshot(checked)) == digest,LibraryCode::RecoveryRequired);
    checked.exec("COMMIT");
}
QString copy_parent(const QString &path) {
    const auto canonical = checked_project_folder(path);
    need(!QDir(canonical).isRoot(),LibraryCode::InvalidInput);
    return key(canonical);
}
std::filesystem::path filesystem_path(const QString &path) {
#ifdef Q_OS_WIN
    return std::filesystem::path(path.toStdWString());
#else
    return std::filesystem::path(path.toUtf8().constData());
#endif
}
void distinct_files(const QString &left,const QString &right) {
    const auto a = detail::local_owner_path(left), b = detail::local_owner_path(right);
    need(key(a) != key(b),LibraryCode::InvalidInput);
    std::error_code error;
    const bool equivalent = std::filesystem::equivalent(filesystem_path(a),filesystem_path(b),error);
    need(!error && !equivalent,LibraryCode::InvalidInput);
}
void project_files(const QString &library,const QString &source,const QString &target) {
    distinct_files(library,source); distinct_files(library,target); distinct_files(source,target);
}
const LibraryActivationReceipt *find_receipt(const Snapshot &value,const QString &id) {
    const auto found = std::find_if(value.receipts.begin(),value.receipts.end(),
        [&](const auto &receipt) { return receipt.token.operation_id == id; });
    return found == value.receipts.end() ? nullptr : &*found;
}
void checked_pair(const LibraryActivationPreview &preview,const detail::CopySnapshot &source,
                  const detail::CopySnapshot &target) {
    need(source.token == preview.source && target.token == preview.target,LibraryCode::Conflict);
    const auto transformed = detail::transform_project_copy(source,preview.mode);
    need(transformed.token.schema == target.token.schema && transformed.token.project_id == target.token.project_id &&
         transformed.token.revision == target.token.revision && transformed.token.content_digest == target.token.content_digest &&
         transformed.token.registry_digest == target.token.registry_digest &&
         source.token.store_uuid != target.token.store_uuid,LibraryCode::Conflict);
}
const Row &selected(const Snapshot &value,const LibraryActivationPreview &preview) {
    expected(value,preview.library,3);
    const auto row = find(value,preview.project_id);
    need(row && key(row->entry.path) == preview.source.canonical_path,LibraryCode::Conflict);
    return *row;
}
void selected_receipt(const Snapshot &value,const LibraryActivationReceipt &receipt) {
    const auto &row = selected(value,receipt.prepared);
    need(row.folder == receipt.source_folder && row.folder_key == receipt.source_folder_key,LibraryCode::Conflict);
}
void insert_receipt(LibraryDb &db,const LibraryActivationReceipt &receipt) {
    receipt_shape(receipt);
    db.change("INSERT INTO library_activations VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
              receipt_values(receipt));
}
enum class ActivationWrite { Prepare, Activate, Abandon };
template<class Operation> LibraryActivationStatus activation_write(const QString &library,const QString &operation_id,
                                                                  ActivationWrite phase,Operation operation) {
    LibraryActivationStatus result; result.operation_id = operation_id;
    LibraryDb db(library,false,false,true); db.exec("BEGIN IMMEDIATE");
    bool commit_attempted = false;
    // Declared after the library transaction and kept alive through its COMMIT.
    std::unique_ptr<detail::HeldProjectCopies> held;
    try {
        const auto current = snapshot(db); need(current.view.token.schema == 3,LibraryCode::UnsupportedFormat);
        result.receipt = operation(db,current,held);
        if (held) held->check_held();
#ifdef LMTI_LIBRARY_CORE_TEST_HOOKS
        fault(phase == ActivationWrite::Prepare ? LibraryTestFault::BeforePreparationCommit :
              phase == ActivationWrite::Activate ? LibraryTestFault::BeforeActivationCommit : LibraryTestFault::BeforeAbandonCommit);
#else
        (void)phase;
#endif
        commit_attempted = true; db.exec("COMMIT");
#ifdef LMTI_LIBRARY_CORE_TEST_HOOKS
        fault(phase == ActivationWrite::Prepare ? LibraryTestFault::AfterPreparationCommit :
              phase == ActivationWrite::Activate ? LibraryTestFault::AfterActivationCommit : LibraryTestFault::AfterAbandonCommit);
#endif
        result.code = LibraryCode::None;
    } catch (const LibraryError &error) {
        db.rollback();
        if (!result.receipt && !commit_attempted) throw;
        result.code = commit_attempted ? LibraryCode::RecoveryRequired : error.code;
    } catch (const std::exception &) {
        db.rollback();
        if (!result.receipt && !commit_attempted) throw LibraryError(LibraryCode::OwnerUnavailable);
        result.code = LibraryCode::RecoveryRequired;
    }
    return result;
}
} // namespace
#ifdef LMTI_LIBRARY_CORE_TEST_HOOKS
void set_library_test_fault(LibraryTestFault value) { test_fault = value; }
#endif
QString checked_project_folder(const QString &folder) {
    return bounded([&] {
        const auto canonical = detail::local_owner_path(folder,true,true);
        for (const auto &part : canonical.split('/'))
            need(part.compare(".lmti",Qt::CaseInsensitive) != 0,LibraryCode::InvalidInput);
        return canonical;
    });
}
LibraryInspection inspect_project_library(const QString &library) {
    return bounded([&] {
        LibraryDb db(library,true); db.exec("BEGIN");
        auto result = snapshot(db).view; db.exec("COMMIT"); return result;
    });
}
std::vector<LibraryEntry> project_library(const QString &library) {
    return bounded([&] {
        detail::local_owner_path(library,false);
        if (!QFileInfo::exists(library)) return std::vector<LibraryEntry>{};
        return inspect_project_library(library).entries;
    });
}
void import_recent_library(const QString &catalog,const QString &library) {
    bounded([&] {
        detail::local_owner_path(library,false);
        if (QFileInfo::exists(library)) return;
        detail::local_owner_path(catalog,false);
        const auto previous = recent_projects(catalog);
        if (previous.empty()) return;
        for (const auto &entry : previous) entry_valid({entry.id,entry.label,entry.path,{}});
        LibraryDb db(library,false,true); db.exec("BEGIN IMMEDIATE");
        try {
            need(db.fresh && snapshot(db,true).rows.empty(),LibraryCode::Conflict);
            for (const auto &entry : previous)
                db.change("INSERT INTO library VALUES(?,?,?,NULL,0,0,NULL)",{entry.id,entry.label,entry.path});
            snapshot(db,true); db.exec("COMMIT");
        } catch (...) { db.rollback(); throw; }
    });
}
void initialize_project_library(const QString &library,const LibraryEntry &entry) {
    bounded([&] {
        entry_valid(entry);
        const auto path = detail::local_owner_path(entry.path, true);
        const auto folder = checked_project_folder(entry.folder);
        sidecars(path);
        const auto metadata = load_project_metadata(path);
        sidecars(path);
        need(metadata.project.id == entry.id.toStdString(), LibraryCode::InvalidInput);
        LibraryDb db(library, false, true);
        db.exec("BEGIN IMMEDIATE");
        try {
            need(db.fresh && snapshot(db, true).rows.empty(), LibraryCode::Conflict);
            db.change("INSERT INTO library VALUES(?,?,?,?,?,?,?)",
                {entry.id,entry.label,path,folder,0,QDateTime::currentMSecsSinceEpoch(),key(folder)});
            snapshot(db, true);
            db.exec("COMMIT");
        } catch (...) { db.rollback(); throw; }
    });
}
void remember_library_project(const QString &library,const LibraryEntry &entry) {
    bounded([&] {
        entry_valid(entry);
        const auto path = detail::local_owner_path(entry.path);
        const auto folder = entry.folder.isEmpty() ? QString{} : checked_project_folder(entry.folder);
        write(library,[&](LibraryDb &db,const Snapshot &before) {
            if (before.view.token.schema == 2 || before.view.token.schema == 3) {
                const auto current = find(before,entry.id);
                need(current && key(current->entry.path) == key(path) &&
                     (folder.isEmpty() || (!current->entry.folder.isEmpty() && key(folder) == key(current->entry.folder))),LibraryCode::Conflict);
                db.change("UPDATE library_entries SET label=?,opened=? WHERE id=?",{entry.label,QDateTime::currentMSecsSinceEpoch(),entry.id});
            } else {
                db.change("INSERT INTO library VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET "
                    "label=excluded.label,path=excluded.path,folder=COALESCE(excluded.folder,library.folder),"
                    "folder_key=COALESCE(excluded.folder_key,library.folder_key),opened=excluded.opened",
                    {entry.id,entry.label,path,folder.isEmpty() ? QVariant(QMetaType(QMetaType::QString)) : QVariant(folder),
                     entry.pinned ? 1 : 0,QDateTime::currentMSecsSinceEpoch(),
                     folder.isEmpty() ? QVariant(QMetaType(QMetaType::QString)) : QVariant(key(folder))});
            }
            snapshot(db); return 0;
        },false);
    });
}
void pin_library_project(const QString &library,const QString &id,bool pinned) {
    bounded([&] {
        validate_id(id.toStdString());
        write(library,[&](LibraryDb &db,const Snapshot &before) {
            db.change("UPDATE " + before.table() + " SET pinned=? WHERE id=?",{pinned ? 1 : 0,id}); return 0;
        });
    });
}
void link_library_folder(const QString &library,const QString &id,const QString &folder) {
    bounded([&] {
        validate_id(id.toStdString()); const auto canonical = checked_project_folder(folder);
        write(library,[&](LibraryDb &db,const Snapshot &before) {
            if (before.view.token.schema == 2 || before.view.token.schema == 3) {
                const auto row = find(before,id);
                need(row && !row->entry.folder.isEmpty() && key(row->entry.folder) == key(canonical),LibraryCode::Conflict);
            } else db.change("UPDATE library SET folder=?,folder_key=? WHERE id=?",{canonical,key(canonical),id});
            return 0;
        });
    });
}
void forget_library_project(const QString &library,const QString &id) {
    bounded([&] {
        validate_id(id.toStdString());
        write(library,[&](LibraryDb &db,const Snapshot &before) {
            need(before.view.token.schema == 1,LibraryCode::Conflict);
            db.change("DELETE FROM library WHERE id=?",{id}); return 0;
        });
    });
}
LibraryUpgradeStatus upgrade_project_library(const QString &library,const QString &parent,const LibraryToken &token) {
    return bounded([&] {
        token_shape(token); need(token.schema == 1,LibraryCode::InvalidInput);
        const auto destination = checked_project_folder(parent);
        need(!QDir(destination).isRoot(),LibraryCode::InvalidInput);
        LibraryDb db(library,true); // Preflight is strictly read-only.
        db.exec("BEGIN"); const auto preflight = snapshot(db,true); expected(preflight,token,1); db.exec("COMMIT");
        LibraryDb writer(library,false,false,true); writer.exec("BEGIN IMMEDIATE");
        LibraryUpgradeStatus result;
        bool reserved = false, commit_attempted = false;
        try {
            const auto current = snapshot(writer,true); expected(current,token,1);
            result.operation_id = QUuid::createUuid().toString(QUuid::WithoutBraces);
            const auto directory = QDir(destination).filePath(result.operation_id);
            need(QDir(destination).mkdir(result.operation_id),LibraryCode::OwnerUnavailable);
            reserved = true;
            detail::local_owner_path(directory,true,true);
            result.backup_path = QDir(directory).filePath("library-v1.sqlite");
            typed_backup(result.backup_path,current);
#ifdef LMTI_LIBRARY_CORE_TEST_HOOKS
            fault(LibraryTestFault::AfterBackupVerification);
#endif
            writer.exec("ALTER TABLE library RENAME TO library_entries");
            writer.exec(identity_sql);
            writer.change("INSERT INTO library_identity VALUES(1,?,?,?,?)",{
                QUuid::createUuid().toString(QUuid::WithoutBraces),1,result.operation_id,current.view.token.digest});
            writer.exec("PRAGMA user_version=2");
            result.library = snapshot(writer).view.token;
#ifdef LMTI_LIBRARY_CORE_TEST_HOOKS
            fault(LibraryTestFault::BeforeUpgradeCommit);
#endif
            commit_attempted = true; writer.exec("COMMIT");
#ifdef LMTI_LIBRARY_CORE_TEST_HOOKS
            fault(LibraryTestFault::AfterUpgradeCommit);
#endif
            result.state = LibraryUpgradeState::Upgraded; result.code = LibraryCode::None;
        } catch (const LibraryError &error) {
            writer.rollback(); if (!reserved) throw;
            result.code = commit_attempted ? LibraryCode::RecoveryRequired : error.code;
        } catch (const std::exception &) {
            writer.rollback(); if (!reserved) throw; result.code = LibraryCode::RecoveryRequired;
        }
        return result;
    });
}
LibraryToken register_library_project_cas(const QString &library,const LibraryEntry &entry,const LibraryToken &token) {
    return bounded([&] {
        token_shape(token); need(token.schema == 2 || token.schema == 3,LibraryCode::InvalidInput); entry_valid(entry);
        detail::local_owner_path(library);
        const auto path = detail::local_owner_path(entry.path);
        const auto folder = entry.folder.isEmpty() ? QString{} : checked_project_folder(entry.folder);
        sidecars(path);
        const auto metadata = load_project_metadata(path);
        sidecars(path);
        need(metadata.project.id == entry.id.toStdString(),LibraryCode::InvalidInput);
        return write(library,[&](LibraryDb &db,const Snapshot &before) {
            expected(before,token,token.schema); need(!find(before,entry.id),LibraryCode::Conflict);
            need(before.rows.size() < max_library_entries,LibraryCode::BudgetExceeded);
            bump(db,before);
            db.change("INSERT INTO library_entries VALUES(?,?,?,?,?,?,?)",{entry.id,entry.label,path,
                folder.isEmpty() ? QVariant(QMetaType(QMetaType::QString)) : QVariant(folder),entry.pinned ? 1 : 0,
                QDateTime::currentMSecsSinceEpoch(),folder.isEmpty() ? QVariant(QMetaType(QMetaType::QString)) : QVariant(key(folder))});
            return snapshot(db).view.token;
        });
    });
}
LibraryToken link_library_folder_cas(const QString &library,const QString &id,const QString &folder,const LibraryToken &token) {
    return bounded([&] {
        token_shape(token); need(token.schema == 2 || token.schema == 3,LibraryCode::InvalidInput); validate_id(id.toStdString());
        detail::local_owner_path(library); const auto canonical = checked_project_folder(folder);
        return write(library,[&](LibraryDb &db,const Snapshot &before) {
            expected(before,token,token.schema); const auto row = find(before,id); need(row,LibraryCode::Conflict);
            if (row->entry.folder.isEmpty() || key(row->entry.folder) != key(canonical)) {
                bump(db,before);
                db.change("UPDATE library_entries SET folder=?,folder_key=? WHERE id=?",{canonical,key(canonical),id});
            }
            return snapshot(db).view.token;
        });
    });
}
LibraryToken forget_library_project_cas(const QString &library,const QString &id,const LibraryToken &token) {
    return bounded([&] {
        token_shape(token); need(token.schema == 2 || token.schema == 3,LibraryCode::InvalidInput); validate_id(id.toStdString());
        detail::local_owner_path(library);
        return write(library,[&](LibraryDb &db,const Snapshot &before) {
            expected(before,token,token.schema); need(find(before,id),LibraryCode::Conflict); bump(db,before);
            db.change("DELETE FROM library_entries WHERE id=?",{id}); return snapshot(db).view.token;
        });
    });
}
LibraryFormatPreview inspect_library_activation_upgrade(const QString &library) {
    return bounded([&] {
        LibraryDb db(library,true); db.exec("BEGIN"); const auto current = snapshot(db);
        LibraryFormatPreview result{current.view.token,full_v2_digest(current)};
        db.exec("COMMIT"); return result;
    });
}
LibraryUpgradeStatus upgrade_library_activation_format(const QString &library,const QString &parent,
                                                       const LibraryFormatPreview &preview) {
    return bounded([&] {
        token_shape(preview.source);
        need(preview.source.schema == 2 && hex(preview.full_snapshot_digest),LibraryCode::InvalidInput);
        const auto destination = checked_project_folder(parent);
        need(!QDir(destination).isRoot(),LibraryCode::InvalidInput);
        {
            LibraryDb db(library,true); db.exec("BEGIN"); const auto current = snapshot(db);
            expected(current,preview.source,2);
            need(full_v2_digest(current) == preview.full_snapshot_digest,LibraryCode::Conflict);
            db.exec("COMMIT");
        }
        LibraryDb writer(library,false,false,true); writer.exec("BEGIN IMMEDIATE");
        LibraryUpgradeStatus result;
        bool reserved = false, commit_attempted = false;
        try {
            const auto current = snapshot(writer); expected(current,preview.source,2);
            need(full_v2_digest(current) == preview.full_snapshot_digest,LibraryCode::Conflict);
            result.operation_id = QUuid::createUuid().toString(QUuid::WithoutBraces);
            const auto directory = QDir(destination).filePath(result.operation_id);
            need(QDir(destination).mkdir(result.operation_id),LibraryCode::OwnerUnavailable); reserved = true;
            detail::local_owner_path(directory,true,true);
            result.backup_path = QDir(directory).filePath("library-v2.sqlite");
            typed_backup_v2(result.backup_path,current);
#ifdef LMTI_LIBRARY_CORE_TEST_HOOKS
            fault(LibraryTestFault::AfterFormatBackupVerification);
#endif
            writer.exec("ALTER TABLE library_identity RENAME TO library_identity_v2");
            writer.exec(identity_v3_sql);
            writer.change("INSERT INTO library_identity VALUES(1,?,?,?,?,?,?)",{
                current.view.token.library_uuid,current.view.token.generation,current.view.upgrade_operation_id,
                current.view.legacy_digest,result.operation_id,preview.full_snapshot_digest});
            writer.exec("DROP TABLE library_identity_v2"); writer.exec(activation_sql);
            writer.exec("PRAGMA user_version=3");
            result.library = snapshot(writer).view.token;
#ifdef LMTI_LIBRARY_CORE_TEST_HOOKS
            fault(LibraryTestFault::BeforeFormatCommit);
#endif
            commit_attempted = true; writer.exec("COMMIT");
#ifdef LMTI_LIBRARY_CORE_TEST_HOOKS
            fault(LibraryTestFault::AfterFormatCommit);
#endif
            result.state = LibraryUpgradeState::Upgraded; result.code = LibraryCode::None;
        } catch (const LibraryError &error) {
            writer.rollback(); if (!reserved) throw;
            result.code = commit_attempted ? LibraryCode::RecoveryRequired : error.code;
        } catch (const std::exception &) {
            writer.rollback(); if (!reserved) throw; result.code = LibraryCode::RecoveryRequired;
        }
        return result;
    });
}
LibraryActivationPreview inspect_library_activation_candidate(const QString &library,const QString &project_id,
                                                              const QString &parent,const QString &copy_operation_id) {
    return bounded([&] {
        validate_id(project_id.toStdString()); need(uuid(copy_operation_id),LibraryCode::InvalidInput);
        const auto trusted = copy_parent(parent);
        LibraryDb db(library,true); db.exec("BEGIN"); const auto current = snapshot(db); db.exec("COMMIT");
        need(current.view.token.schema == 3,LibraryCode::UnsupportedFormat);
        const auto row = find(current,project_id); need(row,LibraryCode::Conflict);
        const auto target = fixed_target(trusted,copy_operation_id);
        project_files(db.path,row->entry.path,target);
        // The copy inspector only reads its fixed filenames. Its source path is
        // compared to the selection before any project read uses that authority.
        const auto copy = inspect_project_copy_operation(trusted,copy_operation_id);
        need(copy.state == ProjectCopyState::Prepared && copy.code == ProjectCopyCode::None &&
             copy.source.canonical_path == key(row->entry.path),LibraryCode::Conflict);
        LibraryActivationPreview result{current.view.token,project_id,trusted,copy_operation_id,
            copy.mode,copy.seeds_internal_sites,copy.source,copy.target};
        preview_shape(result);
        const auto source = detail::capture_project_copy(row->entry.path);
        const auto destination = detail::capture_project_copy(target);
        checked_pair(result,source,destination);
        db.exec("BEGIN"); expected(snapshot(db),current.view.token,3); db.exec("COMMIT");
        return result;
    });
}
LibraryActivationStatus prepare_library_activation(const QString &library,const QString &parent,
                                                   const LibraryActivationPreview &preview) {
    return bounded([&] {
        preview_shape(preview); const auto trusted = copy_parent(parent);
        need(trusted == preview.copy_parent,LibraryCode::InvalidInput);
        // Reconcile fixed copy evidence before taking project reservations. This
        // read supplies no source authority; the held native checks below still
        // derive the source from the selected library row and recompute the copy.
        const auto copy = inspect_project_copy_operation(trusted,preview.copy_operation_id);
        need(copy.state == ProjectCopyState::Prepared && copy.code == ProjectCopyCode::None &&
             copy.mode == preview.mode && copy.seeds_internal_sites == preview.seeds_internal_sites &&
             copy.source == preview.source && copy.target == preview.target,LibraryCode::Conflict);
        const auto operation_id = QUuid::createUuid().toString(QUuid::WithoutBraces);
        return activation_write(library,operation_id,ActivationWrite::Prepare,
            [&](LibraryDb &db,const Snapshot &current,std::unique_ptr<detail::HeldProjectCopies> &held) {
                const auto &row = selected(current,preview);
                need(current.receipts.size() < max_library_activations,LibraryCode::BudgetExceeded);
                const auto target = fixed_target(trusted,preview.copy_operation_id);
                project_files(db.path,row.entry.path,target);
                held = std::make_unique<detail::HeldProjectCopies>(row.entry.path,target);
                checked_pair(preview,held->first(),held->second());
                LibraryActivationReceipt result;
                result.token = {current.view.token.library_uuid,operation_id,{},1};
                result.prepared = preview; result.source_folder = row.folder; result.source_folder_key = row.folder_key;
                result.token.receipt_digest = receipt_digest(result);
                insert_receipt(db,result);
                const auto after = snapshot(db); const auto recorded = find_receipt(after,operation_id);
                need(recorded && *recorded == result,LibraryCode::RecoveryRequired);
                return result;
            });
    });
}
LibraryActivationStatus activate_library_copy(const QString &library,const QString &parent,
                                              const LibraryActivationToken &token) {
    return bounded([&] {
        activation_token_shape(token); const auto trusted = copy_parent(parent);
        return activation_write(library,token.operation_id,ActivationWrite::Activate,
            [&](LibraryDb &db,const Snapshot &current,std::unique_ptr<detail::HeldProjectCopies> &held) {
                const auto stored = find_receipt(current,token.operation_id);
                need(stored && stored->token == token && stored->state == LibraryActivationState::Prepared,LibraryCode::Conflict);
                need(trusted == stored->prepared.copy_parent,LibraryCode::InvalidInput);
                selected_receipt(current,*stored);
                const auto &p = stored->prepared;
                const auto row = find(current,p.project_id); need(row,LibraryCode::Conflict);
                const auto target = fixed_target(trusted,p.copy_operation_id);
                project_files(db.path,row->entry.path,target);
                held = std::make_unique<detail::HeldProjectCopies>(row->entry.path,target);
                checked_pair(p,held->first(),held->second());
                LibraryActivationReceipt result = *stored;
                result.state = LibraryActivationState::Activated; result.token.revision = 2;
                need(current.view.token.generation < safe_integer,LibraryCode::BudgetExceeded);
                result.activated_generation = current.view.token.generation+1;
                result.token.receipt_digest = receipt_digest(result);
                bump(db,current);
                db.change("UPDATE library_entries SET path=? WHERE id=?",{p.target.canonical_path,p.project_id});
                db.change("UPDATE library_activations SET state='activated',operation_revision=2,activated_generation=? "
                          "WHERE operation_id=? AND operation_revision=1 AND state='prepared'",
                          {result.activated_generation,token.operation_id});
                const auto after = snapshot(db); const auto recorded = find_receipt(after,token.operation_id);
                need(recorded && *recorded == result,LibraryCode::RecoveryRequired);
                return result;
            });
    });
}
LibraryActivationStatus abandon_library_activation(const QString &library,const LibraryActivationToken &token) {
    return bounded([&] {
        activation_token_shape(token);
        return activation_write(library,token.operation_id,ActivationWrite::Abandon,
            [&](LibraryDb &db,const Snapshot &current,std::unique_ptr<detail::HeldProjectCopies> &) {
                const auto stored = find_receipt(current,token.operation_id);
                need(stored && stored->token == token && stored->state == LibraryActivationState::Prepared,LibraryCode::Conflict);
                LibraryActivationReceipt result = *stored;
                result.state = LibraryActivationState::Abandoned; result.token.revision = 2;
                result.token.receipt_digest = receipt_digest(result);
                db.change("UPDATE library_activations SET state='abandoned',operation_revision=2 "
                          "WHERE operation_id=? AND operation_revision=1 AND state='prepared'",{token.operation_id});
                const auto after = snapshot(db); const auto recorded = find_receipt(after,token.operation_id);
                need(recorded && *recorded == result,LibraryCode::RecoveryRequired);
                return result;
            });
    });
}
LibraryActivationInspection inspect_library_activation(const QString &library,const QString &parent,
                                                       const QString &library_uuid,const QString &operation_id) {
    return bounded([&] {
        need(uuid(library_uuid) && uuid(operation_id),LibraryCode::InvalidInput);
        const auto trusted = key(parent); // Historical inspection need not open this directory.
        LibraryDb db(library,true); db.exec("BEGIN"); const auto current = snapshot(db); db.exec("COMMIT");
        need(current.view.token.schema == 3,LibraryCode::UnsupportedFormat);
        need(current.view.token.library_uuid == library_uuid,LibraryCode::Conflict);
        const auto stored = find_receipt(current,operation_id); need(stored,LibraryCode::Conflict);
        need(trusted == stored->prepared.copy_parent,LibraryCode::InvalidInput);
        LibraryActivationInspection result{current.view.token,*stored};
        if (stored->state == LibraryActivationState::Abandoned) {
            result.condition = LibraryActivationCondition::Abandoned; result.code = LibraryCode::None;
        } else if (stored->state == LibraryActivationState::Activated) {
            if (current.view.token.generation > stored->activated_generation) {
                result.condition = LibraryActivationCondition::ActivatedSuperseded; result.code = LibraryCode::None;
            } else {
                const auto row = find(current,stored->prepared.project_id);
                const bool matches = row && key(row->entry.path) == stored->prepared.target.canonical_path &&
                    row->folder == stored->source_folder && row->folder_key == stored->source_folder_key &&
                    current.view.token.canonical_path == stored->prepared.library.canonical_path;
                result.condition = matches ? LibraryActivationCondition::ActivatedCurrent : LibraryActivationCondition::Inconsistent;
                result.code = matches ? LibraryCode::None : LibraryCode::Conflict;
            }
        } else if (!(current.view.token == stored->prepared.library)) {
            result.condition = LibraryActivationCondition::PreparedStale; result.code = LibraryCode::Conflict;
        } else {
            try {
                selected_receipt(current,*stored);
                const auto row = find(current,stored->prepared.project_id); need(row,LibraryCode::Conflict);
                const auto trusted_current = copy_parent(parent);
                need(trusted_current == trusted,LibraryCode::Conflict);
                const auto target = fixed_target(trusted,stored->prepared.copy_operation_id);
                project_files(db.path,row->entry.path,target);
                const auto source = detail::capture_project_copy(row->entry.path);
                const auto destination = detail::capture_project_copy(target);
                checked_pair(stored->prepared,source,destination);
                // Readiness is advisory. Detect authority/receipt changes during
                // independent reads; acceptance always takes fresh reservations.
                db.exec("BEGIN"); const auto after = snapshot(db); db.exec("COMMIT");
                const auto now = find_receipt(after,operation_id);
                const bool unchanged = after.view.token == current.view.token && now && *now == *stored;
                result.condition = unchanged ? LibraryActivationCondition::PreparedCurrent : LibraryActivationCondition::PreparedStale;
                result.code = unchanged ? LibraryCode::None : LibraryCode::Conflict;
            } catch (const LibraryError &error) {
                result.code = error.code;
                result.condition = error.code == LibraryCode::Conflict ? LibraryActivationCondition::PreparedStale :
                    LibraryActivationCondition::Unavailable;
            } catch (const std::exception &) {
                result.condition = LibraryActivationCondition::Unavailable; result.code = LibraryCode::OwnerUnavailable;
            }
        }
        return result;
    });
}
std::vector<LibraryActivationSummary> list_library_activations(const QString &library) {
    return bounded([&] {
        LibraryDb db(library,true); db.exec("BEGIN"); const auto current = snapshot(db);
        need(current.view.token.schema == 3,LibraryCode::UnsupportedFormat);
        std::vector<LibraryActivationSummary> result;
        for (const auto &receipt : current.receipts)
            result.push_back({receipt.token.operation_id,receipt.prepared.project_id,
                receipt.prepared.copy_operation_id,receipt.state,receipt.token.revision});
        db.exec("COMMIT"); return result;
    });
}
namespace {
// Recovery-local guards deliberately do not broaden legacy library behavior.
struct RecoveryBudget {
    QElapsedTimer elapsed;
    quint64 bytes = 0;
    RecoveryBudget() { elapsed.start(); }
    void check() const { need(elapsed.elapsed() <= 20000,LibraryCode::BudgetExceeded); }
    void reserve(quint64 amount) {
        check();
        constexpr quint64 cap = 512ULL*1024*1024;
        need(amount <= cap-bytes,LibraryCode::BudgetExceeded); bytes += amount;
    }
};
QString recovery_lexical(const QString &path) {
    const auto normalized = detail::local_owner_path_lexical(path);
    for (const auto character : normalized)
        need(character != '<' && character != '>' && character != '|' &&
             character != '?' && character != '*',LibraryCode::InvalidInput);
    need(normalized != "/" && !(normalized.size() == 3 && normalized[1] == ':' && normalized[2] == '/'),
         LibraryCode::InvalidInput);
    for (const auto &part : normalized.split('/'))
        need(part.compare(".lmti",Qt::CaseInsensitive) != 0,LibraryCode::InvalidInput);
    return normalized;
}
QString recovery_identity(const QString &path,bool folder) {
    detail::local_owner_path(path,true,folder);
    const QFileInfo info(path);
    need(!info.isSymLink() && !info.isJunction());
    if (!folder) {
        std::error_code error;
        const auto links = std::filesystem::hard_link_count(filesystem_path(path),error);
        need(!error && links == 1);
    }
#ifdef Q_OS_WIN
    const auto native = QDir::toNativeSeparators(path).toStdWString();
    HANDLE handle = CreateFileW(native.c_str(),FILE_READ_ATTRIBUTES,
        FILE_SHARE_READ|FILE_SHARE_WRITE|FILE_SHARE_DELETE,nullptr,OPEN_EXISTING,
        FILE_FLAG_OPEN_REPARSE_POINT | (folder ? FILE_FLAG_BACKUP_SEMANTICS : 0),nullptr);
    need(handle != INVALID_HANDLE_VALUE);
    BY_HANDLE_FILE_INFORMATION value{};
    const auto okay = GetFileInformationByHandle(handle,&value);
    CloseHandle(handle);
    need(okay && !(value.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) &&
         bool(value.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) == folder &&
         (folder || value.nNumberOfLinks == 1));
    return QString("%1:%2:%3:%4:%5").arg(value.dwVolumeSerialNumber)
        .arg(value.nFileIndexHigh).arg(value.nFileIndexLow)
        .arg(value.ftCreationTime.dwHighDateTime).arg(value.ftCreationTime.dwLowDateTime);
#else
    struct stat value{};
    need(::lstat(path.toUtf8().constData(),&value) == 0 &&
         (folder ? S_ISDIR(value.st_mode) : S_ISREG(value.st_mode)) &&
         (folder || value.st_nlink == 1));
    return QString("%1:%2").arg(static_cast<qulonglong>(value.st_dev))
        .arg(static_cast<qulonglong>(value.st_ino));
#endif
}
QString recovery_file(const QString &path,qint64 cap,RecoveryBudget &budget) {
    const auto identity = recovery_identity(path,false);
    const auto size = QFileInfo(path).size();
    need(size >= 0 && size <= cap,LibraryCode::BudgetExceeded);
    budget.reserve(static_cast<quint64>(size));
    QFile file(path); need(file.open(QIODevice::ReadOnly) && file.size() == size);
    QCryptographicHash content(QCryptographicHash::Sha256);
    qint64 consumed = 0;
    while (consumed < size) {
        budget.check();
        const auto bytes = file.read(std::min<qint64>(64*1024,size-consumed));
        need(!bytes.isEmpty() && file.error() == QFileDevice::NoError);
        consumed += bytes.size(); content.addData(bytes);
    }
    need(file.read(1).isEmpty() && file.error() == QFileDevice::NoError && file.atEnd() &&
         file.size() == size && QFileInfo(path).size() == size &&
         recovery_identity(path,false) == identity);
    QCryptographicHash hash(QCryptographicHash::Sha256);
    field(hash,identity.toUtf8()); field(hash,QByteArray::number(size)); field(hash,content.result());
    return QString::fromLatin1(hash.result().toHex());
}
bool recovery_exists(const QString &path) {
    detail::local_owner_path(path,false);
    std::error_code error;
    const auto status = std::filesystem::symlink_status(filesystem_path(path),error);
    if (error == std::errc::no_such_file_or_directory) return false;
    need(!error);
    return status.type() != std::filesystem::file_type::not_found;
}
QString recovery_database_files(const QString &path,bool backup,RecoveryBudget &budget) {
    QCryptographicHash hash(QCryptographicHash::Sha256);
    field(hash,recovery_file(path,64*1024*1024,budget).toUtf8());
    const bool wal = recovery_exists(path+"-wal"), shm = recovery_exists(path+"-shm");
    const bool journal = recovery_exists(path+"-journal");
    if (backup) need(!wal && !shm && !journal);
    else {
        need(!wal || shm);
        need(!shm || wal);
        if (shm) {
            field(hash,recovery_identity(path+"-shm",false).toUtf8());
            need(QFileInfo(path+"-shm").size() <= 1024*1024,LibraryCode::BudgetExceeded);
        }
        if (journal) need(QFileInfo(path+"-journal").size() == 0);
        if (wal) field(hash,recovery_file(path+"-wal",128*1024*1024,budget).toUtf8());
        if (journal) field(hash,recovery_file(path+"-journal",128*1024*1024,budget).toUtf8());
    }
    field(hash,QByteArray::number(wal)); field(hash,QByteArray::number(shm));
    field(hash,QByteArray::number(journal));
    return QString::fromLatin1(hash.result().toHex());
}
QString recovery_snapshot_digest(const Snapshot &value) {
    QCryptographicHash hash(QCryptographicHash::Sha256);
    field(hash,QByteArrayLiteral("lmti.library.recovery.snapshot.v1"));
    field(hash,rows_digest(value.rows,true).toUtf8());
    field(hash,QJsonDocument(QJsonArray{value.view.token.schema,value.view.token.canonical_path,
        value.view.token.library_uuid,value.view.token.generation,value.view.token.digest,
        value.view.upgrade_operation_id,value.view.legacy_digest,
        value.view.activation_format_operation_id,value.view.activation_format_backup_digest})
        .toJson(QJsonDocument::Compact));
    std::vector<QString> receipts;
    for (const auto &receipt : value.receipts)
        receipts.push_back(receipt.token.operation_id+":"+receipt.token.receipt_digest);
    std::sort(receipts.begin(),receipts.end());
    for (const auto &receipt : receipts) field(hash,receipt.toUtf8());
    return QString::fromLatin1(hash.result().toHex());
}
struct RecoveryDatabase { Snapshot value; QString files; };
RecoveryDatabase recovery_read(const QString &path,bool backup,RecoveryBudget &budget) {
    const auto before = recovery_database_files(path,backup,budget);
    // Charge another full main/WAL allowance for the bounded typed SQLite read.
    budget.reserve(static_cast<quint64>(QFileInfo(path).size()));
    if (!backup && recovery_exists(path+"-wal"))
        budget.reserve(static_cast<quint64>(QFileInfo(path+"-wal").size()));
    LibraryDb db(path,true,false,false,backup);
    db.exec("BEGIN");
    auto value = snapshot(db,true);
    budget.check(); db.exec("COMMIT");
    const auto after = recovery_database_files(path,backup,budget);
    need(before == after,LibraryCode::Conflict);
    return {std::move(value),after};
}
QString recovery_filename(const std::filesystem::path &path) {
#ifdef Q_OS_WIN
    return QString::fromStdWString(path.filename().wstring());
#else
    return QString::fromUtf8(path.filename().string());
#endif
}
struct RecoveryArtifact {
    LibraryBackupObservation observation;
    QString fingerprint, library_uuid, upgrade_id, legacy_digest, bindings_digest;
    qint64 generation = 0;
};
struct RecoveryScan {
    std::vector<RecoveryArtifact> artifacts;
    std::size_t examined = 0;
    LibraryCode code = LibraryCode::None;
    QString digest;
};
RecoveryArtifact recovery_artifact(const QString &parent,const QString &name,RecoveryBudget &budget) {
    RecoveryArtifact result;
    QCryptographicHash key_hash(QCryptographicHash::Sha256);
    field(key_hash,QByteArrayLiteral("lmti.library.backup.artifact.v1")); field(key_hash,name.toUtf8());
    result.observation.artifact_key = QString::fromLatin1(key_hash.result().toHex());
    if (!uuid(name)) { result.observation.state = LibraryBackupObservationState::Invalid; return result; }
    result.observation.operation_id = name;
    const auto directory = parent+"/"+name;
    try {
        const QFileInfo info(directory);
        need(!info.isSymLink() && !info.isJunction());
        if (info.exists() && !info.isDir()) {
            result.observation.state = LibraryBackupObservationState::Invalid; return result;
        }
        const auto identity = recovery_identity(directory,true);
        std::error_code error;
        std::filesystem::directory_iterator it(filesystem_path(directory),error), end;
        need(!error);
        if (it == end) {
            result.observation.state = LibraryBackupObservationState::Incomplete;
            result.fingerprint = identity; return result;
        }
        const auto leaf = recovery_filename(it->path());
        it.increment(error); need(!error);
        if (it != end || (leaf != "library-v1.sqlite" && leaf != "library-v2.sqlite")) {
            result.observation.state = LibraryBackupObservationState::Invalid;
            result.fingerprint = identity; return result;
        }
        const auto path = directory+"/"+leaf;
        auto read = recovery_read(path,true,budget);
        const auto &value = read.value;
        const auto schema = value.view.token.schema;
        need(schema == (leaf == "library-v1.sqlite" ? 1 : 2),LibraryCode::UnsupportedFormat);
        result.observation.schema = schema;
        result.observation.full_snapshot_digest = schema == 1 ? rows_digest(value.rows,true) : full_v2_digest(value);
        result.observation.state = LibraryBackupObservationState::Foreign; // Classification follows source reads.
        result.library_uuid = value.view.token.library_uuid; result.generation = value.view.token.generation;
        result.bindings_digest = value.view.token.digest;
        result.upgrade_id = value.view.upgrade_operation_id; result.legacy_digest = value.view.legacy_digest;
        need(recovery_identity(directory,true) == identity,LibraryCode::Conflict);
        QCryptographicHash hash(QCryptographicHash::Sha256);
        field(hash,identity.toUtf8()); field(hash,leaf.toUtf8()); field(hash,read.files.toUtf8());
        field(hash,result.observation.full_snapshot_digest->toUtf8());
        result.fingerprint = QString::fromLatin1(hash.result().toHex());
    } catch (const LibraryError &error) {
        if (error.code == LibraryCode::BudgetExceeded) throw;
        result.observation.state = error.code == LibraryCode::UnsupportedFormat ?
            LibraryBackupObservationState::Invalid : LibraryBackupObservationState::Unavailable;
    } catch (const std::exception &) { result.observation.state = LibraryBackupObservationState::Unavailable; }
    return result;
}
RecoveryScan recovery_scan(const QString &parent,RecoveryBudget &budget) {
    RecoveryScan result;
    try {
        const auto identity = recovery_identity(parent,true);
        std::error_code error;
        std::filesystem::directory_iterator it(filesystem_path(parent),error), end;
        need(!error);
        while (it != end) {
            budget.check(); ++result.examined;
            need(result.examined <= max_library_backup_recovery_entries,LibraryCode::BudgetExceeded);
            const auto name = recovery_filename(it->path());
            // Iterator status is no-follow. Access/race failures cannot look like empty coverage.
            const auto status = it->symlink_status(error); need(!error);
            auto artifact = recovery_artifact(parent,name,budget);
            if (std::filesystem::is_symlink(status)) artifact.observation.state = LibraryBackupObservationState::Unavailable;
            result.artifacts.push_back(std::move(artifact));
            it.increment(error); need(!error);
        }
        need(recovery_identity(parent,true) == identity,LibraryCode::Conflict);
        std::sort(result.artifacts.begin(),result.artifacts.end(),[](const auto &a,const auto &b) {
            return a.observation.artifact_key < b.observation.artifact_key;
        });
        QCryptographicHash hash(QCryptographicHash::Sha256);
        field(hash,QByteArrayLiteral("lmti.library.backup.parent.v1")); field(hash,identity.toUtf8());
        for (const auto &artifact : result.artifacts) {
            field(hash,artifact.observation.artifact_key.toUtf8()); field(hash,artifact.fingerprint.toUtf8());
            field(hash,QByteArray::number(static_cast<int>(artifact.observation.state)));
            if (artifact.observation.state == LibraryBackupObservationState::Unavailable)
                result.code = LibraryCode::OwnerUnavailable;
        }
        result.digest = QString::fromLatin1(hash.result().toHex());
    } catch (const LibraryError &error) { result.code = error.code; }
    catch (const std::exception &) { result.code = LibraryCode::OwnerUnavailable; }
    if (result.code != LibraryCode::None) {
        result.digest.clear();
        std::sort(result.artifacts.begin(),result.artifacts.end(),[](const auto &a,const auto &b) {
            return a.observation.artifact_key < b.observation.artifact_key;
        });
    }
    return result;
}
} // namespace

LibraryUpgradeRecovery inspect_library_upgrade_recovery(const QString &library,const QString &parent,
                                                        const LibraryFormatPreview &preview) {
    // All input validation happens before path probes, including lexical pin equality.
    try {
        token_shape(preview.source);
        need(preview.source.schema == 1 || preview.source.schema == 2,LibraryCode::InvalidInput);
        need(hex(preview.full_snapshot_digest),LibraryCode::InvalidInput);
        need(preview.source.schema != 1 || preview.full_snapshot_digest == preview.source.digest,
             LibraryCode::InvalidInput);
        recovery_lexical(library); recovery_lexical(parent);
        need(key(library) == preview.source.canonical_path &&
             !key(library).startsWith(key(parent)+"/"),LibraryCode::InvalidInput);
    } catch (const std::exception &) { throw LibraryError(LibraryCode::InvalidInput); }
    LibraryUpgradeRecovery result;
    try {
        RecoveryBudget budget;
        const auto a = recovery_scan(parent,budget);
        result.examined_entries = a.examined;
        for (const auto &artifact : a.artifacts) {
            auto observation = artifact.observation;
            // A typed backup is only classified against lineage after both
            // source reads succeed. Do not label it foreign on an early failure.
            if (observation.state == LibraryBackupObservationState::Foreign)
                observation.state = LibraryBackupObservationState::Unavailable;
            if (observation.state != LibraryBackupObservationState::Verified)
                ++result.unresolved_entries;
            result.artifacts.push_back(std::move(observation));
        }
        if (a.code != LibraryCode::None) { result.code = a.code; return result; }
        auto source_a = recovery_read(library,false,budget);
        const auto b = recovery_scan(parent,budget);
        if (b.code != LibraryCode::None) { result.code = b.code; return result; }
        auto source_b = recovery_read(library,false,budget);
        const auto source_digest = recovery_snapshot_digest(source_a.value);
        need(a.digest == b.digest && a.examined == b.examined &&
             source_a.files == source_b.files &&
             source_digest == recovery_snapshot_digest(source_b.value),LibraryCode::Conflict);
        const auto &current = source_b.value;
        result.current = current.view.token;
        QCryptographicHash current_hash(QCryptographicHash::Sha256);
        field(current_hash,QByteArrayLiteral("lmti.library.recovery.current.v1"));
        field(current_hash,source_digest.toUtf8()); field(current_hash,source_b.files.toUtf8());
        result.current_snapshot_digest = QString::fromLatin1(current_hash.result().toHex());
        bool original = current.view.token == preview.source;
        if (original && preview.source.schema == 2)
            original = full_v2_digest(current) == preview.full_snapshot_digest;
        QString committed;
        if (preview.source.schema == 1 && current.view.token.schema >= 2 &&
            current.view.legacy_digest == preview.full_snapshot_digest)
            committed = current.view.upgrade_operation_id;
        if (preview.source.schema == 2 && current.view.token.schema == 3 &&
            current.view.token.library_uuid == preview.source.library_uuid &&
            current.view.activation_format_backup_digest == preview.full_snapshot_digest)
            committed = current.view.activation_format_operation_id;
        bool committed_backup = false;
        result.artifacts.clear(); result.unresolved_entries = 0;
        for (auto artifact : a.artifacts) {
            auto &row = artifact.observation;
            if (row.schema && row.full_snapshot_digest) {
                row.matches_expected = *row.schema == preview.source.schema &&
                    *row.full_snapshot_digest == preview.full_snapshot_digest &&
                    (*row.schema == 1 || (artifact.library_uuid == preview.source.library_uuid &&
                     artifact.generation == preview.source.generation &&
                     artifact.bindings_digest == preview.source.digest));
                if (*row.schema == 1 && current.view.token.schema >= 2 &&
                    row.operation_id == current.view.upgrade_operation_id &&
                    *row.full_snapshot_digest == current.view.legacy_digest)
                    row.receipt_match = LibraryBackupReceiptMatch::UpgradeV1;
                if (*row.schema == 2 && current.view.token.schema == 3 &&
                    row.operation_id == current.view.activation_format_operation_id &&
                    *row.full_snapshot_digest == current.view.activation_format_backup_digest &&
                    artifact.library_uuid == current.view.token.library_uuid &&
                    artifact.generation <= current.view.token.generation &&
                    artifact.upgrade_id == current.view.upgrade_operation_id &&
                    artifact.legacy_digest == current.view.legacy_digest)
                    row.receipt_match = LibraryBackupReceiptMatch::UpgradeV2;
                if (row.matches_expected || row.receipt_match != LibraryBackupReceiptMatch::None)
                    row.state = LibraryBackupObservationState::Verified;
                if (!committed.isEmpty() && row.matches_expected && row.operation_id == committed &&
                    row.receipt_match == (preview.source.schema == 1 ?
                        LibraryBackupReceiptMatch::UpgradeV1 : LibraryBackupReceiptMatch::UpgradeV2))
                    committed_backup = true;
            }
            if (row.state != LibraryBackupObservationState::Verified) ++result.unresolved_entries;
            result.artifacts.push_back(std::move(row));
        }
        if (!committed.isEmpty()) result.committed_operation_id = committed;
        if (result.unresolved_entries || (!original && !committed_backup)) return result;
        result.complete = true; result.code = LibraryCode::None;
        result.parent_snapshot_digest = a.digest;
        result.condition = original ? LibraryUpgradeRecoveryCondition::OriginalStateVerified :
            LibraryUpgradeRecoveryCondition::CommittedStateVerified;
    } catch (const LibraryError &error) { result.code = error.code; }
    catch (const std::exception &) { result.code = LibraryCode::OwnerUnavailable; }
    return result;
}
} // namespace lmti
