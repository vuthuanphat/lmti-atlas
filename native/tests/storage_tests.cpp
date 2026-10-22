#include "lmti/storage.hpp"
#include <QCoreApplication>
#include <QFile>
#include <QSqlDatabase>
#include <QSqlQuery>
#include <QTemporaryDir>
#include <functional>
#include <iostream>

namespace {
int failures = 0;
void check(bool result, const char *message) {
    if (!result) {
        std::cerr << message << '\n';
        ++failures;
    }
}
void rejects(const std::function<void()> &fn, const char *msg) {
    try {
        fn();
        check(false, msg);
    } catch (const lmti::Error &) {
    }
}
} // namespace
int main(int argc, char **argv) {
    QCoreApplication app(argc, argv);
    QTemporaryDir temp;
    if (!temp.isValid())
        return 1;
    const auto path = temp.filePath("topology.sqlite");
    auto t = lmti::demo_topology();
    t.assets[1].privacy = lmti::Privacy::Internal;
    t.assets[2].site = "other-site";
    lmti::canonicalize(t);
    t.revision = lmti::save(path, t);
    check(t.revision == 1 && lmti::load(path) == t, "save/load roundtrip");
    auto external = lmti::read_scope(path, {"factory-demo", true, 200});
    check(external.topology.assets.size() == 1 && external.topology.links.empty(),
          "private or cross-site metadata escaped");
    auto local = lmti::read_scope(path, {"factory-demo", false, 200});
    check(local.topology.assets.size() == 2 && local.topology.links.size() == 1, "local scope wrong");
    auto limited = lmti::read_scope(path, {"factory-demo", false, 1});
    check(limited.truncated && limited.topology.assets.size() == 1 && limited.topology.links.empty(),
          "bounded context wrong");
    auto changed = t;
    changed.assets[0].poll_ms = 2000;
    changed.revision = lmti::save(path, changed);
    rejects([&] { lmti::save(path, t); }, "stale writer overwrote DB");
    check(lmti::load(path) == changed, "conflict changed stored state");
    auto bad = changed;
    bad.assets[0].poll_ms = 1;
    rejects([&] { lmti::save(path, bad); }, "invalid save accepted");
    check(lmti::load(path) == changed, "validation failure changed DB");
    const auto ordinary = temp.filePath("ordinary.sqlite");
    {
        QFile f(ordinary);
        check(f.open(QIODevice::WriteOnly), "cannot create ordinary fixture");
        f.write("ordinary file");
    }
    rejects([&] { lmti::load(ordinary); }, "ordinary file loaded");
    rejects([&] { lmti::save(ordinary, t); }, "ordinary file overwritten");
    auto proposal = lmti::ConfigProposal{2, "machine-a", "factory-demo", true, false, 2000, 3000};
    auto json = lmti::proposal_json(proposal);
    check(lmti::parse_proposal(json).desired_poll_ms == 3000, "proposal boundary roundtrip");
    json["command"] = "unused";
    rejects([&] { lmti::parse_proposal(json); }, "unexpected proposal field accepted");
    // A dense graph still yields a bounded, explicitly truncated context.
    lmti::Topology dense;
    for (int i = 0; i < 30; ++i) {
        auto a = t.assets.back();
        a.id = "asset-" + std::to_string(i);
        a.site = "factory-demo";
        a.privacy = lmti::Privacy::Public;
        dense.assets.push_back(a);
    }
    for (int i = 0; i < 30; ++i)
        for (int j = 0; j < 30; ++j)
            if (i != j)
                dense.links.push_back({"edge-" + std::to_string(i) + "-" + std::to_string(j),
                                       dense.assets[i].id, dense.assets[j].id, lmti::Protocol::Dependency});
    const auto dense_path = temp.filePath("dense.sqlite");
    dense.revision = lmti::save(dense_path, dense);
    const auto bounded = lmti::read_scope(dense_path, {"factory-demo", true, 100});
    check(bounded.truncated && bounded.topology.links.size() == lmti::max_context_links,
          "dense context exceeded its edge budget");
    // A stored malicious label must still fail validation before reaching an Agent.
    {
        auto db = QSqlDatabase::addDatabase("QSQLITE", "tamper");
        db.setDatabaseName(path);
        db.open();
        QSqlQuery q(db);
        q.prepare("UPDATE assets SET label=? WHERE id='machine-a'");
        q.addBindValue("password=" + QString("fake-value-test-only"));
        check(q.exec(), "test tamper failed");
        db.close();
    }
    QSqlDatabase::removeDatabase("tamper");
    rejects([&] { lmti::read_scope(path, {"factory-demo", true, 200}); },
            "malicious database metadata exported");
    std::cout << "SQLite roundtrip, scope, limits, conflicts and hostile metadata checked\n";
    return failures ? 1 : 0;
}
