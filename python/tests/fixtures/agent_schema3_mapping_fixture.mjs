/** Test-only continuation of agent_mapping_fixture.mjs. Never packaged.
 * Real shipped native commands upgrade/change the fixture. Public LMIP owner
 * APIs enroll a distinct source; no direct SQL or MCP write command is used.
 */
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';

const CAP = 4 * 1024 * 1024;
const PROJECT = 'factory-monitor', SITE = 'factory-demo', ENVIRONMENT = 'test';
const ASSET = 'machine-a', AREA = 'mapping-test-area';
const PRINCIPAL = 'schema3-fixture-operator';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const GRANT = hash('lmti.schema3.fixture.desired-grant.v1');
const MAINTENANCE = hash('lmti.schema3.fixture.maintenance-grant.v1');
const ERROR_CODES = new Set(['INVALID_INPUT', 'UNSUPPORTED_FORMAT', 'UNSUPPORTED_MAPPING', 'UNSUPPORTED_SCHEMA',
  'SCOPE_DENIED', 'BUSY', 'BUDGET_EXCEEDED', 'CONFIG_CHANGED', 'CONFIG_CONFLICT', 'REVISION_CONFLICT',
  'VERSION_CONFLICT', 'OPERATION_CONFLICT', 'RECOVERY_REQUIRED', 'SOURCE_UNAVAILABLE', 'SOURCE_CHANGED',
  'NATIVE_UNAVAILABLE', 'NATIVE_CHANGED', 'OWNER_UNAVAILABLE']);
const need = (condition, code = 'FIXTURE_INVALID') => { if (!condition) throw Error(code); };
const now = () => new Date().toISOString();
const clone = value => structuredClone(value);
let strictJson;
let phase = 'arguments';

