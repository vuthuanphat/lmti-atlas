/** Fixed test-only fixture preparation. Never shipped in an Agent bundle.
 * Actual owner APIs create/accept LMIP rows; actual native owners supply targets.
 */
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';

const [action, rawRoot, rawRepo, rawPackage, rawProducer] = process.argv.slice(2);
if (process.argv.length !== 7 || !['setup', 'dirty', 'accept'].includes(action)) throw Error('FIXTURE_ARGUMENTS');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
async function ordinary(value, directory = false) {
  if (!path.isAbsolute(value)) throw Error('FIXTURE_PATH');
  const parsed = path.parse(value);
  let cursor = parsed.root;
  for (const part of path.relative(parsed.root, value).split(path.sep)) {
    cursor = path.join(cursor, part);
    const s = await fs.lstat(cursor);
    if (s.isSymbolicLink()) throw Error('FIXTURE_LINK');
  }
  const stat = await fs.stat(value);
  if (directory ? !stat.isDirectory() : !stat.isFile()) throw Error('FIXTURE_TYPE');
  return fs.realpath(value);
}
const root = await ordinary(rawRoot, true), repo = await ordinary(rawRepo, true);
const packaged = await ordinary(rawPackage, true), producer = await ordinary(rawProducer);
if (path.dirname(root) !== await fs.realpath(os.tmpdir()) ||
    !path.basename(root).startsWith('lmti-reviewed-mapping-process-')) throw Error('FIXTURE_ROOT');
const controlFile = path.join(root, 'fixture-control.json');
const sourceRoot = path.join(root, 'source'), nativeRoot = path.join(root, 'native');
const bin = name => path.join(packaged, 'bin', name);
const env = {};
for (const key of ['SystemRoot', 'WINDIR', 'TEMP', 'TMP']) if (process.env[key]) env[key] = process.env[key];
env.PATH = path.join(packaged, 'bin') + path.delimiter + path.dirname(process.execPath) +
  (process.platform === 'win32' ? path.delimiter + 'C:\\Windows\\System32' : '');
env.QT_PLUGIN_PATH = path.join(packaged, 'plugins');

async function run(executable, args, input) {
  await ordinary(executable);
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { shell: false, windowsHide: true, cwd: path.dirname(executable),
      env, stdio: ['pipe', 'pipe', 'pipe'] });
    const chunks = []; let outputBytes = 0, errorBytes = 0, failed = false;
    // Fixture writes are never killed/retried on timeout. The caller retains the
    // live process/fixture if this unexpected branch prevents completion.
    const timer = setTimeout(() => { failed = true; }, 60000);
    child.on('error', () => { failed = true; });
    child.stdin.on('error', () => { failed = true; });
    child.stdout.on('error', () => { failed = true; });
    child.stderr.on('error', () => { failed = true; });
    child.stdout.on('data', bytes => {
      outputBytes += bytes.length;
      if (outputBytes <= 4 * 1024 * 1024) chunks.push(bytes); else failed = true;
    });
    child.stderr.on('data', bytes => { errorBytes += bytes.length; if (errorBytes > 65536) failed = true; });
    child.on('close', code => {
      clearTimeout(timer);
      if (failed || code !== 0 || errorBytes !== 0) reject(Error('FIXTURE_CHILD_FAILED'));
      else resolve(Buffer.concat(chunks).toString('utf8'));
    });
    child.stdin.end(input === undefined ? undefined : JSON.stringify(input) + '\n');
  });
}
const impact = await import(pathToFileURL(path.join(repo, 'packages/impact/dist/index.js')));
const { compileProject } = await import(pathToFileURL(path.join(repo, 'packages/compiler/dist/index.js')));
const { createFixedMappingSourceObserver, mappingSourceAuthorityFingerprint } =
  await import(pathToFileURL(path.join(repo, 'packages/cli/dist/impact-mapping-source.js')));
