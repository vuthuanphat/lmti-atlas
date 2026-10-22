// Included only by project_store.cpp: sole SQL owner, no externally usable DB API.
namespace lmti {
namespace {
using DAC = DesiredAssetCode;
[[noreturn]] void desired_fail(DAC code) { throw DesiredAssetError(code); }
void desired_need(bool value, DAC code = DAC::InvalidInput) { if (!value) desired_fail(code); }
constexpr std::int64_t desired_max_revision = 9007199254740990LL;
constexpr std::size_t desired_max_receipts = 4096;
constexpr qsizetype desired_max_ledger_bytes = 8 * 1024 * 1024;
QString desired_q(const std::string &value) { return QString::fromStdString(value); }
bool desired_hex(const std::string &value) {
    return value.size() == 64 && std::all_of(value.begin(),value.end(),[](char c) {
        return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'); });
}
bool desired_uuid(const std::string &value) {
    return value.size() == 36 && detail::original_read::uuid(desired_q(value));
}
void desired_text(const std::string &value, qsizetype cap) {
    const auto q = desired_q(value);
    desired_need(!value.empty() && static_cast<qsizetype>(value.size()) <= cap &&
        q.isValidUtf16() && q.toUtf8() == QByteArray::fromStdString(value) &&
        valid_metadata_utf8(value) && !secret_like(value));
    for (const auto c : q) desired_need(c.unicode() >= 32 && c.unicode() != 127);
}
void desired_id(const std::string &value) {
    try { validate_id(value); } catch (...) { desired_fail(DAC::InvalidInput); }
}
QJsonArray desired_values(const DesiredAssetValues &v) { return {v.enabled,v.poll_ms}; }
QJsonArray desired_scope_tuple(const DesiredAssetScope &v) {
    return {desired_q(v.project_id),desired_q(v.store_uuid),desired_q(v.principal_id),
        desired_q(v.grant_fingerprint),desired_q(v.site_id),desired_q(v.environment_id),
        v.allow_internal,v.allow_desired_write};
}
QJsonArray desired_proposal_tuple(const DesiredAssetProposal &v) {
    return {desired_q(v.asset_id),v.expected_revision,desired_values(v.expected),
        desired_values(v.desired),desired_q(v.handoff_digest)};
}
QJsonArray desired_snapshot_tuple(const DesiredAssetSnapshotToken &v) {
    return {v.schema_version,desired_q(v.project_id),v.canonical_path,desired_q(v.store_uuid),
        v.revision,desired_q(v.content_digest),desired_q(v.registry_digest),desired_q(v.ledger_digest)};
}
QJsonArray desired_chain_tuple(const std::vector<OriginalPhysicalIdentity> &chain) {
    QJsonArray out; for (const auto &r : chain) out.append(QJsonArray{r.dev,r.ino,r.birthtime_ns}); return out;
}
QJsonArray desired_original_tuple(const DesiredAssetOriginalExpected &v) {
    return {v.schema,desired_q(v.store_uuid),QJsonArray{1,detail::original_read::path_text(v.physical.path),
        QStringLiteral("file"),QStringLiteral("present"),desired_chain_tuple(v.physical.chain)}};
}
std::string desired_hash(const char *domain, const QJsonArray &tuple) {
    QCryptographicHash h(QCryptographicHash::Sha256);
    h.addData(QByteArray(domain)); h.addData(QByteArrayLiteral("\n"));
    h.addData(QJsonDocument(tuple).toJson(QJsonDocument::Compact));
    return h.result().toHex().toStdString();
}
std::string desired_original_digest(const DesiredAssetOriginalExpected &v) {
    return desired_hash("lmti.project.desired-asset-original.v1",desired_original_tuple(v));
}
std::string desired_request_digest(const DesiredAssetReviewToken &v) {
    return desired_hash("lmti.project.desired-asset-request.v1",{1,desired_q(v.operation_id),
        desired_scope_tuple(v.scope),desired_q(v.original_target_digest),
        desired_snapshot_tuple(v.snapshot),desired_proposal_tuple(v.proposal)});
}
QJsonArray desired_format_tuple(const ProjectReceiptFormat &v, bool with_digest) {
    QJsonArray a{v.singleton,desired_q(v.upgrade_operation_id),desired_q(v.store_uuid),v.from_schema,
        v.source_revision,desired_q(v.source_content_digest),desired_q(v.source_registry_digest),desired_q(v.backup_sha256)};
    if (with_digest) a.append(desired_q(v.format_digest)); return a;
}
QJsonArray desired_receipt_tuple(const DesiredAssetReceipt &v, bool with_digest) {
    QJsonArray a{desired_q(v.origin_store_uuid),desired_q(v.operation_id),desired_q(v.request_digest),
        desired_q(v.handoff_digest),desired_q(v.project_id),desired_q(v.principal_id),desired_q(v.grant_fingerprint),
        desired_q(v.site_id),desired_q(v.environment_id),v.allow_internal,desired_q(v.asset_id),
        desired_q(name(v.effective_privacy)),v.base_revision,v.committed_revision,
        v.expected.enabled,v.expected.poll_ms,v.desired.enabled,v.desired.poll_ms,
        desired_q(v.original_target_digest),desired_q(v.before_content_digest),desired_q(v.after_content_digest),
        desired_q(v.registry_digest),desired_q(v.target_ancestry_digest)};
    if (with_digest) a.append(desired_q(v.receipt_digest)); return a;
}
const QString desired_format_ddl = QStringLiteral(
    "CREATE TABLE proposal_format(singleton INTEGER PRIMARY KEY CHECK(singleton=1),"
    "upgrade_operation_id TEXT NOT NULL,store_uuid TEXT NOT NULL,from_schema INTEGER NOT NULL CHECK(from_schema=2),"
    "source_revision INTEGER NOT NULL,source_content_digest TEXT NOT NULL,source_registry_digest TEXT NOT NULL,"
    "backup_sha256 TEXT NOT NULL,format_digest TEXT NOT NULL)");
const QString desired_receipts_ddl = QStringLiteral(
    "CREATE TABLE desired_asset_receipts(origin_store_uuid TEXT NOT NULL,operation_id TEXT NOT NULL,"
    "request_digest TEXT NOT NULL,handoff_digest TEXT NOT NULL,project_id TEXT NOT NULL,principal_id TEXT NOT NULL,"
    "grant_fingerprint TEXT NOT NULL,site_id TEXT NOT NULL,environment_id TEXT NOT NULL,"
    "allow_internal INTEGER NOT NULL CHECK(allow_internal IN(0,1)),asset_id TEXT NOT NULL,"
    "effective_privacy TEXT NOT NULL CHECK(effective_privacy IN('public','internal')),"
    "base_revision INTEGER NOT NULL,committed_revision INTEGER NOT NULL,"
    "expected_enabled INTEGER NOT NULL CHECK(expected_enabled IN(0,1)),expected_poll_ms INTEGER NOT NULL,"
    "desired_enabled INTEGER NOT NULL CHECK(desired_enabled IN(0,1)),desired_poll_ms INTEGER NOT NULL,"
    "original_target_digest TEXT NOT NULL,before_content_digest TEXT NOT NULL,after_content_digest TEXT NOT NULL,"
    "registry_digest TEXT NOT NULL,target_ancestry_digest TEXT NOT NULL,receipt_digest TEXT NOT NULL,"
    "PRIMARY KEY(origin_store_uuid,operation_id))");
using DesiredSchema = std::map<QString,std::array<QString,3>>;
DesiredSchema desired_schema_rows(Database &db) {
    QSqlQuery q(db.db);
    desired_need(q.exec("SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY name"),DAC::OwnerUnavailable);
    DesiredSchema rows;
    while (q.next()) {
        db.check_copy_budget();
        desired_need(rows.size() < 100,DAC::OwnerUnavailable);
        for (int i=0;i<4;++i) desired_need(q.value(i).toString().size() <= 8192,DAC::OwnerUnavailable);
        desired_need(rows.emplace(q.value(1).toString(),std::array<QString,3>{q.value(0).toString(),
            q.value(2).toString(),q.value(3).toString().simplified()}).second,DAC::OwnerUnavailable);
    }
    desired_need(!q.lastError().isValid(),DAC::OwnerUnavailable);
    return rows;
}
void check_receipt_schema(Database &db, bool upgrading) {
    // Build canonical DDL in memory; never normalize the source schema.
    Database expected(Database::InMemory{});
    schema(expected,2);
    if (!upgrading) { expected.exec(desired_format_ddl); expected.exec(desired_receipts_ddl); }
    desired_need(desired_schema_rows(db) == desired_schema_rows(expected),DAC::UnsupportedSchema);
}
struct DesiredLedger {
    ProjectReceiptFormat format;
    std::vector<DesiredAssetReceipt> receipts;
    qsizetype bytes = 0;
    std::string digest;
};
bool desired_bool(const QVariantList &row, int index) {
    const auto value = integer(row,index); desired_need(value == 0 || value == 1,DAC::OwnerUnavailable); return value == 1;
}
DesiredLedger desired_ledger(Database &db, const ProjectDocument *document = nullptr) {
    DesiredLedger out;
    const auto formats = db.rows("SELECT singleton,upgrade_operation_id,store_uuid,from_schema,source_revision,"
        "source_content_digest,source_registry_digest,backup_sha256,format_digest FROM proposal_format",1);
    desired_need(formats.size()==1,DAC::OwnerUnavailable);
    const auto &f = formats[0];
    desired_need(integer(f,0)==1 && integer(f,3)==2,DAC::OwnerUnavailable);
    out.format={1,str(f,1),str(f,2),2,integer(f,4),str(f,5),str(f,6),str(f,7),str(f,8)};
    const auto meta=metadata(db); const auto lineage=storage_lineage(db,meta.project.id);
    desired_need(desired_uuid(out.format.upgrade_operation_id) && desired_uuid(out.format.store_uuid) &&
        out.format.store_uuid==lineage.store_uuid && out.format.source_revision>=1 &&
        out.format.source_revision<=meta.revision,DAC::OwnerUnavailable);
    for (const auto &h : {out.format.source_content_digest,out.format.source_registry_digest,
             out.format.backup_sha256,out.format.format_digest}) desired_need(desired_hex(h),DAC::OwnerUnavailable);
    desired_need(out.format.format_digest==desired_hash("lmti.project.proposal-format.v1",desired_format_tuple(out.format,false)),DAC::OwnerUnavailable);
    const auto rows=db.rows("SELECT origin_store_uuid,operation_id,request_digest,handoff_digest,project_id,"
        "principal_id,grant_fingerprint,site_id,environment_id,allow_internal,asset_id,effective_privacy,"
        "base_revision,committed_revision,expected_enabled,expected_poll_ms,desired_enabled,desired_poll_ms,"
        "original_target_digest,before_content_digest,after_content_digest,registry_digest,target_ancestry_digest,receipt_digest "
        "FROM desired_asset_receipts ORDER BY origin_store_uuid,operation_id",desired_max_receipts);
    std::set<std::pair<std::string,std::string>> keys;
    std::set<std::int64_t> revisions;
    QJsonArray all;
    for (const auto &r : rows) {
        DesiredAssetReceipt v{str(r,0),str(r,1),str(r,2),str(r,3),str(r,4),str(r,5),str(r,6),str(r,7),str(r,8),
            desired_bool(r,9),str(r,10),parse_privacy(str(r,11)),integer(r,12),integer(r,13),
            {desired_bool(r,14),0},{desired_bool(r,16),0},str(r,18),str(r,19),str(r,20),str(r,21),str(r,22),str(r,23)};
        const auto p0=integer(r,15),p1=integer(r,17);
        desired_need(p0>=100 && p0<=3600000 && p1>=100 && p1<=3600000,DAC::OwnerUnavailable);
        v.expected.poll_ms=static_cast<int>(p0);v.desired.poll_ms=static_cast<int>(p1);
        desired_need(desired_uuid(v.origin_store_uuid) && desired_uuid(v.operation_id) && v.origin_store_uuid==lineage.store_uuid &&
            v.project_id==meta.project.id && v.base_revision>=out.format.source_revision &&
            v.base_revision<desired_max_revision && v.committed_revision==v.base_revision+1 &&
            v.committed_revision<=meta.revision && v.expected!=v.desired &&
            (v.allow_internal || v.effective_privacy==Privacy::Public),DAC::OwnerUnavailable);
        desired_id(v.project_id);desired_id(v.asset_id);desired_id(v.site_id);desired_id(v.environment_id);desired_text(v.principal_id,160);
        for (const auto &h : {v.request_digest,v.handoff_digest,v.grant_fingerprint,v.original_target_digest,
                 v.before_content_digest,v.after_content_digest,v.registry_digest,v.target_ancestry_digest,v.receipt_digest})
            desired_need(desired_hex(h),DAC::OwnerUnavailable);
        desired_need(keys.emplace(v.origin_store_uuid,v.operation_id).second && revisions.insert(v.committed_revision).second &&
            v.receipt_digest==desired_hash("lmti.project.desired-asset-receipt.v1",desired_receipt_tuple(v,false)),DAC::OwnerUnavailable);
        const auto tuple=desired_receipt_tuple(v,true);
        out.bytes+=QJsonDocument(tuple).toJson(QJsonDocument::Compact).size();
        desired_need(out.bytes<=desired_max_ledger_bytes,DAC::BudgetExceeded);
        all.append(tuple);out.receipts.push_back(std::move(v));
    }
    if (document) desired_need(document->project.id==meta.project.id && document->topology.revision==meta.revision,DAC::OwnerUnavailable);
    out.digest=desired_hash("lmti.project.receipt-ledger.v1",{desired_format_tuple(out.format,true),all});
    return out;
}
void validate_receipt_rows(Database &db,const ProjectDocument *document) {
    try { (void)desired_ledger(db,document); }
    catch (const DesiredAssetError &e) {
        if (e.code==DAC::BudgetExceeded) throw;
        desired_fail(DAC::OwnerUnavailable);
    }
}
#ifdef LMTI_DESIRED_ASSET_OWNER_TEST_HOOKS
thread_local DesiredAssetOwnerTestHook desired_hook = nullptr;
void desired_point(DesiredAssetOwnerTestPoint point) { if (desired_hook) desired_hook(point); }
#endif
void desired_original_shape(const QString &fixed,const DesiredAssetOriginalExpected &original,int schema_version) {
    desired_need(original.schema==schema_version && desired_uuid(original.store_uuid));
    detail::original_read::physical_shape(original.physical,false);
    desired_need(detail::original_read::path_text(fixed)==detail::original_read::path_text(original.physical.path),DAC::ScopeDenied);
}
void desired_original_for_scope(const QString &fixed,const DesiredAssetScope &scope,const DesiredAssetOriginalExpected &original) {
    validate_desired_asset_scope(scope);
    desired_original_shape(fixed,original,3);
    desired_need(original.store_uuid==scope.store_uuid,DAC::ScopeDenied);
}
[[noreturn]] void desired_map_exception() {
    try { throw; }
    catch (const DesiredAssetError &) { throw; }
    catch (const OriginalReadError &e) {
        switch(e.code) {
        case OriginalReadCode::InvalidInput: desired_fail(DAC::InvalidInput);
        case OriginalReadCode::ScopeDenied: desired_fail(DAC::ScopeDenied);
        case OriginalReadCode::ConfigChanged: desired_fail(DAC::ConfigChanged);
        case OriginalReadCode::NotSupported: desired_fail(DAC::UnsupportedSchema);
        case OriginalReadCode::LimitExceeded: desired_fail(DAC::BudgetExceeded);
        case OriginalReadCode::RecoveryRequired: desired_fail(DAC::RecoveryRequired);
        default: desired_fail(DAC::OwnerUnavailable);
        }
    }
    catch (const ProjectCopyError &e) {
        if (e.code==ProjectCopyCode::BudgetExceeded) desired_fail(DAC::BudgetExceeded);
        desired_fail(DAC::OwnerUnavailable);
    }
    catch (...) { desired_fail(DAC::OwnerUnavailable); }
}
#ifdef Q_OS_WIN
class DesiredNamespace {
    detail::original_read::NamespaceLease lease_;
  public:
    QString path;
    explicit DesiredNamespace(const QString &fixed,const DesiredAssetOriginalExpected &original) : path(fixed) {
        lease_.retain_target(original.physical,64ULL*1024*1024);
        sidecars();
    }
    void sidecars(bool writing=false) const {
        // Short-lived handles allow legitimate SQLite journal removal.
        detail::original_read::NamespaceLease temporary;
        std::array<bool,3> present{};
        for (std::size_t i=0;i<detail::original_read::suffixes.size();++i) {
            const auto file=path+QString::fromLatin1(detail::original_read::suffixes[i]);
            present[i]=detail::original_read::present_leaf(file);
            if(!present[i])continue;
            const auto held=temporary.retain(file,false);
            desired_need(held.size<=(i==1?1024ULL*1024:128ULL*1024*1024),DAC::BudgetExceeded);
            if(i==2&&!writing)desired_need(held.size==0,DAC::OwnerUnavailable);
        }
        desired_need(present[0]==present[1],DAC::OwnerUnavailable);
    }
};
class DesiredDirectory {
    detail::original_read::NamespaceLease lease_;
  public:
    OriginalDirectoryExpected original;
    explicit DesiredDirectory(const QString &fixed,const OriginalDirectoryExpected *expected=nullptr) {
        const auto path=detail::original_read::path_text(fixed);
        const auto parts=detail::original_read::parts(path);
        if (expected) {
            desired_need(detail::original_read::path_text(expected->path)==path && expected->chain.size()==static_cast<std::size_t>(parts.size()),DAC::ScopeDenied);
            for (const auto &id:expected->chain) detail::original_read::identity_shape(id);
        }
        original.path=path;
        for (qsizetype i=0;i<parts.size();++i)
            original.chain.push_back(lease_.retain(parts[i],true,expected?&expected->chain[static_cast<std::size_t>(i)]:nullptr).identity);
    }
};
class DesiredBackupLease {
    detail::original_read::NamespaceLease lease_;
  public:
    void retain_created(const QString &path) { (void)lease_.retain(path,false); }
};
#else
class DesiredNamespace {
  public:
    QString path;
    DesiredNamespace(const QString &,const DesiredAssetOriginalExpected &) { desired_fail(DAC::UnsupportedSchema); }
    void sidecars(bool=false) const {}
};
class DesiredDirectory {
  public:
    OriginalDirectoryExpected original;
    DesiredDirectory(const QString &,const OriginalDirectoryExpected * = nullptr) { desired_fail(DAC::UnsupportedSchema); }
};
class DesiredBackupLease {
  public:
    void retain_created(const QString &) { desired_fail(DAC::UnsupportedSchema); }
};
#endif
struct DesiredCapture {
    ProjectDocument document;
    IdentityRegistry registry;
    DesiredLedger ledger;
    DesiredAssetSnapshotToken snapshot;
};
void desired_identity(Database &db,int expected_schema,const std::string &project,const std::string &uuid) {
    const auto version=db.check(project_application);
    desired_need(version==expected_schema,DAC::UnsupportedSchema);
    known_project_columns(db,version);
    const auto m=metadata(db);const auto l=storage_lineage(db,m.project.id);
    desired_need(m.project.id==project && l.store_uuid==uuid,DAC::ConfigChanged);
}
DesiredCapture desired_capture(Database &db,const std::string &project,const std::string &uuid) {
    desired_identity(db,3,project,uuid);
    DesiredCapture c;
    c.document=read_document(db,3,&c.registry);
    c.ledger=desired_ledger(db,&c.document);
    c.snapshot={3,project,lineage_path(db.file_path),uuid,c.document.topology.revision,
        owned_digest(c.document).toStdString(),registry_digest(c.registry).toStdString(),c.ledger.digest};
    db.check_copy_budget();return c;
}
class DesiredConnection {
    // Destruction order closes writer, then keeper, then namespace lease.
    DesiredNamespace namespace_;
    std::unique_ptr<Database> keeper_;
  public:
    std::unique_ptr<Database> db;
    DesiredConnection(const QString &fixed,const DesiredAssetOriginalExpected &original,bool write)
        : namespace_(fixed,original) {
        if (write) {
            keeper_=std::make_unique<Database>(fixed,true);
            keeper_->copy_budget=true;keeper_->copy_timer.start();keeper_->exec("BEGIN");
            keeper_->check(project_application);
        }
        db=std::make_unique<Database>(fixed,!write,write);
        db->copy_budget=true;db->copy_timer.start();
        if (write) { db->exec("PRAGMA trusted_schema=OFF");db->exec("PRAGMA foreign_keys=ON"); }
        db->exec(write?"BEGIN IMMEDIATE":"BEGIN");
    }
    ~DesiredConnection() {
        if (db) { db->copy_budget=false;try { db->exec("ROLLBACK"); } catch (...) {} db.reset(); }
        if (keeper_) { keeper_->copy_budget=false;try { keeper_->exec("ROLLBACK"); } catch (...) {} keeper_.reset(); }
    }
    void before_write() const { db->check_copy_budget();namespace_.sidecars(); }
    void prepare_commit() {
        db->check_copy_budget();namespace_.sidecars(true);
        if(keeper_) {
            keeper_->copy_budget=false;keeper_->exec("ROLLBACK");keeper_.reset();
        }
    }
    bool rollback() noexcept {
        db->copy_budget=false;
        try { db->exec("ROLLBACK");return true; } catch(...) { return false; }
    }
};
template<class Rows> const typename Rows::value_type &desired_find(const Rows &rows,const std::string &id) {
    const auto found=std::find_if(rows.begin(),rows.end(),[&](const auto &v){return v.id==id;});
    desired_need(found!=rows.end(),DAC::OwnerUnavailable);return *found;
}
const AssetPlacement &desired_placement(const ProjectDocument &d,const std::string &id) {
    const auto &rows=d.structure->asset_placements;
    const auto found=std::find_if(rows.begin(),rows.end(),[&](const auto &v){return v.asset_id==id;});
    desired_need(found!=rows.end(),DAC::OwnerUnavailable);return *found;
}
std::string desired_ancestry(const ProjectDocument &d,const PhysicalAssetRow &asset) {
    const auto &st=*d.structure;
    const auto &site=desired_find(st.sites,asset.path.site_id);
    const auto &environment=desired_find(st.environments,asset.path.environment_id);
    QJsonArray areas,parents;
    for (const auto &id:asset.path.area_ancestors) {
        const auto &r=desired_find(st.areas,id);
        areas.append(QJsonArray{desired_q(r.id),desired_q(r.parent_area_id),desired_q(r.site_id),desired_q(name(r.privacy))});
    }
    for (const auto &id:asset.path.asset_ancestors) {
        const auto &r=desired_find(d.topology.assets,id);const auto &p=desired_placement(d,id);
        parents.append(QJsonArray{desired_q(r.id),desired_q(r.site),desired_q(name(r.privacy)),
            desired_q(p.area_id),desired_q(p.parent_asset_id),desired_q(p.environment_id)});
    }
    return desired_hash("lmti.project.desired-asset-ancestry.v1",{desired_q(d.project.id),desired_q(name(d.project.privacy)),
        desired_q(asset.value.id),desired_q(name(asset.value.privacy)),QJsonArray{desired_q(site.id),desired_q(name(site.privacy))},
        areas,QJsonArray{desired_q(environment.id),desired_q(name(environment.privacy))},parents,desired_q(name(asset.classification))});
}
DesiredAssetState desired_state(const DesiredCapture &c,const DesiredAssetScope &scope,const std::string &id) {
    const auto row=select_desired_asset(c.document,scope,id);
    return {scope.project_id,scope.store_uuid,row.revision,id,scope.site_id,scope.environment_id,
        row.asset.classification,desired_ancestry(c.document,row.asset),row.values};
}
void desired_snapshot_shape(const DesiredAssetSnapshotToken &v) {
    desired_need(v.schema_version==3 && desired_uuid(v.store_uuid) && v.revision>=1 && v.revision<=desired_max_revision);
    desired_id(v.project_id);
    const auto p=detail::original_read::path_text(v.canonical_path);
    desired_need(QDir::cleanPath(p).toCaseFolded()==v.canonical_path);
    desired_need(desired_hex(v.content_digest)&&desired_hex(v.registry_digest)&&desired_hex(v.ledger_digest));
}
void desired_token_shape(const DesiredAssetReviewToken &v) {
    desired_need(v.version==1 && desired_uuid(v.operation_id) && desired_hex(v.original_target_digest) && desired_hex(v.request_digest));
    desired_snapshot_shape(v.snapshot);
    desired_need(normalize_desired_asset_proposal(v.scope,v.proposal)==v.proposal &&
        v.snapshot.project_id==v.scope.project_id && v.snapshot.store_uuid==v.scope.store_uuid &&
        v.snapshot.revision==v.proposal.expected_revision && v.diff==DesiredAssetDiff{v.proposal.asset_id,v.proposal.expected,v.proposal.desired} &&
        v.request_digest==desired_request_digest(v));
}
bool desired_receipt_authorized(const DesiredCapture &c,const DesiredAssetScope &scope,
    const DesiredAssetOriginalExpected &original,const DesiredAssetReceipt &v) {
    if (v.original_target_digest!=desired_original_digest(original) || v.origin_store_uuid!=scope.store_uuid ||
        v.project_id!=scope.project_id || v.principal_id!=scope.principal_id || v.grant_fingerprint!=scope.grant_fingerprint ||
        v.site_id!=scope.site_id || v.environment_id!=scope.environment_id || v.allow_internal!=scope.allow_internal) return false;
    if (scope.allow_internal) return true;
    if (v.effective_privacy!=Privacy::Public || c.document.project.privacy!=Privacy::Public) return false;
    try {
        const auto now=select_desired_asset(c.document,scope,v.asset_id);
        return now.asset.classification==Privacy::Public && desired_ancestry(c.document,now.asset)==v.target_ancestry_digest;
    } catch (const DesiredAssetError &e) { if(e.code==DAC::ScopeDenied) return false;throw; }
}
const DesiredAssetReceipt *desired_find_receipt(const DesiredCapture &c,const std::string &operation) {
    const auto it=std::find_if(c.ledger.receipts.begin(),c.ledger.receipts.end(),[&](const auto &r){return r.operation_id==operation;});
    return it==c.ledger.receipts.end()?nullptr:&*it;
}
void desired_receipt_correlation(const DesiredAssetReceipt &r,const DesiredAssetReviewToken &t) {
    desired_need(r.request_digest==t.request_digest && r.handoff_digest==t.proposal.handoff_digest &&
        r.asset_id==t.proposal.asset_id && r.base_revision==t.proposal.expected_revision &&
        r.expected==t.proposal.expected && r.desired==t.proposal.desired &&
        r.before_content_digest==t.snapshot.content_digest && r.registry_digest==t.snapshot.registry_digest,DAC::OperationConflict);
}
void desired_insert_receipt(Database &db,const DesiredAssetReceipt &r) {
    db.insert("desired_asset_receipts",{desired_q(r.origin_store_uuid),desired_q(r.operation_id),desired_q(r.request_digest),
        desired_q(r.handoff_digest),desired_q(r.project_id),desired_q(r.principal_id),desired_q(r.grant_fingerprint),
        desired_q(r.site_id),desired_q(r.environment_id),r.allow_internal?1:0,desired_q(r.asset_id),desired_q(name(r.effective_privacy)),
        static_cast<qint64>(r.base_revision),static_cast<qint64>(r.committed_revision),r.expected.enabled?1:0,r.expected.poll_ms,
        r.desired.enabled?1:0,r.desired.poll_ms,desired_q(r.original_target_digest),desired_q(r.before_content_digest),
        desired_q(r.after_content_digest),desired_q(r.registry_digest),desired_q(r.target_ancestry_digest),desired_q(r.receipt_digest)});
}
void desired_update(Database &db,const QString &sql,const QVariantList &values) {
    QSqlQuery q(db.db);desired_need(q.prepare(sql),DAC::OwnerUnavailable);
    for(const auto &v:values)q.addBindValue(v);
    desired_need(q.exec()&&q.numRowsAffected()==1,DAC::OwnerUnavailable);
}
} // namespace
#ifdef LMTI_DESIRED_ASSET_OWNER_TEST_HOOKS
void set_desired_asset_owner_test_hook(DesiredAssetOwnerTestHook hook) { desired_hook=hook; }
#endif
struct DesiredAssetReview::Data {
    DesiredAssetReviewToken token;
    std::optional<DesiredAssetState> state;
    std::atomic<bool> consumed{false};
    Data(DesiredAssetReviewToken t,std::optional<DesiredAssetState> s) : token(std::move(t)),state(std::move(s)) {}
};
DesiredAssetReview::DesiredAssetReview(std::shared_ptr<Data> data) : data_(std::move(data)) {}
const DesiredAssetReviewToken &DesiredAssetReview::token() const { desired_need(bool(data_));return data_->token; }
const std::optional<DesiredAssetState> &DesiredAssetReview::reviewed_state() const { desired_need(bool(data_));return data_->state; }
const DesiredAssetDiff &DesiredAssetReview::diff() const { return token().diff; }
DesiredAssetReviewToken export_desired_asset_review(const DesiredAssetReview &review) { return review.token(); }
DesiredAssetState inspect_desired_asset(const QString &fixed,const DesiredAssetScope &scope,
    const DesiredAssetOriginalExpected &original,const std::string &id) {
    try {
        desired_original_for_scope(fixed,scope,original);desired_id(id);
        DesiredConnection held(fixed,original,false);
        const auto capture=desired_capture(*held.db,scope.project_id,scope.store_uuid);
        const auto state=desired_state(capture,scope,id);held.db->check_copy_budget();return state;
    } catch (...) { desired_map_exception(); }
}
DesiredAssetReview preview_desired_asset(const QString &fixed,const DesiredAssetScope &scope,
    const DesiredAssetOriginalExpected &original,const DesiredAssetProposal &proposal) {
    try {
        const auto normalized=normalize_desired_asset_proposal(scope,proposal);
        desired_original_for_scope(fixed,scope,original);
        DesiredConnection held(fixed,original,false);
        const auto capture=desired_capture(*held.db,scope.project_id,scope.store_uuid);
        const auto transition=apply_desired_asset(capture.document,scope,normalized);
        desired_need(capture.ledger.receipts.size()<desired_max_receipts,DAC::BudgetExceeded);
        DesiredAssetReviewToken token{1,QUuid::createUuid().toString(QUuid::WithoutBraces).toStdString(),scope,
            desired_original_digest(original),capture.snapshot,normalized,{},transition.diff};
        token.request_digest=desired_request_digest(token);
        auto state=desired_state(capture,scope,proposal.asset_id);
        held.db->check_copy_budget();return DesiredAssetReview(std::make_shared<DesiredAssetReview::Data>(std::move(token),std::move(state)));
    } catch (...) { desired_map_exception(); }
}
DesiredAssetReview restore_desired_asset_review(const QString &fixed,const DesiredAssetScope &scope,
    const DesiredAssetOriginalExpected &original,const DesiredAssetReviewToken &token) {
    try {
        desired_original_for_scope(fixed,scope,original);validate_desired_asset_scope(token.scope,true);
        desired_need(scope==token.scope,DAC::ScopeDenied);
        desired_token_shape(token);
        desired_need(scope==token.scope && token.original_target_digest==desired_original_digest(original),DAC::ScopeDenied);
        DesiredConnection held(fixed,original,false);
        const auto capture=desired_capture(*held.db,scope.project_id,scope.store_uuid);
        std::optional<DesiredAssetState> state;
        if (const auto *r=desired_find_receipt(capture,token.operation_id)) {
            desired_need(desired_receipt_authorized(capture,scope,original,*r),DAC::ScopeDenied);
            desired_receipt_correlation(*r,token);
        } else {
            (void)select_desired_asset(capture.document,scope,token.proposal.asset_id);
            desired_need(capture.snapshot==token.snapshot,DAC::ConfigChanged);
            (void)apply_desired_asset(capture.document,scope,token.proposal);
            state=desired_state(capture,scope,token.proposal.asset_id);
        }
        return DesiredAssetReview(std::make_shared<DesiredAssetReview::Data>(token,std::move(state)));
    } catch (...) { desired_map_exception(); }
}
std::optional<DesiredAssetReceipt> inspect_desired_asset_receipt(const QString &fixed,const DesiredAssetScope &scope,
    const DesiredAssetOriginalExpected &original,const std::string &operation,const std::string &digest) {
    try {
        desired_original_for_scope(fixed,scope,original);desired_need(desired_uuid(operation)&&desired_hex(digest));
        DesiredConnection held(fixed,original,false);
        const auto capture=desired_capture(*held.db,scope.project_id,scope.store_uuid);
        const auto *r=desired_find_receipt(capture,operation);
        if(!r || !desired_receipt_authorized(capture,scope,original,*r))return std::nullopt;
        desired_need(r->request_digest==digest,DAC::OperationConflict);return *r;
    } catch (...) { desired_map_exception(); }
}
DesiredAssetCommitResult commit_desired_asset(const QString &fixed,const DesiredAssetScope &scope,
    const DesiredAssetOriginalExpected &original,const DesiredAssetReview &review) {
    DesiredAssetCommitResult confirmed,unknown;
    bool attempted=false,committed=false;
    try {
        desired_need(bool(review.data_));const auto &token=review.data_->token;
        desired_original_for_scope(fixed,scope,original);validate_desired_asset_scope(scope,true);
        validate_desired_asset_scope(token.scope,true);desired_need(scope==token.scope,DAC::ScopeDenied);
        desired_token_shape(token);
        desired_need(scope==token.scope && token.original_target_digest==desired_original_digest(original),DAC::ScopeDenied);
        unknown.operation_id=token.operation_id;
        DesiredConnection held(fixed,original,true);
        auto capture=desired_capture(*held.db,scope.project_id,scope.store_uuid);
        if(const auto *r=desired_find_receipt(capture,token.operation_id)) {
            desired_need(desired_receipt_authorized(capture,scope,original,*r),DAC::ScopeDenied);
            desired_receipt_correlation(*r,token);
            return {DesiredAssetCommitState::Confirmed,token.operation_id,*r,true};
        }
        (void)select_desired_asset(capture.document,scope,token.proposal.asset_id);
        desired_need(capture.snapshot==token.snapshot,DAC::ConfigChanged);
        auto transition=apply_desired_asset(capture.document,scope,token.proposal);
        desired_need(capture.ledger.receipts.size()<desired_max_receipts,DAC::BudgetExceeded);
        ++transition.document.topology.revision;
        DesiredAssetReceipt receipt{scope.store_uuid,token.operation_id,token.request_digest,token.proposal.handoff_digest,
            scope.project_id,scope.principal_id,scope.grant_fingerprint,scope.site_id,scope.environment_id,scope.allow_internal,
            token.proposal.asset_id,transition.before.asset.classification,token.proposal.expected_revision,
            transition.document.topology.revision,token.proposal.expected,token.proposal.desired,token.original_target_digest,
            token.snapshot.content_digest,owned_digest(transition.document).toStdString(),token.snapshot.registry_digest,
            desired_ancestry(capture.document,transition.before.asset),{}};
        receipt.receipt_digest=desired_hash("lmti.project.desired-asset-receipt.v1",desired_receipt_tuple(receipt,false));
        desired_need(capture.ledger.bytes+QJsonDocument(desired_receipt_tuple(receipt,true)).toJson(QJsonDocument::Compact).size()
            <=desired_max_ledger_bytes,DAC::BudgetExceeded);
        confirmed={DesiredAssetCommitState::Confirmed,token.operation_id,receipt,false};
        held.before_write();
        desired_need(!review.data_->consumed.exchange(true),DAC::OperationConflict);
        try {
        desired_update(*held.db,"UPDATE assets SET enabled=?,poll=? WHERE id=? AND enabled=? AND poll=?",
            {receipt.desired.enabled?1:0,receipt.desired.poll_ms,desired_q(receipt.asset_id),receipt.expected.enabled?1:0,receipt.expected.poll_ms});
#ifdef LMTI_DESIRED_ASSET_OWNER_TEST_HOOKS
        desired_point(DesiredAssetOwnerTestPoint::AfterAssetUpdateBeforeReceipt);
#endif
        desired_update(*held.db,"UPDATE project SET revision=? WHERE id=? AND revision=?",
            {static_cast<qint64>(receipt.committed_revision),desired_q(scope.project_id),static_cast<qint64>(receipt.base_revision)});
        desired_insert_receipt(*held.db,receipt);
#ifdef LMTI_DESIRED_ASSET_OWNER_TEST_HOOKS
        desired_point(DesiredAssetOwnerTestPoint::BeforeCommit);
#endif
        held.prepare_commit();attempted=true;held.db->exec("COMMIT");
#ifdef LMTI_DESIRED_ASSET_OWNER_TEST_HOOKS
        // Isolated lost-return simulation after actual COMMIT but before the
        // owner observes its result. Production has no intervening operation.
        desired_point(DesiredAssetOwnerTestPoint::AfterCommit);
#endif
        committed=true;
        return confirmed;
        } catch(...) {
            if(committed)return confirmed;
            if(attempted || !held.rollback())return unknown;
            throw;
        }
    } catch (...) {
        if(committed)return confirmed;
        if(attempted)return unknown;
        desired_map_exception();
    }
}
namespace {
void desired_maintenance_scope(const ProjectFormatMaintenanceScope &scope) {
    desired_id(scope.project_id);desired_text(scope.principal_id,160);
    desired_need(desired_uuid(scope.store_uuid)&&desired_hex(scope.grant_fingerprint));
    desired_need(scope.allow_upgrade,DAC::ScopeDenied);
}
QJsonArray desired_maintenance_tuple(const ProjectFormatMaintenanceScope &v) {
    return {desired_q(v.project_id),desired_q(v.store_uuid),desired_q(v.principal_id),
        desired_q(v.grant_fingerprint),v.allow_upgrade};
}
QJsonArray desired_upgrade_snapshot_tuple(const ProjectReceiptUpgradeSnapshot &v) {
    return {v.schema_version,desired_q(v.project_id),v.canonical_path,desired_q(v.store_uuid),
        v.revision,desired_q(v.content_digest),desired_q(v.registry_digest)};
}
std::string desired_upgrade_digest(const ProjectReceiptUpgradeToken &v) {
    return desired_hash("lmti.project.proposal-format-review.v1",{1,desired_q(v.operation_id),
        desired_maintenance_tuple(v.scope),desired_original_tuple(v.original),
        QJsonArray{v.backup_parent.path,desired_chain_tuple(v.backup_parent.chain)},desired_upgrade_snapshot_tuple(v.snapshot)});
}
void desired_upgrade_shape(const QString &fixed,const QString &parent,const ProjectFormatMaintenanceScope &scope,
                           const ProjectReceiptUpgradeToken &token) {
    desired_maintenance_scope(scope);desired_maintenance_scope(token.scope);
    desired_original_shape(fixed,token.original,2);
    desired_need(token.version==1 && desired_uuid(token.operation_id) && desired_hex(token.review_digest));
    desired_need(token.scope==scope && token.original.store_uuid==scope.store_uuid,DAC::ScopeDenied);
    const auto p=detail::original_read::path_text(parent);
    desired_need(detail::original_read::path_text(token.backup_parent.path)==p,DAC::ScopeDenied);
    const auto parts=detail::original_read::parts(p);
    desired_need(token.backup_parent.chain.size()==static_cast<std::size_t>(parts.size()));
    for(const auto &id:token.backup_parent.chain)detail::original_read::identity_shape(id);
    const auto &snap=token.snapshot;
    desired_need(snap.schema_version==2 && snap.project_id==scope.project_id && snap.store_uuid==scope.store_uuid &&
        snap.revision>=1 && snap.revision<=desired_max_revision && desired_hex(snap.content_digest)&&desired_hex(snap.registry_digest));
    desired_need(detail::original_read::path_text(snap.canonical_path).toCaseFolded()==snap.canonical_path);
    desired_need(token.review_digest==desired_upgrade_digest(token));
    // Validate generated leaf spellings before any directory or DB probe.
    (void)detail::original_read::path_text(QDir(p).filePath(desired_q(token.operation_id)+"/project-v2.sqlite"));
}
ProjectReceiptUpgradeSnapshot desired_upgrade_capture(Database &db,const ProjectFormatMaintenanceScope &scope,
    ProjectDocument *document=nullptr,IdentityRegistry *identities=nullptr) {
    desired_identity(db,2,scope.project_id,scope.store_uuid);
    check_receipt_schema(db,true);
    IdentityRegistry registry_rows;
    auto d=read_document(db,2,&registry_rows);
    ProjectReceiptUpgradeSnapshot snap{2,scope.project_id,lineage_path(db.file_path),scope.store_uuid,
        d.topology.revision,owned_digest(d).toStdString(),registry_digest(registry_rows).toStdString()};
    if(document)*document=std::move(d);
    if(identities)*identities=std::move(registry_rows);
    return snap;
}
bool desired_upgrade_same(const ProjectReceiptUpgradeSnapshot &a,const ProjectReceiptUpgradeSnapshot &b) {
    return desired_upgrade_snapshot_tuple(a)==desired_upgrade_snapshot_tuple(b);
}
bool desired_format_matches(const ProjectReceiptFormat &f,const ProjectReceiptUpgradeToken &t) {
    return f.upgrade_operation_id==t.operation_id && f.store_uuid==t.scope.store_uuid && f.from_schema==2 &&
        f.source_revision==t.snapshot.revision && f.source_content_digest==t.snapshot.content_digest &&
        f.source_registry_digest==t.snapshot.registry_digest;
}
QString desired_backup_directory(const QString &parent,const ProjectReceiptUpgradeToken &token) {
    return QDir(detail::original_read::path_text(parent)).filePath(desired_q(token.operation_id));
}
QString desired_backup_path(const QString &parent,const ProjectReceiptUpgradeToken &token) {
    return QDir(desired_backup_directory(parent,token)).filePath(QStringLiteral("project-v2.sqlite"));
}
bool desired_backup_absent(const QString &parent,const ProjectReceiptUpgradeToken &token) {
#ifdef Q_OS_WIN
    const auto path=QDir::toNativeSeparators(desired_backup_directory(parent,token)).toStdWString();
    SetLastError(ERROR_SUCCESS);
    const auto attributes=GetFileAttributesW(path.c_str());
    return attributes==INVALID_FILE_ATTRIBUTES && GetLastError()==ERROR_FILE_NOT_FOUND;
#else
    (void)parent;(void)token;return false;
#endif
}
std::string desired_backup_hash(const QString &path,const QElapsedTimer &timer) {
    QFile file(path);
    desired_need(file.open(QIODevice::ReadOnly) && file.size()>0 && file.size()<=64*1024*1024,DAC::OwnerUnavailable);
    QCryptographicHash hash(QCryptographicHash::Sha256);qint64 total=0;
    while(!file.atEnd()) {
        desired_need(!timer.hasExpired(30000),DAC::BudgetExceeded);
        const auto bytes=file.read(64*1024);
        desired_need(!bytes.isEmpty()&&file.error()==QFileDevice::NoError,DAC::OwnerUnavailable);
        total+=bytes.size();desired_need(total<=64*1024*1024,DAC::BudgetExceeded);hash.addData(bytes);
    }
    desired_need(total==file.size()&&file.error()==QFileDevice::NoError,DAC::OwnerUnavailable);
    return hash.result().toHex().toStdString();
}
// Parent lease is held by the caller. A fresh leaf lease prevents replacement
// between complete SQLite validation, connection close and streaming file hash.
std::optional<std::string> desired_verify_backup(const QString &parent,const ProjectReceiptUpgradeToken &token,
    const QElapsedTimer &timer) {
    try {
        const auto directory=desired_backup_directory(parent,token);
        DesiredDirectory leaf(directory);
        const QDir dir(directory);
        const auto entries=dir.entryList(QDir::AllEntries|QDir::NoDotAndDotDot|QDir::Hidden|QDir::System,QDir::Name);
        if(entries!=QStringList{QStringLiteral("project-v2.sqlite")})return std::nullopt;
        const auto path=desired_backup_path(parent,token);
#ifdef Q_OS_WIN
        detail::original_read::NamespaceLease file_lease;
        const auto file=file_lease.retain(path,false);
        if(file.size==0||file.size>64ULL*1024*1024)return std::nullopt;
#endif
        {
            Database backup(path,true);backup.copy_budget=true;backup.copy_timer=timer;backup.exec("BEGIN");
            auto snap=desired_upgrade_capture(backup,token.scope);
            // Backup intentionally has a different physical path, not identity.
            snap.canonical_path=token.snapshot.canonical_path;
            if(!desired_upgrade_same(snap,token.snapshot))return std::nullopt;
        }
        return desired_backup_hash(path,timer);
    } catch(const DesiredAssetError &e) {
        if(e.code==DAC::BudgetExceeded)throw;
        return std::nullopt;
    } catch(const ProjectCopyError &e) {
        if(e.code==ProjectCopyCode::BudgetExceeded)throw;
        return std::nullopt;
    } catch(...) { return std::nullopt; }
}
void desired_write_backup(const QString &path,const ProjectDocument &document,const IdentityRegistry &identities,
                          const QElapsedTimer &timer,DesiredBackupLease &lease) {
    validate(document);validate_copy_registry(document,identities);
#ifdef Q_OS_WIN
    {
        const auto native=QDir::toNativeSeparators(path).toStdWString();
        detail::original_read::HeldHandle created(CreateFileW(native.c_str(),
            GENERIC_READ|GENERIC_WRITE,FILE_SHARE_READ|FILE_SHARE_WRITE,nullptr,CREATE_NEW,
            FILE_ATTRIBUTE_NORMAL|FILE_FLAG_OPEN_REPARSE_POINT,nullptr));
        desired_need(created.get()!=INVALID_HANDLE_VALUE,DAC::OwnerUnavailable);
        // CREATE_NEW's own deny-delete handle fixes identity until the
        // long-lived ordinary-file lease is acquired. No close/open gap.
        lease.retain_created(path);
    }
#else
    (void)path;(void)lease;desired_fail(DAC::UnsupportedSchema);
#endif
    Database backup(path,false);backup.copy_budget=true;backup.copy_timer=timer;
    desired_need(backup.scalar("PRAGMA page_count")==0,DAC::OwnerUnavailable);
    backup.exec("PRAGMA journal_mode=DELETE");backup.exec("PRAGMA synchronous=FULL");backup.exec("BEGIN IMMEDIATE");
    try {
        schema(backup,2);
        backup.insert("store_identity",{1,desired_q(document.storage_lineage->store_uuid)});
        visit_project_rows(document,document.topology.revision,[&](const QString &table,const QVariantList &row) {
            backup.insert(table,row);
        });
        for(const auto &[key,active]:identities)
            backup.insert("identity_registry",{desired_q(key.first),desired_q(key.second),active?"active":"retired"});
        backup.exec("COMMIT");
    } catch(...) {
        backup.copy_budget=false;try { backup.exec("ROLLBACK"); } catch(...) {}
        throw;
    }
}
void desired_insert_format(Database &db,const ProjectReceiptFormat &format) {
    db.insert("proposal_format",{format.singleton,desired_q(format.upgrade_operation_id),desired_q(format.store_uuid),
        format.from_schema,static_cast<qint64>(format.source_revision),desired_q(format.source_content_digest),
        desired_q(format.source_registry_digest),desired_q(format.backup_sha256),desired_q(format.format_digest)});
}
} // namespace
ProjectReceiptUpgradeToken preview_project_receipt_upgrade(const QString &fixed,const QString &parent,
    const ProjectFormatMaintenanceScope &scope,const DesiredAssetOriginalExpected &original) {
    try {
        desired_maintenance_scope(scope);desired_original_shape(fixed,original,2);
        desired_need(original.store_uuid==scope.store_uuid,DAC::ScopeDenied);
        (void)detail::original_read::path_text(parent);
        DesiredDirectory directory(parent);
        DesiredConnection held(fixed,original,false);
        const auto snapshot=desired_upgrade_capture(*held.db,scope);
        ProjectReceiptUpgradeToken token{1,QUuid::createUuid().toString(QUuid::WithoutBraces).toStdString(),
            scope,original,directory.original,snapshot,{}};
        token.review_digest=desired_upgrade_digest(token);
        desired_upgrade_shape(fixed,parent,scope,token);
        held.db->check_copy_budget();return token;
    } catch(...) { desired_map_exception(); }
}
ProjectReceiptUpgradeResult commit_project_receipt_upgrade(const QString &fixed,const QString &parent,
    const ProjectFormatMaintenanceScope &scope,const ProjectReceiptUpgradeToken &token) {
    ProjectReceiptUpgradeResult confirmed,unknown;
    bool reserved=false,committed=false;
    try {
        desired_upgrade_shape(fixed,parent,scope,token);
        unknown.operation_id=token.operation_id;
        DesiredDirectory directory(parent,&token.backup_parent);
        DesiredConnection held(fixed,token.original,true);
        const auto version=held.db->check(project_application);
        if(version==3) {
            const auto capture=desired_capture(*held.db,scope.project_id,scope.store_uuid);
            desired_need(desired_format_matches(capture.ledger.format,token),DAC::ConfigChanged);
            const auto backup=desired_verify_backup(parent,token,held.db->copy_timer);
            if(!backup||*backup!=capture.ledger.format.backup_sha256)return unknown;
            return {ProjectReceiptUpgradeState::Confirmed,token.operation_id,capture.ledger.format};
        }
        ProjectDocument document;IdentityRegistry identities;
        const auto snapshot=desired_upgrade_capture(*held.db,scope,&document,&identities);
        desired_need(desired_upgrade_same(snapshot,token.snapshot),DAC::ConfigChanged);
        held.before_write();
        // Every post-reservation error leaves an artifact or a possible one.
        // Never reuse an existing leaf, remove it, or retry the operation here.
        reserved=true;
        desired_need(QDir(parent).mkdir(desired_q(token.operation_id)),DAC::RecoveryRequired);
        DesiredDirectory leaf(desired_backup_directory(parent,token));
        DesiredBackupLease backup_file;
        desired_write_backup(desired_backup_path(parent,token),document,identities,held.db->copy_timer,backup_file);
        const auto hash=desired_verify_backup(parent,token,held.db->copy_timer);
        desired_need(hash.has_value(),DAC::RecoveryRequired);
#ifdef LMTI_DESIRED_ASSET_OWNER_TEST_HOOKS
        desired_point(DesiredAssetOwnerTestPoint::UpgradeAfterBackupVerified);
#endif
        ProjectReceiptFormat format{1,token.operation_id,scope.store_uuid,2,snapshot.revision,
            snapshot.content_digest,snapshot.registry_digest,*hash,{}};
        format.format_digest=desired_hash("lmti.project.proposal-format.v1",desired_format_tuple(format,false));
        confirmed={ProjectReceiptUpgradeState::Confirmed,token.operation_id,format};
        held.db->exec(desired_format_ddl);held.db->exec(desired_receipts_ddl);
        desired_insert_format(*held.db,format);held.db->exec("PRAGMA user_version=3");
        // Complete validation while rollback is still possible; no readback
        // follows the confirmed COMMIT latch.
        (void)read_document(*held.db,3);
#ifdef LMTI_DESIRED_ASSET_OWNER_TEST_HOOKS
        desired_point(DesiredAssetOwnerTestPoint::UpgradeBeforeCommit);
#endif
        held.prepare_commit();held.db->exec("COMMIT");
#ifdef LMTI_DESIRED_ASSET_OWNER_TEST_HOOKS
        desired_point(DesiredAssetOwnerTestPoint::UpgradeAfterCommit);
#endif
        committed=true;
        return confirmed;
    } catch(...) {
        if(committed)return confirmed;
        if(reserved)return unknown;
        desired_map_exception();
    }
}
ProjectReceiptUpgradeInspection inspect_project_receipt_upgrade(const QString &fixed,const QString &parent,
    const ProjectFormatMaintenanceScope &scope,const ProjectReceiptUpgradeToken &token) {
    try {
        desired_upgrade_shape(fixed,parent,scope,token);
        DesiredDirectory directory(parent,&token.backup_parent);
        DesiredConnection held(fixed,token.original,false);
        const auto version=held.db->check(project_application);
        ProjectReceiptUpgradeInspection result;
        if(version==3) {
            const auto capture=desired_capture(*held.db,scope.project_id,scope.store_uuid);
            if(!desired_format_matches(capture.ledger.format,token))return result;
            const auto hash=desired_verify_backup(parent,token,held.db->copy_timer);
            if(!hash||*hash!=capture.ledger.format.backup_sha256)return result;
            return {ProjectReceiptUpgradeCondition::Upgraded,true,capture.ledger.format};
        }
        const auto snapshot=desired_upgrade_capture(*held.db,scope);
        if(!desired_upgrade_same(snapshot,token.snapshot))return result;
        if(desired_backup_absent(parent,token))
            return {ProjectReceiptUpgradeCondition::Original,false,std::nullopt};
        const auto hash=desired_verify_backup(parent,token,held.db->copy_timer);
        if(!hash)return result;
        return {ProjectReceiptUpgradeCondition::Original,true,std::nullopt};
    } catch(...) { desired_map_exception(); }
}
} // namespace lmti
