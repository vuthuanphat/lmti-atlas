// WEB-00 interaction study only. No fetch, storage, owner calls or client writes.
// This state machine is synthetic and must never be imported into product code.
const strings = {
  en: {
    project:'PROJECT', mcp:'MCP & Agents', structure:'Project structure', activity:'Activity & review', local:'On this computer', boundary:'Project context, shared with your agents.', design:'Design preview', tryFlow:'Try a flow', workspace:'PROJECT WORKSPACE', subtitle:'One set of connections. Ready for your agents.', add:'+ Add connection', connections:'Connections', connectionsHelp:'Use your existing MCP endpoints. Sign in separately in each agent.', useWith:'Use with your agents', projectOnly:'Project configuration', how:'How these connections work', howText:'LMTI prepares the project configuration. Codex and Cursor own sign-in and tool execution. A saved configuration does not mean an endpoint or client has been verified.', fixture:'Synthetic data · Interactions stay in this tab · No files or accounts are changed', connection:'CONNECTION', editorHelp:'An existing MCP connection for this project.', type:'Connection type', name:'Name', endpoint:'HTTPS endpoint', endpointHelp:'Address only. Authentication happens in your agent.', localHelp:'Provides scoped project context through the existing LMTI MCP adapter.', advanced:'Advanced', key:'Server key', site:'Site scope', cancel:'Cancel', save:'Save connection', scenarioHelp:'Start a synthetic scenario. This resets the sample projects in this tab.', flowNew:'1. Set up a new project', flowNewHelp:'Add a connection, review the changes, set up both agents.', flowUpdate:'2. Update an existing configuration', flowUpdateHelp:'A new profile revision needs to be applied. Try a stale preview.', flowRecovery:'3. Recover an interrupted update', flowRecoveryHelp:'Restore, then resolve missing authentication or an offline endpoint.', localType:'LMTI project context', remoteType:'Remote MCP', cloudflareType:'Cloudflare MCP endpoint', privateType:'Private HTTPS endpoint / Tailscale', revision:'Revision {n}', sampleProject:'Sample project · Local workspace', emptyTitle:'Your project connections start here', emptyText:'Add LMTI context or an existing remote MCP endpoint.', edit:'Edit', pause:'Pause', enable:'Enable', enabled:'Enabled', disabled:'Paused', auth:'Sign-in required', offline:'Endpoint offline', unchecked:'Endpoint not checked', unverified:'Client use not verified', notApplied:'Not set up', pending:'Update available', applied:'Configuration applied', interrupted:'Recovery required', missing:'Client unavailable', setup:'Set up', preview:'Review update', review:'Review configuration', restore:'Restore', clientNew:'Prepare this project’s MCP connections for {client}.', clientPending:'Applied revision {old}; current revision {n}.', clientApplied:'Project configuration matches revision {n}.', clientRecovery:'An interrupted update must be recovered first.', clientMissing:'Choose export or install the client before setup.', check:'Check in preview', addTitle:'Add connection', editTitle:'Edit connection', invalidName:'Enter a name and a lowercase server key (letters, numbers, - or _).', invalidEndpoint:'Use a plain HTTPS address without credentials, query, fragment or encoded characters.', duplicate:'This server key already exists in this project.', limit:'This profile has reached the 32-connection limit.', saved:'Connection saved in the preview. Review the update in each agent.', toggled:'Connection changed in the preview. Existing client configurations need review.', previewTitle:'Set up {client}', previewHelp:'Review the connections for {project}. Unrelated client servers are preserved.', addDiff:'Add', updateDiff:'Update', removeDiff:'Remove', sameDiff:'Keep', noDiff:'No managed connection changes.', outline:'Configuration outline', outlineHelp:'Illustrative only. The native owner generates the actual TOML/JSON and local launch arguments in WEB-01.', applyPreview:'Apply in preview', previewSuccess:'{client} configuration applied in the preview. Sign-in and actual client use are still unverified.', recoverTitle:'Restore {client}', recoverHelp:'Recover the protected previous configuration. Changes made after the transaction require review.', restorePreview:'Restore in preview', restoreSuccess:'{client} restored in the preview. Create a fresh preview to update.', stale:'Configuration changed since preview. Nothing was applied. Create a new preview.', simulateDrift:'Simulate a configuration conflict', simulated:'Another editor changed this sample configuration. Applying this preview will be refused.', refreshPreview:'Create new preview', noRecovery:'No recovery point exists for this sample configuration.', clientHelpTitle:'Client not available', clientHelp:'The real app will offer an export and setup instructions. This study does not detect or install clients.', close:'Close', checkTitle:'Connection checks', checkHelp:'These are scenario outcomes, not a live network probe.', checkUnknown:'Client use remains unverified. Configuration, endpoint and client evidence are separate.', signInHelp:'Sign in through the selected agent. LMTI does not collect provider credentials.', structureTitle:'Understand your project', structureHelp:'A small declared structure, linked to the context your agents receive.', declared:'Declared structure', software:'Software', physical:'Deployment & devices', firmware:'Sensor firmware', service:'Telemetry service', repository:'Firmware repository', gateway:'Gateway · factory-demo', device:'Temperature sensor · desired binding', notObserved:'Live device observations are not connected in this preview.', structureEmpty:'This sample project has no declared structure yet.', activityHelp:'Configuration events in this preview. This is not a record of agent tool calls.', activityEmpty:'No configuration changes yet.', eventSave:'Profile changed', eventApply:'Client configuration applied', eventRestore:'Client configuration restored', eventInfo:'{client} · revision {n} · synthetic evidence', profileInfo:'Revision {n} · synthetic evidence', dialogFixture:'Preview only · No files are written', siteNeeded:'Choose a site scope for the local LMTI connection.'
  },
  vi: {
    project:'DỰ ÁN', mcp:'MCP & Agents', structure:'Cấu trúc dự án', activity:'Hoạt động & xét duyệt', local:'Trên máy này', boundary:'Context dự án dùng chung cho các agent.', design:'Bản mẫu giao diện', tryFlow:'Thử luồng', workspace:'KHÔNG GIAN DỰ ÁN', subtitle:'Một bộ kết nối. Dùng chung cho các agent.', add:'+ Thêm kết nối', connections:'Kết nối', connectionsHelp:'Dùng MCP endpoint sẵn có. Đăng nhập riêng trong từng agent.', useWith:'Dùng với agent của bạn', projectOnly:'Cấu hình theo dự án', how:'Các kết nối hoạt động thế nào', howText:'LMTI chuẩn bị cấu hình dự án. Codex và Cursor quản lý đăng nhập và thực thi công cụ. Lưu cấu hình chưa chứng minh endpoint hoặc client đã dùng được.', fixture:'Dữ liệu giả lập · Thao tác chỉ trong tab này · Không thay đổi file hoặc tài khoản', connection:'KẾT NỐI', editorHelp:'Một kết nối MCP sẵn có cho dự án này.', type:'Loại kết nối', name:'Tên', endpoint:'HTTPS endpoint', endpointHelp:'Chỉ nhập địa chỉ. Đăng nhập trong agent của bạn.', localHelp:'Cung cấp context theo phạm vi dự án qua MCP adapter LMTI hiện có.', advanced:'Nâng cao', key:'Khóa server', site:'Phạm vi site', cancel:'Hủy', save:'Lưu kết nối', scenarioHelp:'Bắt đầu tình huống giả lập. Các dự án mẫu trong tab này sẽ được đặt lại.', flowNew:'1. Thiết lập dự án mới', flowNewHelp:'Thêm kết nối, xem thay đổi, thiết lập hai agent.', flowUpdate:'2. Cập nhật cấu hình hiện có', flowUpdateHelp:'Có revision mới cần áp dụng. Thử preview bị lỗi thời.', flowRecovery:'3. Khôi phục cập nhật dở dang', flowRecoveryHelp:'Khôi phục, rồi xử lý thiếu đăng nhập hoặc endpoint mất kết nối.', localType:'Context dự án LMTI', remoteType:'MCP từ xa', cloudflareType:'MCP endpoint Cloudflare', privateType:'HTTPS riêng / Tailscale', revision:'Revision {n}', sampleProject:'Dự án mẫu · Không gian cục bộ', emptyTitle:'Bắt đầu với kết nối cho dự án', emptyText:'Thêm context LMTI hoặc MCP endpoint từ xa sẵn có.', edit:'Sửa', pause:'Tạm dừng', enable:'Bật', enabled:'Đã bật', disabled:'Tạm dừng', auth:'Cần đăng nhập', offline:'Endpoint mất kết nối', unchecked:'Chưa kiểm tra endpoint', unverified:'Chưa kiểm chứng client', notApplied:'Chưa thiết lập', pending:'Có cập nhật', applied:'Đã áp dụng cấu hình', interrupted:'Cần khôi phục', missing:'Client chưa có', setup:'Thiết lập', preview:'Xem cập nhật', review:'Xem cấu hình', restore:'Khôi phục', clientNew:'Chuẩn bị bộ MCP của dự án cho {client}.', clientPending:'Đã áp dụng revision {old}; hiện tại là {n}.', clientApplied:'Cấu hình dự án khớp revision {n}.', clientRecovery:'Cần khôi phục cập nhật dở dang trước.', clientMissing:'Xuất cấu hình hoặc cài client trước khi thiết lập.', check:'Kiểm tra giả lập', addTitle:'Thêm kết nối', editTitle:'Sửa kết nối', invalidName:'Nhập tên và khóa server viết thường (chữ, số, - hoặc _).', invalidEndpoint:'Dùng địa chỉ HTTPS không chứa credential, query, fragment hoặc ký tự mã hóa.', duplicate:'Khóa server đã có trong dự án này.', limit:'Profile đã đạt giới hạn 32 kết nối.', saved:'Đã lưu trong bản mẫu. Xem cập nhật trong từng agent.', toggled:'Kết nối trong bản mẫu đã đổi. Cần xem lại cấu hình client.', previewTitle:'Thiết lập {client}', previewHelp:'Xem kết nối cho {project}. Giữ nguyên các server khác trong client.', addDiff:'Thêm', updateDiff:'Cập nhật', removeDiff:'Bỏ', sameDiff:'Giữ', noDiff:'Không có thay đổi kết nối được quản lý.', outline:'Phác thảo cấu hình', outlineHelp:'Chỉ minh họa. Native owner sẽ tạo TOML/JSON thật và tham số chạy local ở WEB-01.', applyPreview:'Áp dụng trong bản mẫu', previewSuccess:'Đã áp dụng cấu hình {client} trong bản mẫu. Đăng nhập và sử dụng client thật vẫn chưa kiểm chứng.', recoverTitle:'Khôi phục {client}', recoverHelp:'Khôi phục cấu hình trước đó đã được bảo vệ. Thay đổi sau giao dịch cần xem xét.', restorePreview:'Khôi phục trong bản mẫu', restoreSuccess:'Đã khôi phục {client} trong bản mẫu. Tạo preview mới để cập nhật.', stale:'Cấu hình đã đổi sau preview. Chưa áp dụng gì. Tạo preview mới.', simulateDrift:'Giả lập xung đột cấu hình', simulated:'Một editor khác đã sửa cấu hình mẫu. Bản preview này sẽ bị từ chối.', refreshPreview:'Tạo preview mới', noRecovery:'Cấu hình mẫu này chưa có điểm khôi phục.', clientHelpTitle:'Client chưa có', clientHelp:'Ứng dụng thật sẽ cho xuất cấu hình và hướng dẫn thiết lập. Bản mẫu không dò hoặc cài client.', close:'Đóng', checkTitle:'Kiểm tra kết nối', checkHelp:'Đây là kết quả tình huống giả lập, chưa gọi mạng thật.', checkUnknown:'Sử dụng client chưa kiểm chứng. Cấu hình, endpoint và client có bằng chứng riêng.', signInHelp:'Đăng nhập qua agent đã chọn. LMTI không thu thập credential của nhà cung cấp.', structureTitle:'Hiểu cấu trúc dự án', structureHelp:'Cấu trúc khai báo nhỏ, liên kết với context agent nhận được.', declared:'Cấu trúc khai báo', software:'Phần mềm', physical:'Triển khai & thiết bị', firmware:'Firmware cảm biến', service:'Dịch vụ telemetry', repository:'Repository firmware', gateway:'Gateway · factory-demo', device:'Cảm biến nhiệt độ · liên kết mong muốn', notObserved:'Bản mẫu chưa kết nối nguồn quan sát thiết bị thật.', structureEmpty:'Dự án mẫu này chưa có cấu trúc khai báo.', activityHelp:'Sự kiện cấu hình trong bản mẫu. Đây chưa phải lịch sử agent gọi công cụ.', activityEmpty:'Chưa có thay đổi cấu hình.', eventSave:'Profile đã thay đổi', eventApply:'Đã áp dụng cấu hình client', eventRestore:'Đã khôi phục cấu hình client', eventInfo:'{client} · revision {n} · bằng chứng giả lập', profileInfo:'Revision {n} · bằng chứng giả lập', dialogFixture:'Chỉ là bản mẫu · Không ghi file', siteNeeded:'Chọn phạm vi site cho kết nối LMTI local.'
  }
};
const $ = (id) => document.getElementById(id);
let language = 'en', view = 'mcp', current = 'factory-monitor', editing = null, preview = null;
let projects;
const t = (key, values = {}) => {
  let result = strings[language][key] ?? key;
  for (const [name, value] of Object.entries(values)) result = result.replaceAll(`{${name}}`, String(value));
  return result;
};
function el(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}
function button(text, action, className = '') {
  const node = el('button', text, className); node.type = 'button'; node.addEventListener('click', action); return node;
}
const project = () => projects[current];
const activeServers = () => project().servers.filter((s) => s.enabled);
const copy = (value) => structuredClone(value);
function baseClient() { return {appliedRevision:null, servers:[], interrupted:false, available:true, backup:null, generation:0}; }
function reset(scenario = 'initial') {
  const local = {id:'lmti-context', name:'LMTI project context', provider:'local', endpoint:'', site:'factory-demo', enabled:true, check:'unchecked'};
  const remote = {id:'cloudflare', name:'Cloudflare', provider:'cloudflare', endpoint:'https://mcp.example.com/mcp', site:'', enabled:true, check:'auth'};
  projects = {
    'factory-monitor':{name:'Factory Monitor', revision:3, servers:[local,remote], clients:{Codex:baseClient(),Cursor:baseClient()}, events:[], structure:true},
    'edge-gateway':{name:'Edge Gateway', revision:1, servers:[], clients:{Codex:baseClient(),Cursor:baseClient()}, events:[], structure:false}
  };
  current = scenario === 'new' ? 'edge-gateway' : 'factory-monitor'; view = 'mcp'; preview = null;
  if (scenario === 'update' || scenario === 'recovery') {
    for (const client of Object.values(project().clients)) {
      client.appliedRevision = 2; client.servers = [copy(local)];
      client.backup = {appliedRevision:1, servers:[], generation:0};
    }
  }
  if (scenario === 'recovery') {
    project().clients.Codex.interrupted = true; project().clients.Cursor.available = false;
    project().servers[0].check = 'offline';
  }
  $('notice').hidden = true; render();
}
function pill(text, tone = '') { return el('span', text, `pill ${tone}`); }
function note(key, values = {}, success = false) {
  $('notice').textContent = t(key, values); $('notice').className = `notice${success ? ' success' : ''}`; $('notice').hidden = false;
  $('announcer').textContent = t(key, values);
}
function clientState(client) {
  if (!client.available) return 'missing';
  if (client.interrupted) return 'interrupted';
  if (client.appliedRevision === null) return 'notApplied';
  return client.appliedRevision === project().revision ? 'applied' : 'pending';
}
function render() {
  document.documentElement.lang = language;
  document.querySelectorAll('[data-i18n]').forEach((node) => { node.textContent = t(node.dataset.i18n); });
  $('language').textContent = language === 'en' ? 'Tiếng Việt' : 'English';
  $('language').setAttribute('aria-label', language === 'en' ? 'Switch to Vietnamese' : 'Chuyển sang tiếng Anh');
  $('project').setAttribute('aria-label', language === 'en' ? 'Choose project' : 'Chọn dự án');
  $('project').replaceChildren(...Object.entries(projects).map(([id,p]) => { const o = el('option', p.name); o.value = id; return o; }));
  $('project').value = current; $('project-note').textContent = t('sampleProject'); $('breadcrumb').textContent = `${project().name} / ${t(view)}`;
  document.querySelectorAll('[data-view]').forEach((node) => { const selected = node.dataset.view === view; node.classList.toggle('active', selected); if (selected) node.setAttribute('aria-current','page'); else node.removeAttribute('aria-current'); });
  for (const name of ['mcp','structure','activity']) $(`${name}-view`).hidden = view !== name;
  $('revision').textContent = t('revision',{n:project().revision});
  renderConnections(); renderClients(); renderStructure(); renderActivity();
}
function renderConnections() {
  const list = $('connections'); list.replaceChildren();
  if (!project().servers.length) {
    const empty = el('div',undefined,'empty'); empty.append(el('h3',t('emptyTitle')),el('p',t('emptyText'))); list.append(empty); return;
  }
  for (const server of project().servers) {
    const row = el('div',undefined,'connection-row');
    row.append(el('span',server.provider === 'local' ? 'L' : server.provider === 'cloudflare' ? 'C' : server.provider === 'private' ? 'T' : '↗','connection-icon'));
    const main = el('div',undefined,'connection-main'); main.append(el('h3',server.name));
    main.append(el('p',server.provider === 'local' ? `${t('localType')} · ${server.site}` : server.endpoint)); row.append(main);
    const actions = el('div',undefined,'connection-actions');
    actions.append(pill(t(server.enabled ? (server.provider === 'local' && server.check === 'unchecked' ? 'enabled' : server.check) : 'disabled'),server.enabled && ['auth','offline'].includes(server.check) ? (server.check === 'offline' ? 'bad' : 'warn') : 'neutral'));
    const toggle = button(t(server.enabled ? 'pause' : 'enable'), () => { server.enabled = !server.enabled; changed(); note('toggled'); },'text-button');
    toggle.setAttribute('aria-label',`${t(server.enabled ? 'pause' : 'enable')} ${server.name}`);
    const edit = button(t('edit'),() => openEditor(server),'text-button'); edit.setAttribute('aria-label',`${t('edit')} ${server.name}`);
    actions.append(edit,toggle); row.append(actions); list.append(row);
  }
}
function renderClients() {
  $('clients').replaceChildren();
  for (const [name,client] of Object.entries(project().clients)) {
    const state = clientState(client), card = el('div',undefined,'client-card'), heading = el('div',undefined,'client-heading');
    const title = el('h3'); title.append(el('span',name === 'Codex' ? '⌘' : '↗','client-logo'),el('span',name));
    heading.append(title,pill(t(state),['pending','interrupted'].includes(state) ? 'warn' : state === 'applied' ? '' : 'neutral'));
    card.append(heading,el('p',t(state === 'applied' ? 'clientApplied' : state === 'pending' ? 'clientPending' : state === 'interrupted' ? 'clientRecovery' : state === 'missing' ? 'clientMissing' : 'clientNew',{client:name,n:project().revision,old:client.appliedRevision}),'client-detail'),el('p',t('unverified')));
    const actions = el('div',undefined,'client-buttons');
    const primary = button(t(state === 'interrupted' ? 'restore' : state === 'applied' ? 'review' : state === 'pending' ? 'preview' : 'setup'),() => state === 'interrupted' ? openRestore(name) : state === 'missing' ? openMissing() : openPreview(name),state === 'applied' ? '' : 'primary');
    primary.setAttribute('aria-label',`${primary.textContent} ${name}`); actions.append(primary);
    if (client.backup && state !== 'interrupted') { const restore = button(t('restore'),() => openRestore(name)); restore.setAttribute('aria-label',`${t('restore')} ${name}`); actions.append(restore); }
    card.append(actions); $('clients').append(card);
  }
  const check = button(t('check'),openCheck,'text-button'); $('clients').after(check);
  // Replace the previous check control rather than accumulate one per render.
  check.id = 'check-button'; document.querySelectorAll('#check-button').forEach((node) => { if (node !== check) node.remove(); });
}
function changed() {
  project().revision++; project().events.unshift({key:'eventSave',revision:project().revision});
  render();
}
function openEditor(server = null) {
  editing = server?.id ?? null; $('connection-form').reset(); $('form-error').hidden = true;
  $('editor-title').textContent = t(server ? 'editTitle' : 'addTitle');
  for (const option of $('provider').options) option.textContent = t(`${option.value === 'local' ? 'local' : option.value === 'private' ? 'private' : option.value === 'cloudflare' ? 'cloudflare' : 'remote'}Type`);
  $('provider').value = server?.provider ?? 'local'; $('connection-name').value = server?.name ?? 'LMTI project context'; $('server-key').value = server?.id ?? 'lmti-context'; $('server-key').readOnly = Boolean(server);
  $('endpoint').value = server?.endpoint ?? ''; $('site').value = server?.site ?? (current === 'factory-monitor' ? 'factory-demo' : 'edge-demo');
  updateProvider(); $('editor').showModal(); $('connection-name').focus();
}
function updateProvider() {
  const local = $('provider').value === 'local'; $('endpoint-field').hidden = local; $('endpoint').required = !local; $('local-description').hidden = !local;
}
function validateAddress(value) {
  try { const url = new URL(value); return value.startsWith('https://') && url.protocol === 'https:' && url.hostname && !url.username && !url.password && !url.search && !url.hash && !/[\\%\s?#]/.test(value); } catch { return false; }
}
$('connection-form').addEventListener('submit',(event) => {
  event.preventDefault();
  const server = {id:$('server-key').value.trim(),name:$('connection-name').value.trim(),provider:$('provider').value,endpoint:$('endpoint').value.trim(),site:$('site').value.trim(),enabled:true,check:'unchecked'};
  let error;
  if (!server.name || !/^[a-z][a-z0-9_-]{0,47}$/.test(server.id) || /token|password|secret|credential|api[_-]?key/i.test(server.id) || /[\x00-\x1f\x7f]/.test(server.name + server.site)) error = 'invalidName';
  else if (project().servers.some((s) => s.id === server.id && s.id !== editing)) error = 'duplicate';
  else if (!editing && project().servers.length >= 32) error = 'limit';
  else if (server.provider !== 'local' && !validateAddress(server.endpoint)) error = 'invalidEndpoint';
  else if (server.provider === 'local' && !server.site) error = 'siteNeeded';
  if (error) { $('form-error').textContent = t(error); $('form-error').hidden = false; return; }
  if (server.provider === 'local') server.endpoint = ''; else server.check = 'auth';
  if (editing) { const index = project().servers.findIndex((s) => s.id === editing); server.enabled = project().servers[index].enabled; project().servers[index] = server; }
  else project().servers.push(server);
  $('editor').close(); changed(); note('saved',{},true);
});
function dialog(title) {
  $('client-title').textContent = title; $('client-dialog-body').replaceChildren(); $('client-dialog-actions').replaceChildren();
}
function openDialog() { if (!$('client-dialog').open) $('client-dialog').showModal(); }
function diffRows(before, after) {
  const rows = [];
  for (const server of after) { const old = before.find((s) => s.id === server.id); rows.push({server,key:!old ? 'addDiff' : JSON.stringify({...old,check:null}) === JSON.stringify({...server,check:null}) ? 'sameDiff' : 'updateDiff'}); }
  for (const server of before) if (!after.some((s) => s.id === server.id)) rows.push({server,key:'removeDiff'});
  return rows;
}
function openPreview(name) {
  const client = project().clients[name];
  preview = {project:current,name,revision:project().revision,generation:client.generation,servers:copy(activeServers())};
  dialog(t('previewTitle',{client:name}));
  const body = $('client-dialog-body'); body.append(el('p',t('previewHelp',{project:project().name}),'muted'));
  const diff = el('div',undefined,'diff'), rows = diffRows(client.servers,preview.servers);
  if (!rows.length) diff.append(el('p',t('noDiff'),'muted'));
  for (const row of rows) { const item = el('div',undefined,'diff-row'); item.append(el('code',row.server.id),pill(t(row.key),row.key === 'removeDiff' ? 'warn' : row.key === 'sameDiff' ? 'neutral' : '')); diff.append(item); }
  body.append(diff,el('p',`${t('revision',{n:preview.revision})} · ${t('dialogFixture')}`,'muted'));
  const details = el('details'); details.append(el('summary',t('outline')),el('p',t('outlineHelp'),'muted'));
  details.append(el('pre',preview.servers.map((s) => s.provider === 'local' ? `${s.id}\n  LMTI stdio · ${s.site}` : `${s.id}\n  ${s.endpoint}\n  OAuth: ${name}`).join('\n\n') || '—')); body.append(details);
  const conflict = button(t('simulateDrift'),() => { client.generation++; conflict.disabled = true; const msg = el('p',t('simulated'),'error'); msg.setAttribute('role','status'); body.append(msg); },'text-button');
  body.append(conflict);
  $('client-dialog-actions').append(button(t('cancel'),() => $('client-dialog').close()),button(t('applyPreview'),applyPreview,'primary')); openDialog();
}
function applyPreview() {
  const captured = preview; if (!captured) return;
  const client = project().clients[captured.name];
  if (captured.project !== current || captured.revision !== project().revision || captured.generation !== client.generation || client.interrupted || !client.available) {
    const body = $('client-dialog-body'), msg = el('p',t('stale'),'error'); msg.setAttribute('role','alert'); body.append(msg);
    $('client-dialog-actions').replaceChildren(button(t('cancel'),() => $('client-dialog').close()),button(t('refreshPreview'),() => openPreview(captured.name),'primary')); return;
  }
  client.backup = {appliedRevision:client.appliedRevision,servers:copy(client.servers),generation:client.generation};
  client.appliedRevision = captured.revision; client.servers = copy(captured.servers); client.generation++;
  project().events.unshift({key:'eventApply',client:captured.name,revision:captured.revision}); $('client-dialog').close(); render(); note('previewSuccess',{client:captured.name},true);
}
function openRestore(name) {
  const client = project().clients[name]; const expected = client.generation; const selected = current;
  dialog(t('recoverTitle',{client:name})); $('client-dialog-body').append(el('p',t(client.backup ? 'recoverHelp' : 'noRecovery'),'muted'),el('p',t('dialogFixture'),'soft-panel'));
  $('client-dialog-actions').append(button(t('cancel'),() => $('client-dialog').close()));
  if (client.backup) $('client-dialog-actions').append(button(t('restorePreview'),() => {
    if (current !== selected || client.generation !== expected) { const msg = el('p',t('stale'),'error'); msg.setAttribute('role','alert'); $('client-dialog-body').append(msg); return; }
    client.appliedRevision = client.backup.appliedRevision; client.servers = copy(client.backup.servers); client.backup = null; client.interrupted = false; client.generation++;
    project().events.unshift({key:'eventRestore',client:name,revision:client.appliedRevision ?? 0}); $('client-dialog').close(); render(); note('restoreSuccess',{client:name},true);
  },'primary')); openDialog();
}
function openMissing() {
  dialog(t('clientHelpTitle')); $('client-dialog-body').append(el('p',t('clientHelp'),'muted'));
  $('client-dialog-actions').append(button(t('close'),() => $('client-dialog').close())); openDialog();
}
function openCheck() {
  dialog(t('checkTitle')); const body = $('client-dialog-body'); body.append(el('p',t('checkHelp'),'muted'));
  const rows = el('div',undefined,'diff');
  for (const server of activeServers()) { const row = el('div',undefined,'diff-row'); row.append(el('span',server.name),pill(t(server.check),server.check === 'offline' ? 'bad' : server.check === 'auth' ? 'warn' : 'neutral')); rows.append(row); }
  body.append(rows,el('p',t('signInHelp'),'muted'),el('p',t('checkUnknown'),'soft-panel'));
  $('client-dialog-actions').append(button(t('close'),() => $('client-dialog').close())); openDialog();
}
function renderStructure() {
  const root = $('structure-view'); root.replaceChildren(el('h1',t('structureTitle')),el('p',t('structureHelp'),'subtitle'));
  if (!project().structure) { root.append(el('p',t('structureEmpty'),'soft-panel')); return; }
  const grid = el('div',undefined,'structure-grid');
  for (const [title,items] of [['software',['firmware','service','repository']],['physical',['gateway','device']]]) {
    const card = el('section',undefined,'structure-card'); card.append(el('h2',t(title)),el('p',t('declared'))); const list = el('ul'); for (const item of items) list.append(el('li',t(item))); card.append(list); grid.append(card);
  }
  root.append(el('p',t('notObserved'),'soft-panel'),grid);
}
function renderActivity() {
  const root = $('activity-view'); root.replaceChildren(el('h1',t('activity')),el('p',t('activityHelp'),'subtitle'));
  if (!project().events.length) { root.append(el('p',t('activityEmpty'),'soft-panel')); return; }
  const timeline = el('div',undefined,'timeline');
  for (const event of project().events.slice(0,30)) { const item = el('div',undefined,'timeline-item'); item.append(el('h3',t(event.key)),el('p',t(event.client ? 'eventInfo' : 'profileInfo',{client:event.client,n:event.revision}))); timeline.append(item); }
  root.append(timeline);
}
$('add-connection').addEventListener('click',() => openEditor());
$('provider').addEventListener('change',() => {
  if (!editing) { const type = $('provider').value; $('connection-name').value = type === 'local' ? 'LMTI project context' : type === 'cloudflare' ? 'Cloudflare' : type === 'private' ? 'Private MCP' : 'Remote MCP'; $('server-key').value = type === 'local' ? 'lmti-context' : type === 'cloudflare' ? 'cloudflare' : type === 'private' ? 'private-mcp' : 'remote-mcp'; }
  updateProvider();
});
$('project').addEventListener('change',() => { current = $('project').value; preview = null; $('notice').hidden = true; render(); });
$('language').addEventListener('click',() => { language = language === 'en' ? 'vi' : 'en'; $('notice').hidden = true; render(); });
document.querySelectorAll('[data-view]').forEach((node) => node.addEventListener('click',() => { view = node.dataset.view; render(); }));
$('scenarios').addEventListener('click',() => $('flow-dialog').showModal());
document.querySelectorAll('[data-scenario]').forEach((node) => node.addEventListener('click',() => { $('flow-dialog').close(); reset(node.dataset.scenario); }));
document.querySelectorAll('[data-close]').forEach((node) => node.addEventListener('click',() => $(node.dataset.close).close()));
reset();
