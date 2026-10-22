import type { ClientId, ClientStatusDto, ProfileDto, ProjectSummary } from '../../web-api/src/contracts';
import { Icon } from './Icon';
import './WorkspaceOverview.css';

export interface WorkspaceOverviewProps {
  project: ProjectSummary;
  profile: ProfileDto | null;
  statuses: Partial<Record<ClientId, ClientStatusDto>>;
  loading: boolean;
  disabled: boolean;
  language: 'en' | 'vi';
  onNavigate: (section: 'work' | 'architecture' | 'knowledge' | 'agent') => void;
}

type Destination = Parameters<WorkspaceOverviewProps['onNavigate']>[0];
const clients: ClientId[] = ['codex', 'cursor'];

export function WorkspaceOverview({ project, profile, statuses, loading, disabled, language, onNavigate }: WorkspaceOverviewProps) {
  const t = (en: string, vi: string) => language === 'vi' ? vi : en;
  // Project changes clear the parent state; this additional guard keeps old profile counts out of the overview.
  const currentProfile = profile?.projectId === project.id ? profile : null;
  const connections = currentProfile?.servers.length;
  const enabledConnections = currentProfile?.servers.filter(server => server.enabled).length;
  const receivedClients = clients.filter(client => statuses[client]?.client === client);
  const currentClients = currentProfile ? receivedClients.filter(client => {
    const status = statuses[client]!;
    return status.configuration === 'applied' && status.appliedRevision === currentProfile.revision;
  }).length : null;
  const recoveryRequired = receivedClients.some(client => statuses[client]!.configuration === 'recovery_required');
  const reviewRequired = receivedClients.some(client => statuses[client]!.configuration === 'review_required');

  const next: { destination: Destination; title: string; description: string; action: string } = recoveryRequired ? {
    destination: 'work', title: t('Review the pending recovery', 'Kiểm tra yêu cầu phục hồi'),
    description: t('A client configuration needs recovery review before another change.', 'Cấu hình client cần được kiểm tra phục hồi trước khi thay đổi tiếp.'),
    action: t('Open work & review', 'Mở công việc và duyệt'),
  } : reviewRequired ? {
    destination: 'agent', title: t('Review your client setup', 'Kiểm tra thiết lập client'),
    description: t('Review the current configuration before applying another update.', 'Kiểm tra cấu hình hiện tại trước khi áp dụng bản cập nhật tiếp theo.'),
    action: t('Review Agent setup', 'Kiểm tra thiết lập Agent'),
  } : currentProfile === null ? {
    destination: 'agent', title: t('Start with your project connections', 'Bắt đầu từ kết nối dự án'),
    description: t('Open Agent to inspect the project profile and client configuration.', 'Mở Agent để xem hồ sơ kết nối và cấu hình client của dự án.'),
    action: t('Open Agent setup', 'Mở thiết lập Agent'),
  } : connections === 0 ? {
    destination: 'agent', title: t('Add your first project connection', 'Thêm kết nối đầu tiên cho dự án'),
    description: t('Create a shared MCP profile, then review its configuration for Codex or Cursor.', 'Tạo hồ sơ MCP dùng chung, rồi xem trước cấu hình cho Codex hoặc Cursor.'),
    action: t('Set up a connection', 'Thiết lập kết nối'),
  } : enabledConnections === 0 || currentClients !== clients.length ? {
    destination: 'agent', title: t('Continue your Agent setup', 'Tiếp tục thiết lập Agent'),
    description: t('Review enabled connections and each client’s configuration against the current profile.', 'Kiểm tra các kết nối được bật và cấu hình từng client theo hồ sơ hiện tại.'),
    action: t('Review Agent setup', 'Kiểm tra thiết lập Agent'),
  } : {
    destination: 'architecture', title: t('Explore the project behind your connections', 'Khám phá cấu trúc sau các kết nối'),
    description: t('Inspect project structure and follow the relationships that give your Agents context.', 'Xem cấu trúc và các quan hệ cung cấp ngữ cảnh dự án cho Agent.'),
    action: t('Open Architecture', 'Mở kiến trúc'),
  };

  const sections: { id: Destination; title: string; description: string; detail: string }[] = [
    { id: 'work', title: t('Work', 'Công việc'), description: t('Follow activity, review changes and manage project operations.', 'Theo dõi hoạt động, duyệt thay đổi và quản lý thao tác dự án.'), detail: t('Activity & review', 'Hoạt động và duyệt') },
    { id: 'architecture', title: t('Architecture', 'Kiến trúc'), description: t('Explore software, devices and the relationships between them.', 'Khám phá phần mềm, thiết bị và các quan hệ giữa chúng.'), detail: t('Structure & relationships', 'Cấu trúc và quan hệ') },
    { id: 'knowledge', title: t('Knowledge', 'Tri thức'), description: t('Find project context and the code, documents and evidence behind it.', 'Xem ngữ cảnh dự án cùng mã nguồn, tài liệu và bằng chứng liên quan.'), detail: t('Context & references', 'Ngữ cảnh và tham chiếu') },
    { id: 'agent', title: 'Agent', description: t('Manage shared MCP connections and setup for Codex and Cursor.', 'Quản lý kết nối MCP dùng chung và thiết lập Codex, Cursor.'), detail: t('Connections & clients', 'Kết nối và client') },
  ];
  const configurationLabel = (status: ClientStatusDto) => {
    switch (status.configuration) {
      case 'applied': return status.appliedRevision === currentProfile?.revision ? t('Current profile applied', 'Đã áp dụng hồ sơ hiện tại') : t('Configured · check revision', 'Đã cấu hình · cần kiểm tra phiên bản');
      case 'not_applied': return t('Not set up', 'Chưa thiết lập');
      case 'update_pending': return t('Update available', 'Có bản cập nhật');
      case 'recovery_required': return t('Recovery required', 'Cần phục hồi');
      case 'review_required': return t('Review required', 'Cần kiểm tra');
      case 'unavailable': return t('Status unavailable', 'Chưa có trạng thái');
    }
  };
  const profileKnown = !loading && currentProfile !== null;

  return <div className="workspace-overview" aria-busy={loading}>
    <header className="workspace-overview__heading">
      <div><p className="workspace-overview__eyebrow">{t('PROJECT WORKSPACE', 'KHÔNG GIAN DỰ ÁN')}</p><h1>{t('Overview', 'Tổng quan')}</h1>
        <p>{t('Your project, connections and next steps in one place.', 'Dự án, kết nối và bước tiếp theo tại một nơi.')}</p></div>
      <span className="workspace-overview__local">{t('Local workspace', 'Không gian trên máy')}</span>
    </header>

    <section className="workspace-overview__project" aria-labelledby="workspace-project-title">
      <div className="workspace-overview__project-heading"><span className="workspace-overview__project-icon"><Icon name="project" size={28} /></span>
        <div><p className="workspace-overview__eyebrow">{t('CURRENT PROJECT', 'DỰ ÁN HIỆN TẠI')}</p><h2 id="workspace-project-title">{project.name}</h2></div>
        <span className="workspace-overview__folder">{project.linkedRoot ? t('Folder linked', 'Đã liên kết thư mục') : t('Folder not linked', 'Chưa liên kết thư mục')}</span>
      </div>
      <p className="workspace-overview__project-id"><span>{t('Project ID', 'Mã dự án')}</span><code>{project.id}</code></p>
      <dl className="workspace-overview__metrics">
        <div><dt>{t('Project revision', 'Phiên bản dự án')}</dt><dd>{project.projectRevision}</dd><span>{t('Saved project state', 'Trạng thái dự án đã lưu')}</span></div>
        <div><dt>{t('MCP connections', 'Kết nối MCP')}</dt><dd>{profileKnown ? connections : '—'}</dd><span>{profileKnown ? t(`${enabledConnections} enabled in profile`, `${enabledConnections} được bật trong hồ sơ`) : t('Profile not loaded', 'Chưa tải hồ sơ')}</span></div>
        <div><dt>{t('Clients on current profile', 'Client dùng hồ sơ hiện tại')}</dt><dd>{profileKnown && receivedClients.length === clients.length ? `${currentClients} / ${clients.length}` : '—'}</dd><span>Codex · Cursor</span></div>
      </dl>
    </section>

    <div className="workspace-overview__dashboard">
      <div className="workspace-overview__main">
        <section className={`workspace-overview__next${recoveryRequired || reviewRequired ? ' workspace-overview__next--attention' : ''}`} aria-labelledby="workspace-next-title">
          <p className="workspace-overview__eyebrow">{t('NEXT STEP', 'BƯỚC TIẾP THEO')}</p>
          <h2 id="workspace-next-title">{loading ? t('Loading your project setup…', 'Đang tải thiết lập dự án…') : next.title}</h2>
          <p>{loading ? t('Connection details will appear when the profile is loaded.', 'Chi tiết kết nối sẽ hiện sau khi tải xong hồ sơ.') : next.description}</p>
          <button type="button" className="workspace-overview__primary" disabled={disabled || loading} onClick={() => onNavigate(next.destination)}>{next.action}<span aria-hidden="true">→</span></button>
        </section>

        <section className="workspace-overview__connections" aria-labelledby="workspace-connections-title">
          <div className="workspace-overview__section-heading"><h2 id="workspace-connections-title"><Icon name="connection" size={20} />{t('Project connections', 'Kết nối dự án')}</h2><span>MCP</span></div>
          <p className="workspace-overview__helper">{t('Connections saved in this profile. Handshake results are available in Agent.', 'Các kết nối đã lưu trong hồ sơ. Xem kết quả bắt tay tại Agent.')}</p>
          {profileKnown && currentProfile.servers.length > 0 ? <div className="workspace-overview__table-wrap"><table>
            <thead><tr><th scope="col">{t('Connection', 'Kết nối')}</th><th scope="col">{t('Type', 'Loại')}</th><th scope="col">{t('In profile', 'Trong hồ sơ')}</th></tr></thead>
            <tbody>{currentProfile.servers.map(server => <tr key={server.id}>
              <td><strong>{server.label}</strong><code>{server.id}</code></td>
              <td>{server.transport === 'lmti_local' ? t('Local LMTI', 'LMTI cục bộ') : 'HTTPS'}</td>
              <td><span className={`workspace-overview__badge${server.enabled ? ' workspace-overview__badge--enabled' : ''}`}>{server.enabled ? t('Enabled', 'Được bật') : t('Disabled', 'Đã tắt')}</span></td>
            </tr>)}</tbody>
          </table></div> : <p className="workspace-overview__empty">{loading ? t('Loading profile…', 'Đang tải hồ sơ…') : profileKnown ? t('No connections in this profile yet.', 'Chưa có kết nối trong hồ sơ này.') : t('Load the project profile in Agent to inspect its connections.', 'Tải hồ sơ dự án trong Agent để kiểm tra các kết nối.')}</p>}
        </section>
      </div>

      <section className="workspace-overview__setup" aria-labelledby="workspace-setup-title">
        <div className="workspace-overview__setup-intro">
          <p className="workspace-overview__eyebrow">{t('AGENT SETUP', 'THIẾT LẬP AGENT')}</p><h2 id="workspace-setup-title">{t('Configuration at a glance', 'Cấu hình hiện tại')}</h2>
          <p>{t('Saved configuration and recorded client use are shown separately.', 'Cấu hình đã lưu và việc sử dụng client đã xác minh được hiển thị riêng.')}</p>
          <p className="workspace-overview__profile-revision">{t('Profile revision', 'Phiên bản hồ sơ')} <strong>{currentProfile?.revision ?? project.profileRevision}</strong></p>
        </div>
        <ul className="workspace-overview__clients">{clients.map(client => {
          const status = statuses[client]?.client === client ? statuses[client] : undefined;
          const needsAttention = status?.configuration === 'recovery_required' || status?.configuration === 'review_required';
          return <li key={client}>
            <div className="workspace-overview__client-name"><span className="workspace-overview__client-symbol" aria-hidden="true">{client === 'codex' ? 'C' : '↗'}</span><strong>{client === 'codex' ? 'Codex' : 'Cursor'}</strong></div>
            <div className="workspace-overview__client-state">
              <span className="workspace-overview__client-label">{t('Configuration', 'Cấu hình')}</span>
              <span className={needsAttention ? 'workspace-overview__attention' : undefined}>{loading ? t('Loading…', 'Đang tải…') : status ? configurationLabel(status) : t('Status not loaded', 'Chưa tải trạng thái')}</span>
              <span className="workspace-overview__client-label">{t('Use evidence', 'Bằng chứng sử dụng')}</span>
              <small>{!loading && status ? status.clientUse === 'verified' ? t('Client use verified', 'Đã xác minh sử dụng client') : t('Client use not verified', 'Chưa xác minh sử dụng client') : t('Awaiting status', 'Đang chờ trạng thái')}</small>
            </div>
          </li>;
        })}</ul>
      </section>
    </div>

    <section className="workspace-overview__areas" aria-labelledby="workspace-areas-title">
      <div className="workspace-overview__section-heading"><h2 id="workspace-areas-title">{t('Explore your project', 'Khám phá dự án')}</h2><span>{t('One project. A shared context.', 'Cùng dự án. Chung ngữ cảnh.')}</span></div>
      <div className="workspace-overview__area-grid">{sections.map(section => <button key={section.id} type="button" className="workspace-overview__area" disabled={disabled} onClick={() => onNavigate(section.id)}>
        <span className="workspace-overview__area-icon"><Icon name={section.id} size={24} /></span>
        <span className="workspace-overview__area-copy"><span className="workspace-overview__area-title">{section.title}</span><span className="workspace-overview__area-description">{section.description}</span><span className="workspace-overview__area-detail">{section.detail}</span></span><span className="workspace-overview__area-arrow" aria-hidden="true">→</span>
      </button>)}</div>
    </section>
  </div>;
}

export default WorkspaceOverview;