const { createFixedMappingNativeObserver, mappingNativeAuthorityFingerprint } =
  await import(pathToFileURL(path.join(repo, 'packages/cli/dist/impact-mapping-native.js')));
const PROJECT = 'factory-monitor', SITE = 'factory-demo';
const now = () => new Date().toISOString();
const writeNew = (name, value) => fs.writeFile(name, JSON.stringify(value) + '\n', { flag: 'wx' });
const confirmed = value => {
  if (value.outcome !== 'confirmed') throw Error('FIXTURE_WRITE_NOT_CONFIRMED');
  return value.receipt;
};
let control;
if (action === 'setup') {
  if ((await fs.readdir(root)).length) throw Error('FIXTURE_NOT_EMPTY');
  await fs.mkdir(nativeRoot); await fs.mkdir(sourceRoot);
  await fs.mkdir(path.join(sourceRoot, 'src')); await fs.mkdir(path.join(sourceRoot, '.lmti'));
  await run(producer, ['--fixture', nativeRoot, '3', '2']);
  const state = JSON.parse(await run(bin('lmti-mcp-admin.exe'),
    ['--logical-hierarchy-read', '--library', path.join(nativeRoot, 'library.sqlite'),
      '--project', PROJECT, '--visibility', 'public'], { action: 'logical-hierarchy-state' }));
  if (!state.ok || state.projectIdentity.projectId !== PROJECT) throw Error('FIXTURE_NATIVE_IDENTITY');
  await fs.writeFile(path.join(sourceRoot, 'src/firmware.ts'),
    'export function reviewedBoundary() { return 7; }\n', { flag: 'wx' });
  const amf = await compileProject(sourceRoot);
  // Publish only this known synthetic file. Never change compiler defaults.
  if (amf.files.length !== 1 || amf.files[0].path !== 'src/firmware.ts') throw Error('FIXTURE_COMPILED_INVENTORY');
  amf.files[0].privacy = 'public';
  await fs.writeFile(path.join(sourceRoot, '.lmti/project.amf.json'), JSON.stringify(amf));
  const knowledgeSourceId = hash((process.platform === 'win32' ? sourceRoot.toLowerCase() : sourceRoot) + '\0' + amf.project.name);
  const input = { schema: 'lmti.impact.import.v1',
    source: { id: 'composition-source', projectId: PROJECT, siteId: SITE, environmentId: 'test',
      kind: 'manifest', privacy: 'public', revision: 'one', digest: hash('explicit fixture source declaration'),
      capturedAt: now(), parserVersion: 'composition-one', complete: true },
    entities: [{ id: 'entity-one', sourceKey: 'one', kind: 'service', label: 'Reviewed fixture service',
      ownerRole: 'Fixture', privacy: 'public' }],
    evidence: [{ id: 'proof-one', entityId: 'entity-one', locator: 'PRIVATE_LOCATOR_MARKER',
      summary: 'PRIVATE_EVIDENCE_BODY_MARKER', privacy: 'public', capturedAt: now() }], assertions: [] };
  const source = { schema: 'lmti.impact.mapping-source.v1', sourceId: input.source.id,
    projectId: PROJECT, siteId: SITE, environmentId: 'test', root: sourceRoot, descriptorFile: 'manifest.json',
    parserVersion: 'composition-one', policyVersion: 'one', kind: 'manifest',
    minimumClassification: 'public', allowInternal: false };
  const native = { schema: 'lmti.impact.mapping-native.v1', executable: bin('lmti-project.exe'),
    executableDigest: hash(await fs.readFile(bin('lmti-project.exe'))), database: path.join(nativeRoot, 'project.sqlite'),
    projectId: PROJECT, storeUuid: state.projectIdentity.storeUuid, siteId: SITE,
    environmentId: 'test', visibility: 'external' };
  const grant = { principalId: 'composition-reader', projectId: PROJECT, siteIds: [SITE],
    environmentIds: ['test'], allowInternal: false, policyVersion: 'one' };
  const authority = { sourceId: input.source.id, projectId: PROJECT, siteId: SITE, environmentId: 'test',
    kind: 'manifest', minimumClassification: 'public', sourceAuthorityFingerprint: mappingSourceAuthorityFingerprint(source),
    nativeProjectId: PROJECT, nativeStoreUuid: native.storeUuid,
    nativeAuthorityFingerprint: mappingNativeAuthorityFingerprint(native), policyVersion: 'one' };
  await writeNew(path.join(sourceRoot, 'manifest.json'), input);
  control = { schema: 'lmti.composition.test-fixture.v1', root, repo, packaged, producer,
    knowledgeSourceId, source, native, grant, authority, input, mappings: [],
    storePath: path.join(root, 'impact.sqlite'), acceptedVersion: null, rejectedId: null, pendingId: null };
  impact.initializeImpactStore(control.storePath);
} else {
  control = JSON.parse(await fs.readFile(controlFile, 'utf8'));
  if (control.schema !== 'lmti.composition.test-fixture.v1' || control.root !== root ||
      control.repo !== repo || control.packaged !== packaged || control.producer !== producer ||
      control.source.root !== sourceRoot || control.storePath !== path.join(root, 'impact.sqlite'))
    throw Error('FIXTURE_CONTROL');
}
if (action === 'dirty') {
  const changed = structuredClone(control.input);
  changed.entities[0].label = 'Reviewed fixture service changed';
  // Retain the old self-reported revision/digest; the real full-content observer
  // must still withhold the old accepted proof.
  await fs.writeFile(path.join(sourceRoot, 'manifest.json'), JSON.stringify(changed) + '\n');
  process.stdout.write('{"changed":true}\n');
} else {
  let observedInput = control.input;
  const fixed = { authorize() {}, clock: now };
  const sourceObserver = createFixedMappingSourceObserver(control.source, fixed);
  const nativeObserver = createFixedMappingNativeObserver(control.native, fixed);
  const op = impact.createImpactMappingOperator({ storePath: control.storePath,
    grant: control.grant, authorities: [control.authority], clock: now,
    maintenance: { capabilityId: 'fixture-maintenance', policyVersion: 'one', backupPath: path.join(root, 'impact-backup.sqlite') },
    observers: { authorize: fixed.authorize, async observe(request) {
      const context = { signal: new AbortController().signal, timeoutMilliseconds: 40000 };
      const source = await sourceObserver.observe({ phase: 'current', pass: 1, authority: control.authority,
        acceptedImport: observedInput, expectedContentFingerprint: impact.mappingSourceContentFingerprint(observedInput) }, context);
      const native = await nativeObserver.observe({ phase: 'current', pass: 1, authority: control.authority,
        allowInternal: false, targets: request.targets }, context);
      return { source: source.observation, native };
    } } });
  async function stage(mappings, version) {
    const body = { schema: 'lmti.impact.mapping-import.v1', input: observedInput,
      mappings, mappingVersion: version, expectedAcceptedVersion: control.acceptedVersion };
    return confirmed(await op.stageComplete({ ...body, payloadDigest: impact.mappingPayloadDigest(body) },
      op.inspectMappingFormat().graphRevision, randomUUID()));
  }
  try {
    if (action === 'setup') {
      confirmed(op.upgradeMappings(op.inspectMappingFormat(), randomUUID()));
      confirmed(op.registerSource(control.source.sourceId, op.inspectMappingFormat().graphRevision, randomUUID()));
      const native = await nativeObserver.observe({ phase: 'current', pass: 1, authority: control.authority,
        allowInternal: false, targets: [{ projectId: PROJECT, storeUuid: control.native.storeUuid, kind: 'repository', id: 'repo-sensor' }] },
      { signal: new AbortController().signal, timeoutMilliseconds: 40000 });
      const referenceFingerprint = native.targets[0].referenceFingerprint;
      if (!referenceFingerprint) throw Error('FIXTURE_REFERENCE');
      const row = (kind, target, suffix) => ({ mappingId: randomUUID(), externalKey: 'PRIVATE_EXTERNAL_' + suffix,
        generation: 'one', aliases: ['PRIVATE_ALIAS_' + suffix], classification: 'public', evidenceIds: ['proof-one'],
        state: 'active', impactEntityId: 'entity-one', replacesMappingId: null, kind,
        target: { projectId: PROJECT, storeUuid: control.native.storeUuid, ...target },
        ...(kind === 'code' ? { selection: 'src/firmware.ts', referenceFingerprint } : {}) });
      control.mappings = [row('identity', { kind: 'component', id: 'sensor-firmware' }, 'identity'),
        row('code', { kind: 'repository', id: 'repo-sensor' }, 'code-a'),
        row('code', { kind: 'repository', id: 'repo-sensor' }, 'code-b')];
      const accepted = await stage(control.mappings, 'accepted-one');
      confirmed(await op.decide(await op.preview(accepted.batchId), 'accept', randomUUID()));
      control.acceptedVersion = 'accepted-one';
      const rejected = row('identity', { kind: 'component', id: 'gateway-agent' }, 'rejected');
      control.rejectedId = rejected.mappingId;
      const rejectStage = await stage([...control.mappings, rejected], 'rejected-one');
      confirmed(await op.decide(await op.preview(rejectStage.batchId), 'reject', randomUUID()));
      const pending = row('identity', { kind: 'component', id: 'monitor-backend' }, 'pending');
      control.pendingId = pending.mappingId;
      await stage([...control.mappings, pending], 'pending-one');
      const format = op.inspectMappingFormat();
      const config = { schema: 'lmti.agent.mapping-owner.v1', storePath: control.storePath,
        storeUuid: format.storeUuid, sourceIdentityDigest: format.sourceIdentityDigest,
        grant: control.grant, authority: control.authority, native: control.native, source: control.source };
      control.mappingConfig = path.join(root, 'mapping-owner.json');
      await writeNew(control.mappingConfig, config);
      const knowledgeCli = path.join(packaged, 'share/lmti/knowledge-owner/index.js');
      const mappingCli = path.join(packaged, 'share/lmti/mapping-owner/index.js');
      await ordinary(knowledgeCli); await ordinary(mappingCli);
      const integration = { schema: 'lmti.agent.integration.v3', projectId: PROJECT, site: SITE,
        target: 'external', structure: true, observations: null,
        knowledge: { mode: 'reviewed', node: process.execPath, nodeSha256: hash(await fs.readFile(process.execPath)),
          cli: knowledgeCli, cliSha256: hash(await fs.readFile(knowledgeCli)), root: sourceRoot,
          sourceId: control.knowledgeSourceId, memoryDisclosure: 'none',
          mappingOwner: { cli: mappingCli, cliSha256: hash(await fs.readFile(mappingCli)),
            config: control.mappingConfig, configSha256: hash(await fs.readFile(control.mappingConfig)),
            sourceId: control.source.sourceId } } };
      control.integration = path.join(root, 'integration.json');
      await writeNew(control.integration, integration);
      await writeNew(controlFile, control);
    } else {
      observedInput = JSON.parse(await fs.readFile(path.join(sourceRoot, 'manifest.json'), 'utf8'));
      const accepted = await stage(control.mappings, 'accepted-two');
      confirmed(await op.decide(await op.preview(accepted.batchId), 'accept', randomUUID()));
      control.input = observedInput; control.acceptedVersion = 'accepted-two';
      await fs.writeFile(controlFile, JSON.stringify(control) + '\n');
    }
  } finally {
    await sourceObserver.waitForIdle(); await nativeObserver.waitForIdle();
  }
  process.stdout.write(JSON.stringify({ ready: true, acceptedVersion: control.acceptedVersion,
    activeIds: control.mappings.map(row => row.mappingId).sort(), rejectedId: control.rejectedId,
    pendingId: control.pendingId }) + '\n');
}
