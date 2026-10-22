// Session bearer exists only in this closure. Never persisted or logged.
const fragment = new URLSearchParams(location.hash.slice(1));
const nonce = fragment.get('bootstrap');
history.replaceState(null,'',location.pathname);
let bearer = null;
const status = document.getElementById('status');
const projects = document.getElementById('projects');
async function request(path, method = 'GET', body) {
  const headers = {'X-LMTI-UI':'1'};
  if (bearer) headers.Authorization = `Bearer ${bearer}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(path,{method,headers,body:body === undefined ? undefined : JSON.stringify(body),credentials:'omit',cache:'no-store'});
  const value = await response.json();
  if (!value.ok) { if (response.status === 401) { bearer = null; projects.replaceChildren(); } throw new Error(value.error.message); }
  return value.data;
}
function node(tag,text) { const n = document.createElement(tag); n.textContent = text; return n; }
async function start() {
  if (!nonce) { status.textContent = 'Open this page through start-local-web.ps1 to start an authenticated session.'; return; }
  const session = await request('/api/v1/session/bootstrap','POST',{nonce}); bearer = session.token;
  status.textContent = 'Local session connected. Project data below comes from the native owners.';
  document.getElementById('signout').hidden = false;
  const page = await request('/api/v1/projects?limit=50');
  for (const project of page.items) {
    const card = document.createElement('article'); card.append(node('h2',project.name),node('p',`Project revision ${project.projectRevision} · MCP profile ${project.profileRevision}`));
    const button = node('button','Read MCP profile'); button.addEventListener('click',async () => {
      button.disabled = true;
      try { const profile = await request(`/api/v1/projects/${project.id}/mcp-profile`); card.querySelector('pre')?.remove(); card.append(node('pre',JSON.stringify(profile,null,2))); }
      catch (e) { status.textContent = e.message; } finally { button.disabled = false; }
    }); card.append(button); projects.append(card);
  }
  if (!page.items.length) projects.append(node('p','No permitted projects in this library. Select a project in the native Studio, then launch again.'));
}
document.getElementById('signout').addEventListener('click',async () => {
  try { await request('/api/v1/session','DELETE'); } finally { bearer = null; projects.replaceChildren(); status.textContent = 'Session ended. Launch again to continue.'; document.getElementById('signout').hidden = true; }
});
start().catch((e) => { status.textContent = e.message; });
