export function ProjectOnboarding({language,loaded,disabled,onRefresh,onSetup}:{
  language:'en'|'vi';loaded:boolean;disabled:boolean;onRefresh:()=>void;onSetup?:()=>void;
}) {
  const t=(en:string,vi:string)=>language==='vi'?vi:en;
  if(!loaded)return <section className="empty" aria-labelledby="projects-unavailable">
    <h1 id="projects-unavailable">{t('Projects unavailable','Chưa tải được dự án')}</h1>
    <p>{t('The local owner could not load the project library. Check the package and refresh. Existing data has not been replaced.',
      'Owner cục bộ chưa tải được thư viện. Kiểm tra gói ứng dụng rồi tải lại. Dữ liệu hiện có không bị thay thế.')}</p>
    <button disabled={disabled} onClick={onRefresh}>{t('Refresh projects','Tải lại dự án')}</button>
  </section>;
  return <section className="empty" aria-labelledby="project-onboarding-title">
    <h1 id="project-onboarding-title">{t('No projects in this session','Phiên này chưa có dự án')}</h1>
    {onSetup&&<><p>{t('With an explicit library grant, open Work to create or register a project in the browser. Otherwise use the operator commands below.','Nếu đã cấp quyền thư viện, mở Công việc để tạo hoặc đăng ký dự án trên trình duyệt. Nếu chưa, dùng các lệnh operator bên dưới.')}</p><button disabled={disabled} onClick={onSetup}>{t('Open library setup','Mở thiết lập thư viện')}</button></>}
    <p>{t('Create or register a project, or restart the launcher with access to an existing project. This list shows only the scope granted to this session.',
      'Tạo hoặc đăng ký dự án, hoặc khởi động lại launcher với quyền truy cập dự án có sẵn. Danh sách chỉ hiển thị phạm vi được cấp cho phiên này.')}</p>
    <ol>
      <li>{t('Choose existing local data and project folders outside .lmti. Keep a backup of existing data.',
        'Chọn thư mục dữ liệu và dự án cục bộ đã tồn tại, nằm ngoài .lmti. Giữ bản sao lưu dữ liệu hiện có.')}</li>
      <li>{t('In the package directory, use these operator commands with your chosen absolute paths:',
        'Từ thư mục gói ứng dụng, dùng các lệnh operator sau với đường dẫn tuyệt đối bạn đã chọn:')}
        <pre><code>{'bin/lmti-project.exe init-project <new-project.sqlite> <project-id> <project-name>\nbin/lmti-project.exe library-register <data/project-library.sqlite> <project.sqlite> <project-folder>'}</code></pre>
      </li>
      <li>{t('For an existing project, skip init-project. Registration never replaces an existing project ID. Restart the local launcher after registering so it can grant the new project scope.',
        'Với dự án có sẵn, bỏ qua init-project. Đăng ký không thay thế ID dự án đã có. Khởi động lại launcher sau khi đăng ký để cấp phạm vi cho dự án mới.')}</li>
    </ol>
    <p>{t('These commands create metadata, not a repository copy or device connection. No API keys or tokens belong in project metadata.',
      'Các lệnh tạo metadata, không sao chép repository hay kết nối thiết bị. Không lưu API key hoặc token vào metadata dự án.')}</p>
    <button disabled={disabled} onClick={onRefresh}>{t('Refresh projects','Tải lại dự án')}</button>
  </section>;
}
