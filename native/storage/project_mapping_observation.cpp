#include "lmti/project_mapping_observation.hpp"
#include "project_mapping_observation_p.hpp"
#include "original_read_p.hpp"
#include <QCryptographicHash>
#include <QJsonArray>
#include <QJsonDocument>
#include <QJsonObject>
#include <algorithm>
#include <map>
#include <set>

namespace lmti {
namespace {
using Code = MappingObservationCode;
using Kind = MappingObservationKind;
using Identity = MappingObservationIdentityState;
using Key = std::pair<std::string,std::string>;
[[noreturn]] void refuse(Code code) { throw MappingObservationError(code); }
void need(bool condition,Code code = Code::OwnerUnavailable) {
    if (!condition) refuse(code);
}
QString s(const std::string &value) { return QString::fromStdString(value); }
QJsonValue optional_id(const std::string &value) {
    return value.empty() ? QJsonValue(QJsonValue::Null) : QJsonValue(s(value));
}
std::string digest(const QByteArray &value) {
    return QCryptographicHash::hash(value,QCryptographicHash::Sha256).toHex().toStdString();
}
Privacy inherited(Privacy a,Privacy b) {
    return a == Privacy::Public && b == Privacy::Public ? Privacy::Public : Privacy::Internal;
}
void budget(const QElapsedTimer &timer) {
    need(timer.isValid() && !timer.hasExpired(30000),Code::BudgetExceeded);
}
[[noreturn]] void original_failure(OriginalReadCode code) {
    switch (code) {
    case OriginalReadCode::InvalidInput: refuse(Code::InvalidInput);
    case OriginalReadCode::ScopeDenied: refuse(Code::NativeUnavailable);
    case OriginalReadCode::ConfigChanged: refuse(Code::ConfigChanged);
    case OriginalReadCode::LimitExceeded: refuse(Code::BudgetExceeded);
    case OriginalReadCode::NotSupported: refuse(Code::NotSupported);
    case OriginalReadCode::OwnerUnavailable:
    case OriginalReadCode::RecoveryRequired: refuse(Code::OwnerUnavailable);
    }
    refuse(Code::OwnerUnavailable);
}
template<class Row>
using Index = std::map<std::string,const Row *>;
template<class Row>
Index<Row> index(const std::vector<Row> &rows) {
    Index<Row> result;
    for (const auto &row : rows) need(result.emplace(row.id,&row).second);
    return result;
}
template<class Row>
const Row &lookup(const Index<Row> &rows,const std::string &id) {
    const auto found = rows.find(id);
    need(found != rows.end(),Code::NativeUnavailable);
    return *found->second;
}

// Pure traversal of the fully validated, privately captured graph. Registry
// consistency was checked on the same SQLite snapshot before this object exists.
class Projection {
    const detail::MappingObservationSnapshot &snapshot_;
    const MappingObservationScope &scope_;
    const ProjectDocument &document_;
    Index<SoftwareComponent> components_;
    Index<Asset> assets_;
    Index<Subsystem> subsystems_;
    Index<Site> sites_;
    Index<Area> areas_;
    Index<Environment> environments_;
    Index<RepositoryRef> repositories_;
    Index<KnowledgeRef> knowledge_;
    std::map<std::string,std::string> memberships_;
    std::map<std::string,const AssetPlacement *> placements_;