async function ordinary(value, directory = false) {
  need(typeof value === 'string' && path.isAbsolute(value) && path.normalize(value) === value);
  const parsed = path.parse(value);
  let cursor = parsed.root;
  const paths = [cursor];
  for (const part of path.relative(parsed.root, value).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part); paths.push(cursor);
  }
  for (let i = 0; i < paths.length; ++i) {
    const stat = await fs.lstat(paths[i]);
    need(!stat.isSymbolicLink());
    need(i < paths.length - 1 || directory ? stat.isDirectory() : stat.isFile());
    if (i === paths.length - 1 && !directory) need(stat.nlink === 1);
  }
  return fs.realpath(value);
}
async function boundedBytes(filename, cap = CAP) {
  await ordinary(filename);
  const file = await fs.open(filename, 'r');
  try {
    const before = await file.stat({ bigint: true });
    need(before.isFile() && before.nlink === 1n && before.size <= BigInt(cap));
    const buffer = Buffer.alloc(cap + 1); let used = 0;
    while (used <= cap) {
      const { bytesRead } = await file.read(buffer, used, buffer.length - used, null);
      if (!bytesRead) break;
      used += bytesRead;
    }
    const after = await file.stat({ bigint: true });
    need(used <= cap && before.dev === after.dev && before.ino === after.ino &&
      before.size === after.size && before.mtimeNs === after.mtimeNs &&
      before.ctimeNs === after.ctimeNs && before.birthtimeNs === after.birthtimeNs);
    const current = await fs.lstat(filename, { bigint: true });
    // Compare identity across APIs, not platform-specific path/handle ctime.
    need(!current.isSymbolicLink() && current.isFile() && current.nlink === 1n &&
      current.dev === after.dev && current.ino === after.ino &&
      current.size === after.size && current.mtimeNs === after.mtimeNs &&
      current.birthtimeNs === after.birthtimeNs);
    return buffer.subarray(0, used);
  } finally { await file.close(); }
}
const exact = (value, keys) => {
  need(value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).sort().join('\0') === [...keys].sort().join('\0'));
  return value;
};
const same = (a, b) => {
  if (Array.isArray(a) && Array.isArray(b))
    return a.length === b.length && a.every((value, i) => same(value, b[i]));
  if (a && b && typeof a === 'object' && typeof b === 'object')
    return Object.keys(a).sort().join('\0') === Object.keys(b).sort().join('\0') &&
      Object.keys(a).every(key => same(a[key], b[key]));
  return a === b;
};
async function main() {
  const [action, rawRoot, rawRepo, rawPackage, rawProducer] = process.argv.slice(2);
  need(process.argv.length === 7 &&
    ['upgrade', 'edit', 'privacy-asset', 'privacy-site', 'privacy-project'].includes(action));
  const root = await ordinary(rawRoot, true), repo = await ordinary(rawRepo, true);
  const packaged = await ordinary(rawPackage, true), producer = await ordinary(rawProducer);
  need(path.dirname(root) === await fs.realpath(os.tmpdir()) &&
    path.basename(root).startsWith('lmti-reviewed-mapping-process-'));
  const fixed = name => path.join(root, name);
  const sourceRoot = fixed('source'), nativeRoot = fixed('native');
  await ordinary(sourceRoot, true); await ordinary(nativeRoot, true);
  const modules = ['packages/impact/dist/index.js', 'packages/cli/dist/impact-mapping-private.js',
    'packages/cli/dist/impact-mapping-source.js', 'packages/cli/dist/impact-mapping-native.js'];
  phase = 'imports';
  for (const module of modules) await ordinary(path.join(repo, module));
  const impact = await import(pathToFileURL(path.join(repo, modules[0])));
  ({ strictJson } = await import(pathToFileURL(path.join(repo, modules[1]))));
  const { createFixedMappingSourceObserver, mappingSourceAuthorityFingerprint } =
    await import(pathToFileURL(path.join(repo, modules[2])));
  const { createFixedMappingNativeObserver, mappingNativeAuthorityFingerprint } =
    await import(pathToFileURL(path.join(repo, modules[3])));
  const controlFile = fixed('fixture-control.json');
  const controlBytes = await boundedBytes(controlFile);
  let control = strictJson(controlBytes, CAP);
  need(control.schema === 'lmti.composition.test-fixture.v1' && control.root === root &&
    control.repo === repo && control.packaged === packaged && control.producer === producer &&
    control.storePath === fixed('impact.sqlite') && control.source.root === sourceRoot &&
    control.native.database === path.join(nativeRoot, 'project.sqlite') &&
    control.native.projectId === PROJECT && control.native.siteId === SITE &&
    control.native.environmentId === ENVIRONMENT && control.native.visibility === 'external' &&
    control.source.projectId === PROJECT && control.source.siteId === SITE &&
    control.source.environmentId === ENVIRONMENT && control.source.kind === 'manifest' &&
    control.source.minimumClassification === 'public' && control.source.allowInternal === false &&
    control.grant.allowInternal === false &&
    same(control.grant.siteIds, [SITE]) && same(control.grant.environmentIds, [ENVIRONMENT]) &&
    control.grant.projectId === PROJECT && Array.isArray(control.mappings));
  await ordinary(control.storePath);
  const executable = path.join(packaged, 'bin/lmti-project.exe');
  const mappingCli = path.join(packaged, 'share/lmti/mapping-owner/index.js');
  await ordinary(executable); await ordinary(mappingCli); await ordinary(process.execPath);
  need(control.native.executable === executable &&
    control.native.executableDigest === hash(await boundedBytes(executable, 128 * 1024 * 1024)));
  const env = {};
  for (const key of ['SystemRoot', 'WINDIR', 'TEMP', 'TMP'])
    if (process.env[key]) env[key] = process.env[key];
  env.PATH = path.join(packaged, 'bin') + path.delimiter + path.dirname(process.execPath) +
    (process.platform === 'win32' ? path.delimiter + 'C:\\Windows\\System32' : '');
  env.QT_PLUGIN_PATH = path.join(packaged, 'plugins');
  async function run(program, args, input,
    { cap = CAP, expectedExit = 0, inputCap = CAP, allowStderr = false } = {}) {
    await ordinary(program);
    const bytes = input === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(input) + '\n');
    need(bytes.length <= inputCap);
    return new Promise((resolve, reject) => {
      const child = spawn(program, args, { shell: false, windowsHide: true,
        cwd: path.dirname(program), env, stdio: ['pipe', 'pipe', 'pipe'] });
      const chunks = []; let total = 0, stderr = 0, failed = false;
      // Timeout invalidates the result but never kills/retries a write. Retain
      // admission and drain until actual close; the outer runner retains a hung
      // fixture/PID rather than claiming a completed cleanup.
      const timer = setTimeout(() => { failed = true; }, 60000);
      child.on('error', () => { failed = true; });
      for (const stream of [child.stdin, child.stdout, child.stderr])
        stream.on('error', () => { failed = true; });
      child.stdout.on('data', chunk => {
        total += chunk.length;
        if (total <= cap) chunks.push(chunk); else failed = true;
      });
      child.stderr.on('data', chunk => { stderr += chunk.length; if (stderr > 65536) failed = true; });
      child.on('close', (code, signal) => {
        clearTimeout(timer);
        if (failed || signal !== null || code !== expectedExit || (!allowStderr && stderr !== 0)) {
          const error = Error('FIXTURE_CHILD_FAILED');
          // Closed, bounded, valid error frames may contribute only a finite
          // code to the fixture diagnostic. Never echo raw bytes or stderr.
          if (!failed && signal === null && total <= cap) {
            try {
              const reply = strictJson(Buffer.concat(chunks), cap, true);
              const observed = typeof reply.error === 'string' ? reply.error : reply.error?.code;
              if (ERROR_CODES.has(observed)) error.code = observed;
            } catch { /* Keep the generic bounded failure. */ }
          }
          reject(error);
        } else {
          try { resolve(strictJson(Buffer.concat(chunks), cap, true)); }
          catch { reject(Error('FIXTURE_CHILD_FRAME')); }
        }
      });
      child.stdin.end(bytes);
    });
  }
  async function writeNew(name, value) {
    need(path.dirname(name) === root || path.dirname(name) === sourceRoot);
    await ordinary(path.dirname(name), true);
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value) + '\n');
    need(bytes.length <= CAP);
    await fs.writeFile(name, bytes, { flag: 'wx' });
  }
  async function replaceControl(value) {
    need((await boundedBytes(controlFile)).equals(controlBytes), 'FIXTURE_CONTROL_CHANGED');
    // The only replaced file is this existing, checked, disposable control.
    await ordinary(controlFile);
    const bytes = Buffer.from(JSON.stringify(value) + '\n'); need(bytes.length <= CAP);
    const file = await fs.open(controlFile, 'r+');
    try { await file.writeFile(bytes); await file.truncate(bytes.length); }
    finally { await file.close(); }
  }
  async function physical(filename) {
    need(filename === path.join(nativeRoot, 'project.sqlite'));
    await ordinary(filename);
    let cursor = path.parse(filename).root;
    const paths = [cursor];
    for (const part of path.relative(cursor, filename).split(path.sep).filter(Boolean)) {
      cursor = path.join(cursor, part); paths.push(cursor);
    }
    need(paths.length <= 64);
    const chain = [];
    for (let i = 0; i < paths.length; ++i) {
      const stat = await fs.lstat(paths[i], { bigint: true });
      need(!stat.isSymbolicLink() &&
        (i === paths.length - 1 ? stat.isFile() && stat.nlink === 1n : stat.isDirectory()));
      need(stat.dev >= 0n && stat.ino > 0n && stat.birthtimeNs > 0n);
      chain.push({ dev: String(stat.dev), ino: String(stat.ino), birthtimeNs: String(stat.birthtimeNs) });
    }
    return { version: 1, path: filename, kind: 'file', state: 'present', chain };
  }
  const fixtureKeys = ['ready', 'projectId', 'storeUuid', 'assetId', 'siteId', 'areaId',
    'environmentId', 'schema', 'revision'];
  function fixtureReply(value, schema, revision) {
    exact(value, fixtureKeys);
    need(value.ready === true && value.projectId === PROJECT && value.storeUuid === control.native.storeUuid &&
      value.assetId === ASSET && value.siteId === SITE && value.areaId === AREA &&
      value.environmentId === ENVIRONMENT && value.schema === schema && value.revision === revision);
    return value;
  }
  async function nativeCall(format, write, request, tokenId) {
    const command = (format ? 'proposal-format-' : 'desired-asset-') + (write ? 'write' : 'read');
    const args = [command, control.native.database, PROJECT, control.native.storeUuid, PRINCIPAL,
      format ? MAINTENANCE : GRANT,
      ...(format ? [fixed('schema3-upgrade-backups')] : [SITE, ENVIRONMENT, 'external'])];
    const value = await run(executable, args, request, { cap: 128 * 1024, inputCap: 64 * 1024 });
    exact(value, write ? ['ok', 'schema', 'action', 'outcome', 'operationId', 'details', 'error'] :
      ['ok', 'schema', 'action', 'details', 'error']);
    need(value.ok === true && value.error === null && value.action === request.action &&
      value.schema === `lmti.project.${format ? 'proposal-format' : 'desired-asset'}.${write ? 'write' : 'owner'}.v1` &&
      value.details !== null);
    if (write) need(value.outcome === 'confirmed' && value.operationId === tokenId);
    return value.details;
  }
  function checkedState(state) {
    exact(state, ['projectId', 'storeUuid', 'revision', 'assetId', 'siteId', 'environmentId',
      'effectivePrivacy', 'ancestryFingerprint', 'enabled', 'pollMs']);
    need(state.projectId === PROJECT && state.storeUuid === control.native.storeUuid &&
      state.assetId === ASSET && state.siteId === SITE && state.environmentId === ENVIRONMENT &&
      state.effectivePrivacy === 'public' && Number.isSafeInteger(state.revision) && state.revision >= 2 &&
      typeof state.enabled === 'boolean' && Number.isInteger(state.pollMs) &&
      state.pollMs >= 100 && state.pollMs <= 3600000 &&
      /^[0-9a-f]{64}$/.test(state.ancestryFingerprint));
    return state;
  }
  async function desiredEdit(original, ordinal) {
    const inspected = await nativeCall(false, false, { action: 'inspect', original, assetId: ASSET });
    exact(inspected, ['state']); const state = checkedState(inspected.state);
    const proposal = { assetId: ASSET, expectedRevision: state.revision,
      expected: { enabled: state.enabled, pollMs: state.pollMs },
      desired: { enabled: !state.enabled, pollMs: state.pollMs === 1000 ? 1500 : 1000 },
      handoffDigest: hash(`lmti.schema3.fixture.handoff.v1\n${ordinal}`) };
    const preview = await nativeCall(false, false, { action: 'preview', original, proposal });
    exact(preview, ['state', 'expected', 'diff']);
    need(same(preview.state, state) && same(preview.expected.proposal, proposal) &&
      same(preview.diff, { assetId: ASSET, expected: proposal.expected, desired: proposal.desired }));
    // Persist the exact owner-minted command before dispatch; never recreate it
    // from a later state after unknown/failed acknowledgement.
    const request = { action: 'commit', original, expected: preview.expected };
    const tokenPath = fixed(`schema3-desired-${ordinal}.json`);
    await writeNew(tokenPath, request);
    const result = await nativeCall(false, true, request, preview.expected.operationId);
    exact(result, ['receipt', 'historical', 'replayed']);
    const receipt = result.receipt;
    need(result.historical === true && result.replayed === false && receipt &&
      receipt.schema === 'lmti.project.desired-asset.receipt.v1' &&
      receipt.originStoreUuid === control.native.storeUuid && receipt.projectId === PROJECT &&
      receipt.operationId === preview.expected.operationId && receipt.requestDigest === preview.expected.requestDigest &&
      receipt.originalTargetDigest === preview.expected.originalTargetDigest &&
      receipt.assetId === ASSET && receipt.principalId === PRINCIPAL && receipt.grantFingerprint === GRANT &&
      receipt.siteId === SITE && receipt.environmentId === ENVIRONMENT && receipt.allowInternal === false &&
      receipt.baseRevision === state.revision && receipt.committedRevision === state.revision + 1 &&
      receipt.expectedEnabled === state.enabled && receipt.expectedPollMs === state.pollMs &&
      receipt.desiredEnabled === proposal.desired.enabled && receipt.desiredPollMs === proposal.desired.pollMs &&
      receipt.handoffDigest === proposal.handoffDigest);
    const lookup = await nativeCall(false, false, { action: 'receipt', original,
      operationId: receipt.operationId, requestDigest: receipt.requestDigest });
    exact(lookup, ['receipt', 'historical']);
    need(lookup.historical === true && same(lookup.receipt, receipt));
    const after = await nativeCall(false, false, { action: 'inspect', original, assetId: ASSET });
    exact(after, ['state']); checkedState(after.state);
    need(after.state.revision === state.revision + 1 && after.state.enabled === proposal.desired.enabled &&
      after.state.pollMs === proposal.desired.pollMs);
    await writeNew(fixed(`schema3-receipt-${ordinal}.json`), receipt);
    return { tokenPath, original, proposal, token: preview.expected, receipt, state: after.state };
  }
  const inventory = sourceId => {
    const snapshot = impact.readImpactSnapshot(control.storePath, control.grant);
    return { imports: impact.listImpactImports(control.storePath, control.grant).filter(r => r.source.id === sourceId),
      history: impact.readImpactHistory(control.storePath, control.grant).filter(r => r.sourceId === sourceId),
      sources: snapshot.sources.filter(r => r.source.id === sourceId),
      entities: snapshot.entities.filter(r => r.sourceId === sourceId),
      evidence: snapshot.evidence.filter(r => r.sourceId === sourceId),
      assertions: snapshot.assertions.filter(r => r.sourceId === sourceId) };
  };
  const currentRead = (config, sourceId, expectedExit = 0) => run(process.execPath,
    [mappingCli, 'accepted-mappings', '--config', config.path, '--config-sha256', config.sha256],
    // Node may emit its own bounded SQLite experimental warning. Success still
    // requires the exact exit code and a complete strict response frame.
    { sourceId }, { expectedExit, inputCap: 4096, allowStderr: true });
  const pin = async filename => ({ path: filename, sha256: hash(await boundedBytes(filename)) });
  const verifyPins = async pins => {
    for (const row of pins) need(hash(await boundedBytes(row.path)) === row.sha256, 'FIXTURE_HISTORY_CHANGED');
  };
  const oldFiles = [fixed('fixture-control-schema2.json'), fixed('mapping-owner.json'),
    fixed('integration.json'), path.join(sourceRoot, 'manifest.json')];
  const newFiles = [fixed('mapping-owner-schema3.json'), fixed('integration-schema3.json'),
    path.join(sourceRoot, 'manifest-schema3.json')];

  if (action === 'upgrade') {
    phase = 'original-control';
    need(control.source.sourceId === 'composition-source' &&
      control.source.descriptorFile === 'manifest.json' &&
      control.native.schema === 'lmti.impact.mapping-native.v1' &&
      control.mappingConfig === fixed('mapping-owner.json') && control.integration === fixed('integration.json') &&
      control.acceptedVersion === 'accepted-one' && control.mappings.length === 3 && control.schema3 === undefined);
    const originalControlPath = fixed('fixture-control-schema2.json');
    await writeNew(originalControlPath, controlBytes);
    const old = clone(control);
    const oldPins = await Promise.all([originalControlPath, old.mappingConfig, old.integration,
      path.join(sourceRoot, 'manifest.json')].map(pin));
    const oldInventory = inventory(old.source.sourceId);
    need(oldInventory.sources.length === 1 &&
      same(oldInventory.imports.map(r => r.state).sort(), ['accepted', 'pending', 'rejected']));
    phase = 'native-prepare';
    const prepared = fixtureReply(await run(producer, ['--prepare-mapping-schema3', nativeRoot],
      undefined, { cap: 4096 }), 2, 2);
    const original2 = { schema: 2, storeUuid: prepared.storeUuid, physical: await physical(control.native.database) };
    const backupParent = fixed('schema3-upgrade-backups');
    await fs.mkdir(backupParent); await ordinary(backupParent, true);
    phase = 'native-upgrade';
    const preview = await nativeCall(true, false, { action: 'preview-upgrade', original: original2 });
    exact(preview, ['expected']);
    need(preview.expected.snapshot.schemaVersion === 2 && preview.expected.snapshot.revision === prepared.revision &&
      same(preview.expected.original, original2));
    await writeNew(fixed('schema3-upgrade-request.json'), { action: 'upgrade', expected: preview.expected });
    const upgraded = await nativeCall(true, true, { action: 'upgrade', expected: preview.expected },
      preview.expected.operationId);
    exact(upgraded, ['format', 'backupVerified']);
    need(upgraded.backupVerified === true && upgraded.format.storeUuid === prepared.storeUuid &&
      upgraded.format.sourceRevision === prepared.revision && upgraded.format.fromSchema === 2 &&
      upgraded.format.upgradeOperationId === preview.expected.operationId);
    const observedUpgrade = await nativeCall(true, false, { action: 'inspect-upgrade', expected: preview.expected });
    need(same(observedUpgrade, { state: 'upgraded', backupVerified: true, format: upgraded.format }));
    need(same(await physical(control.native.database), original2.physical));
    const original3 = { ...original2, schema: 3 };
    phase = 'native-first-edit';
    const firstEdit = await desiredEdit(original3, 1);
    phase = 'old-current-refusal';
    const oldRead = await currentRead(oldPins.find(row => row.path === old.mappingConfig), old.source.sourceId, 3);
    need(same(oldRead, { schema: 'lmti.impact.mapping-current.v1', error: 'UNSUPPORTED_MAPPING' }));
    phase = 'new-source';
    const input = clone(old.input);
    input.source.id = 'composition-source-schema3'; input.source.revision = 'schema3-one';
    input.source.digest = hash('explicit schema3 fixture source declaration'); input.source.capturedAt = now();
    input.entities[0].id = 'entity-schema3-one'; input.entities[0].sourceKey = 'schema3-one';
    input.evidence[0].id = 'proof-schema3-one'; input.evidence[0].entityId = 'entity-schema3-one';
    input.evidence[0].capturedAt = now();
    const source = { ...old.source, sourceId: input.source.id, descriptorFile: 'manifest-schema3.json' };
    const native = { ...old.native, schema: 'lmti.impact.mapping-native.v2' };
    const authority = { ...old.authority, sourceId: input.source.id,
      sourceAuthorityFingerprint: mappingSourceAuthorityFingerprint(source),
      nativeAuthorityFingerprint: mappingNativeAuthorityFingerprint(native) };
    need(authority.nativeAuthorityFingerprint !== old.authority.nativeAuthorityFingerprint);
    await writeNew(path.join(sourceRoot, source.descriptorFile), input);
    const runtime = { authorize() {}, clock: now };
    const sourceObserver = createFixedMappingSourceObserver(source, runtime);
    const nativeObserver = createFixedMappingNativeObserver(native, runtime);
    const op = impact.createImpactMappingOperator({ storePath: old.storePath, grant: old.grant,
      authorities: [old.authority, authority],
      // Format inspection requires the existing trusted fixture maintenance
      // capability too. This continuation never invokes an LMIP upgrade.
      maintenance: { capabilityId: 'fixture-maintenance', policyVersion: 'one',
        backupPath: fixed('impact-backup.sqlite') }, clock: now,
      observers: { authorize: runtime.authorize, async observe(request, operationContext) {
        const context = { signal: operationContext.signal, timeoutMilliseconds: 40000 };
        const sourceRead = await sourceObserver.observe({ phase: 'current', pass: 1, authority,
          acceptedImport: input, expectedContentFingerprint: impact.mappingSourceContentFingerprint(input) }, context);
        const nativeRead = await nativeObserver.observe({ phase: 'current', pass: 1, authority,
          allowInternal: false, targets: request.targets }, context);
        return { source: sourceRead.observation, native: nativeRead };
      } } });
    const confirmed = value => { need(value.outcome === 'confirmed' && value.receipt); return value.receipt; };
    try {
      phase = 'source-registration';
      let reuseCode = null;
      try { op.registerSource(old.source.sourceId, op.inspectMappingFormat().graphRevision, randomUUID()); }
      catch (error) { reuseCode = error.code; }
      need(reuseCode === 'VERSION_CONFLICT');
      const registration = confirmed(op.registerSource(source.sourceId, op.inspectMappingFormat().graphRevision, randomUUID()));
      phase = 'native-observation';
      const observed = await nativeObserver.observe({ phase: 'current', pass: 1, authority, allowInternal: false,
        targets: [{ projectId: PROJECT, storeUuid: native.storeUuid, kind: 'repository', id: 'repo-sensor' }] },
      { signal: new AbortController().signal, timeoutMilliseconds: 40000 });
      need(observed.schema === 3 && observed.targets.length === 1 &&
        /^[0-9a-f]{64}$/.test(observed.targets[0].referenceFingerprint));
      const referenceFingerprint = observed.targets[0].referenceFingerprint;
      const row = (kind, target, suffix) => ({ mappingId: randomUUID(), externalKey: 'PRIVATE_SCHEMA3_EXTERNAL_' + suffix,
        generation: 'schema3-one', aliases: ['PRIVATE_SCHEMA3_ALIAS_' + suffix], classification: 'public',
        evidenceIds: ['proof-schema3-one'], state: 'active', impactEntityId: 'entity-schema3-one',
        replacesMappingId: null, kind, target: { projectId: PROJECT, storeUuid: native.storeUuid, ...target },
        ...(kind === 'code' ? { selection: 'src/firmware.ts', referenceFingerprint } : {}) });
      const mappings = [row('identity', { kind: 'component', id: 'sensor-firmware' }, 'component'),
        row('identity', { kind: 'asset', id: ASSET }, 'asset'),
        row('code', { kind: 'repository', id: 'repo-sensor' }, 'code-a'),
        row('code', { kind: 'repository', id: 'repo-sensor' }, 'code-b')];
      need(mappings.every(r => !old.mappings.some(o => o.mappingId === r.mappingId)));
      const body = { schema: 'lmti.impact.mapping-import.v1', input, mappings,
        mappingVersion: 'accepted-schema3-one', expectedAcceptedVersion: null };
      phase = 'mapping-stage';
      const staged = confirmed(await op.stageComplete({ ...body, payloadDigest: impact.mappingPayloadDigest(body) },
        op.inspectMappingFormat().graphRevision, randomUUID()));
      phase = 'mapping-accept';
      const accepted = confirmed(await op.decide(await op.preview(staged.batchId), 'accept', randomUUID()));
      const format = op.inspectMappingFormat();
      const config = { schema: 'lmti.agent.mapping-owner.v1', storePath: old.storePath,
        storeUuid: format.storeUuid, sourceIdentityDigest: format.sourceIdentityDigest,
        grant: old.grant, authority, native, source };
      const mappingConfig = fixed('mapping-owner-schema3.json');
      await writeNew(mappingConfig, config);
      const integration = strictJson(await boundedBytes(old.integration), CAP);
      const knowledgeCli = path.join(packaged, 'share/lmti/knowledge-owner/index.js');
      need(integration.schema === 'lmti.agent.integration.v3' &&
        integration.projectId === PROJECT && integration.site === SITE && integration.target === 'external' &&
        integration.knowledge.mode === 'reviewed' && integration.knowledge.root === sourceRoot &&
        integration.knowledge.node === process.execPath &&
        integration.knowledge.nodeSha256 === hash(await boundedBytes(process.execPath, 128 * 1024 * 1024)) &&
        integration.knowledge.cli === knowledgeCli &&
        integration.knowledge.cliSha256 === hash(await boundedBytes(knowledgeCli)) &&
        integration.knowledge.sourceId === old.knowledgeSourceId &&
        integration.knowledge.mappingOwner.cli === mappingCli &&
        integration.knowledge.mappingOwner.cliSha256 === hash(await boundedBytes(mappingCli)) &&
        integration.knowledge.mappingOwner.config === old.mappingConfig &&
        integration.knowledge.mappingOwner.configSha256 === oldPins.find(row => row.path === old.mappingConfig).sha256 &&
        integration.knowledge.mappingOwner.sourceId === old.source.sourceId);
      integration.knowledge.mappingOwner.config = mappingConfig;
      integration.knowledge.mappingOwner.configSha256 = hash(await boundedBytes(mappingConfig));
      integration.knowledge.mappingOwner.sourceId = source.sourceId;
      const integrationPath = fixed('integration-schema3.json');
      await writeNew(integrationPath, integration);
      phase = 'new-current-read';
      const acceptedCurrent = await currentRead(await pin(mappingConfig), source.sourceId);
      need(acceptedCurrent.schema === 'lmti.impact.mapping-current.v1' && acceptedCurrent.complete === true &&
        acceptedCurrent.sourceId === source.sourceId && acceptedCurrent.nativeObservation.schema === 3 &&
        acceptedCurrent.nativeObservation.revision === firstEdit.state.revision &&
        same(acceptedCurrent.mappings.map(r => r.mapping.mappingId).sort(), mappings.map(r => r.mappingId).sort()));
      need(same(inventory(old.source.sourceId), oldInventory));
      await verifyPins(oldPins);
      const newPins = await Promise.all(newFiles.map(pin));
      control = { ...old, source, native, authority, input, mappings, mappingConfig,
        integration: integrationPath, acceptedVersion: body.mappingVersion, rejectedId: null, pendingId: null,
        schema3: { originalControlPath, original2, original3, prepared, backupParent,
          upgradeToken: preview.expected, format: upgraded.format, desiredOperations: [firstEdit],
          latestRevision: firstEdit.state.revision, oldPins, newPins, oldInventory, oldSourceId: old.source.sourceId,
          oldRegistrationError: reuseCode, oldReadError: oldRead.error,
          registration, staged, accepted, privacyMutations: [] } };
      await replaceControl(control);
    } finally { await sourceObserver.waitForIdle(); await nativeObserver.waitForIdle(); }
  } else {
    phase = 'continued-control';
    need(control.native.schema === 'lmti.impact.mapping-native.v2' &&
      control.source.sourceId === 'composition-source-schema3' &&
      control.source.descriptorFile === 'manifest-schema3.json' &&
      control.mappingConfig === fixed('mapping-owner-schema3.json') &&
      control.integration === fixed('integration-schema3.json') &&
      control.schema3?.originalControlPath === fixed('fixture-control-schema2.json') &&
      control.schema3.original3.schema === 3 &&
      control.schema3.original3.storeUuid === control.native.storeUuid &&
      control.schema3.original3.physical.path === control.native.database &&
      control.schema3.backupParent === fixed('schema3-upgrade-backups') &&
      Array.isArray(control.schema3.desiredOperations) && control.schema3.desiredOperations.length >= 1 &&
      control.schema3.desiredOperations.length < 8 && Array.isArray(control.schema3.privacyMutations) &&
      same(control.schema3.oldPins.map(row => row.path), oldFiles) &&
      same(control.schema3.newPins.map(row => row.path), newFiles));
    await verifyPins(control.schema3.oldPins);
    await verifyPins(control.schema3.newPins);
    need(same(inventory(control.schema3.oldSourceId), control.schema3.oldInventory));
    need(same(await physical(control.native.database), control.schema3.original3.physical));
    if (action === 'edit') {
      phase = 'native-next-edit';
      need(control.schema3.privacyMutations.length === 0);
      const edit = await desiredEdit(control.schema3.original3, control.schema3.desiredOperations.length + 1);
      need(edit.state.revision === control.schema3.latestRevision + 1);
      control.schema3.desiredOperations.push(edit); control.schema3.latestRevision = edit.state.revision;
    } else {
      phase = 'native-privacy';
      const mutation = { 'privacy-asset': 'asset-internal', 'privacy-site': 'site-internal',
        'privacy-project': 'project-internal' }[action];
      need(!control.schema3.privacyMutations.includes(mutation));
      const result = fixtureReply(await run(producer, ['--mutate-mapping-schema3', nativeRoot, mutation],
        undefined, { cap: 4096 }), 3, control.schema3.latestRevision + 1);
      control.schema3.privacyMutations.push(mutation); control.schema3.latestRevision = result.revision;
    }
    await verifyPins(control.schema3.oldPins);
    await verifyPins(control.schema3.newPins);
    need(same(inventory(control.schema3.oldSourceId), control.schema3.oldInventory));
    await replaceControl(control);
  }
  const last = control.schema3.desiredOperations.at(-1);
  const output = { ready: true, schema: 3, revision: control.schema3.latestRevision,
    assetId: ASSET, enabled: last.receipt.desiredEnabled, pollMs: last.receipt.desiredPollMs,
    acceptedVersion: control.acceptedVersion, activeIds: control.mappings.map(r => r.mappingId).sort(),
    oldRegistrationError: control.schema3.oldRegistrationError, oldReadError: control.schema3.oldReadError };
  const bytes = JSON.stringify(output) + '\n'; need(Buffer.byteLength(bytes) <= 4096);
  process.stdout.write(bytes);
}
try { await main(); }
catch (error) {
  const code = ERROR_CODES.has(error?.code) ? error.code : 'REFUSED';
  process.stderr.write(`SCHEMA3_FIXTURE_FAILED:${phase}:${code}\n`); process.exitCode = 1;
}