    void active(Kind kind,const std::string &id) const {
        const auto found = snapshot_.registry.find({name(kind),id});
        need(found != snapshot_.registry.end() && found->second,Code::NativeUnavailable);
    }
    void visible(Privacy privacy) const {
        need(scope_.allow_internal || privacy == Privacy::Public,Code::NativeUnavailable);
    }
    std::string repository_hash(const RepositoryRef &row) const {
        // Exactly the existing native snapshot locatorFingerprint.
        return digest(s(row.locator).toUtf8());
    }
    std::string knowledge_hash(const KnowledgeRef &row) const {
        // Exactly the existing native snapshot referenceFingerprint.
        return digest(QJsonDocument(QJsonObject{{"reference",s(row.reference)},
            {"fingerprint",s(row.fingerprint)}}).toJson(QJsonDocument::Compact));
    }
  public:
    Projection(const detail::MappingObservationSnapshot &snapshot,const MappingObservationScope &scope)
        : snapshot_(snapshot), scope_(scope), document_(snapshot.document),
          components_(index(document_.components)), assets_(index(document_.topology.assets)),
          repositories_(index(document_.repositories)), knowledge_(index(document_.knowledge)) {
        budget(snapshot_.timer);
        need(document_.structure.has_value());
        const auto &structure = *document_.structure;
        subsystems_ = index(structure.subsystems); sites_ = index(structure.sites);
        areas_ = index(structure.areas); environments_ = index(structure.environments);
        for (const auto &row : structure.component_memberships)
            need(memberships_.emplace(row.component_id,row.subsystem_id).second);
        for (const auto &row : structure.asset_placements)
            need(placements_.emplace(row.asset_id,&row).second);
        visible(document_.project.privacy); // Also required for targets=[].
    }
    MappingObservedTarget observe(const MappingObservationTarget &target) const {
        budget(snapshot_.timer);
        Privacy classification = document_.project.privacy;
        std::map<Key,QJsonArray> dependencies;
        std::set<Key> pending;
        std::vector<MappingObservationTarget> queue;
        auto enqueue = [&](Kind kind,const std::string &id) {
            if (id.empty()) return;
            if (pending.emplace(name(kind),id).second) {
                // A valid depth32 dependency closure is smaller than this.
                // Keep traversal bounded even if an internal caller is broken.
                need(pending.size() <= 128);
                queue.push_back({kind,id});
            }
        };
        enqueue(target.kind,target.id);
        std::optional<std::string> target_reference;
        for (std::size_t i=0;i<queue.size();++i) {
            budget(snapshot_.timer);
            // enqueue can reallocate queue; copy the current tuple first.
            const auto current = queue[i];
            const auto kind = name(current.kind);
            if (current.kind != Kind::Repository && current.kind != Kind::Knowledge)
                active(current.kind,current.id);
            Privacy own = Privacy::Internal;
            QJsonArray row;
            switch (current.kind) {
            case Kind::Component: {
                const auto &value = lookup(components_,current.id);
                own = value.privacy; visible(own);
                const auto member = memberships_.find(value.id);
                const auto subsystem = member == memberships_.end() ? std::string{} : member->second;
                enqueue(Kind::Repository,value.repository_id);
                enqueue(Kind::Subsystem,subsystem);
                row = {s(kind),s(value.id),s(name(own)),optional_id(value.repository_id),optional_id(subsystem)};
                break;
            }
            case Kind::Subsystem: {
                const auto &value = lookup(subsystems_,current.id);
                own = value.privacy; visible(own);
                enqueue(Kind::Subsystem,value.parent_subsystem_id);
                row = {s(kind),s(value.id),s(name(own)),optional_id(value.parent_subsystem_id)};
                break;
            }
            case Kind::Site: {
                const auto &value = lookup(sites_,current.id);
                need(value.id == scope_.site_id,Code::NativeUnavailable);
                own = value.privacy; visible(own);
                row = {s(kind),s(value.id),s(name(own))};
                break;
            }
            case Kind::Area: {
                const auto &value = lookup(areas_,current.id);
                need(value.site_id == scope_.site_id,Code::NativeUnavailable);
                own = value.privacy; visible(own);
                enqueue(Kind::Site,value.site_id);
                enqueue(Kind::Area,value.parent_area_id);
                row = {s(kind),s(value.id),s(name(own)),s(value.site_id),optional_id(value.parent_area_id)};
                break;
            }
            case Kind::Environment: {
                const auto &value = lookup(environments_,current.id);
                need(value.id == scope_.environment_id,Code::NativeUnavailable);
                own = value.privacy; visible(own);
                row = {s(kind),s(value.id),s(name(own))};
                break;
            }
            case Kind::Asset: {
                const auto &value = lookup(assets_,current.id);
                need(value.site == scope_.site_id,Code::NativeUnavailable);
                const auto found = placements_.find(value.id);
                need(found != placements_.end(),Code::NativeUnavailable);
                const auto &placement = *found->second;
                need(placement.environment_id == scope_.environment_id,Code::NativeUnavailable);
                own = value.privacy; visible(own);
                enqueue(Kind::Site,value.site);
                enqueue(Kind::Area,placement.area_id);
                enqueue(Kind::Environment,placement.environment_id);
                enqueue(Kind::Asset,placement.parent_asset_id);
                const QJsonValue role = placement.role ? QJsonValue(s(name(*placement.role))) :
                    QJsonValue(QJsonValue::Null);
                row = {s(kind),s(value.id),s(name(own)),s(value.site),
                    QJsonArray{optional_id(placement.area_id),optional_id(placement.parent_asset_id),
                        optional_id(placement.environment_id),role}};
                break;
            }
            case Kind::Repository: {
                const auto &value = lookup(repositories_,current.id);
                own = value.privacy; visible(own);
                const auto reference = repository_hash(value);
                if (current == target) target_reference = reference;
                row = {s(kind),s(value.id),s(name(own)),s(reference)};
                break;
            }
            case Kind::Knowledge: {
                const auto &value = lookup(knowledge_,current.id);
                own = value.privacy; visible(own);
                const auto reference = knowledge_hash(value);
                if (current == target) target_reference = reference;
                enqueue(Kind::Component,value.component_id);
                row = {s(kind),s(value.id),s(name(own)),optional_id(value.component_id),s(reference)};
                break;
            }
            default: refuse(Code::OwnerUnavailable);
            }
            classification = inherited(classification,own);
            need(dependencies.emplace(Key{kind,current.id},std::move(row)).second);
        }
        visible(classification);
        QJsonArray rows;
        for (const auto &[key,row] : dependencies) rows.append(row);
        const QJsonArray frame{s(scope_.project_id),s(scope_.store_uuid),s(name(document_.project.privacy)),
            s(scope_.site_id),s(scope_.environment_id),scope_.allow_internal ? "local" : "external",
            s(name(target.kind)),s(target.id),true,rows};
        const auto fingerprint = digest(QByteArrayLiteral("lmti.project.mapping.ancestry.v1\n")+
            QJsonDocument(frame).toJson(QJsonDocument::Compact));
        const bool reference = target.kind == Kind::Repository || target.kind == Kind::Knowledge;
        need(reference == target_reference.has_value());
        return {target,classification,fingerprint,std::move(target_reference),
            reference ? Identity::PresentReference : Identity::Active};
    }
};
} // namespace

std::string name(MappingObservationKind value) {
    switch (value) {
    case MappingObservationKind::Component: return "component";
    case MappingObservationKind::Asset: return "asset";
    case MappingObservationKind::Subsystem: return "subsystem";
    case MappingObservationKind::Site: return "site";
    case MappingObservationKind::Area: return "area";
    case MappingObservationKind::Environment: return "environment";
    case MappingObservationKind::Repository: return "repository";
    case MappingObservationKind::Knowledge: return "knowledge";
    }
    throw MappingObservationError(MappingObservationCode::InvalidInput);
}
std::string name(MappingObservationIdentityState value) {
    switch (value) {
    case MappingObservationIdentityState::Active: return "active";
    case MappingObservationIdentityState::PresentReference: return "present_reference";
    }
    throw MappingObservationError(MappingObservationCode::InvalidInput);
}
void validate_mapping_observation_request(const MappingObservationScope &scope,
    const std::vector<MappingObservationTarget> &targets) {
    try {
        need(targets.size() <= max_mapping_observation_targets,Code::BudgetExceeded);
        validate_id(scope.project_id); validate_id(scope.site_id); validate_id(scope.environment_id);
        need(scope.store_uuid.size() == 36 && detail::original_read::uuid(s(scope.store_uuid)),Code::InvalidInput);
        std::set<Key> unique;
        for (const auto &target : targets) {
            const auto kind = name(target.kind);
            validate_id(target.id);
            need(unique.emplace(kind,target.id).second,Code::InvalidInput);
        }
    } catch (const MappingObservationError &) { throw; }
    catch (...) { refuse(Code::InvalidInput); }
}
namespace {
ProjectMappingObservation read_mapping_observation_version(const QString &fixed_database,
    const MappingObservationScope &scope,const std::vector<MappingObservationTarget> &targets, int expected_schema) {
    validate_mapping_observation_request(scope,targets);
    try {
        // Slash-normalize only; never case-fold/canonicalize into another path.
        const auto path = detail::original_read::path_text(fixed_database);
        const auto chain = detail::original_read::parts(path);
        need(chain.size() > 1,Code::InvalidInput);
#ifndef Q_OS_WIN
        refuse(Code::NotSupported);
#else
        detail::original_read::NamespaceLease lease;
        for (qsizetype i=0;i<chain.size();++i) {
            const bool directory = i+1 < chain.size();
            const auto held = lease.retain(chain[i],directory);
            if (!directory) need(held.size <= 64ULL*1024*1024,Code::BudgetExceeded);
        }
        const auto sidecars = detail::original_read::retain_sidecars(lease,path);
#ifdef LMTI_ORIGINAL_READ_TEST_HOOKS
        detail::original_read_test_point(detail::OriginalReadPhase::AfterLeasesAcquired,path);
        detail::original_read_test_point(detail::OriginalReadPhase::BeforeProjectOpen,path);
#endif
        const auto snapshot = detail::read_mapping_observation_on_connection(path,scope,expected_schema);
        Projection projection(snapshot,scope);
        auto ordered = targets;
        std::sort(ordered.begin(),ordered.end(),[](const auto &a,const auto &b) {
            return Key{name(a.kind),a.id} < Key{name(b.kind),b.id};
        });
        ProjectMappingObservation result{snapshot.document.project.id,scope.store_uuid,
            snapshot.document.topology.revision,{}};
        need(snapshot.storage_schema == expected_schema,Code::OwnerUnavailable);
        result.storage_schema = snapshot.storage_schema;
        result.targets.reserve(ordered.size());
        for (const auto &target : ordered) result.targets.push_back(projection.observe(target));
        budget(snapshot.timer);
#ifdef LMTI_ORIGINAL_READ_TEST_HOOKS
        detail::original_read_test_point(detail::OriginalReadPhase::BeforeFinalVerification,path);
#endif
        // The connection has been destroyed; all invocation leases remain live.
        detail::original_read::check_sidecars(lease,sidecars);
        budget(snapshot.timer);
        return result;
#endif
    } catch (const MappingObservationError &) { throw; }
    catch (const OriginalReadError &error) { original_failure(error.code); }
    catch (...) { refuse(Code::OwnerUnavailable); }
}
} // namespace
ProjectMappingObservation read_project_mapping_observation(const QString &fixed_database,
    const MappingObservationScope &scope,const std::vector<MappingObservationTarget> &targets) {
    return read_mapping_observation_version(fixed_database,scope,targets,2);
}
ProjectMappingObservation read_project_mapping_observation_v2(const QString &fixed_database,
    const MappingObservationScope &scope,const std::vector<MappingObservationTarget> &targets) {
    return read_mapping_observation_version(fixed_database,scope,targets,3);
}
} // namespace lmti
