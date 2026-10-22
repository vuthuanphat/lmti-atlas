param([ValidateSet('en', 'vi')][string]$Language = 'en')
$ErrorActionPreference = 'Stop'
$taskRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$taskRenderRoot = Join-Path $taskRoot 'build/design-review'
$taskGallery = Join-Path $taskRoot 'docs/design/2026-10-12-ai-ui'
$taskRuntime = Join-Path $taskGallery 'runtime'
$taskReviewName = if ($Language -eq 'en') { 'runtime-review.html' } else { 'runtime-review-vi.html' }
$taskManifest = Get-Content -LiteralPath (Join-Path $taskGallery 'manifest.json') -Raw -Encoding utf8 | ConvertFrom-Json
$taskResultsPath = Join-Path $taskRenderRoot ('render-results-' + $Language + '.json')
$taskResults = Get-Content -LiteralPath $taskResultsPath -Raw -Encoding utf8 | ConvertFrom-Json
if ($taskResults.Count -ne $taskManifest.pages.Count) { throw 'Review requires a complete render set.' }
$taskCurrentHash = (Get-FileHash -LiteralPath (Join-Path $taskRoot 'build/studio-design/bin/lmti-desktop.exe') -Algorithm SHA256).Hash
New-Item -ItemType Directory -Path $taskRuntime -Force | Out-Null
function ConvertTo-ReviewHtml([string]$Value) { [Net.WebUtility]::HtmlEncode($Value) }
$taskSections = @()
foreach ($taskPage in $taskManifest.pages) {
    if ($taskPage.id -notmatch '^\d{2}-[a-z-]+$' -or $taskPage.file -notmatch '^\d{2}-[a-z0-9-]+\.png$') { throw 'Invalid gallery filename.' }
    $taskResult = @($taskResults | Where-Object { $_.Screen -eq $taskPage.id })
    if ($taskResult.Count -ne 1 -or -not $taskResult[0].Success -or $taskResult[0].PackageHash -ne $taskCurrentHash) { throw "Unverified or stale render: $($taskPage.id)" }
    $taskFilename = $taskPage.id + '-' + $Language + '.png'
    Copy-Item -LiteralPath (Join-Path $taskRenderRoot $taskFilename) -Destination (Join-Path $taskRuntime $taskFilename) -Force
    $taskTitle = ConvertTo-ReviewHtml $taskPage.title
    $taskNote = if ($taskPage.id -match '^1[789]-|^20-') { 'Nguồn mẫu tạm được đọc qua adapter có policy. Quyền duyệt giữ theo cấu hình khởi chạy, lesson chờ duyệt không được đưa vào context.' } else { 'Dữ liệu native là ví dụ riêng; số lượng và enum phải theo domain thực tế.' }
    $taskSections += @"
<section id="$($taskPage.id)"><h2>$taskTitle</h2><p class="note">Đang đối chiếu · chưa nghiệm thu. $taskNote</p><div class="pair"><figure><figcaption>Thiết kế Image AI</figcaption><a href="$($taskPage.file)" target="_blank" rel="noopener"><img src="$($taskPage.file)" alt="$taskTitle — thiết kế" loading="lazy"></a></figure><figure><figcaption>App Qt chạy thật · $Language</figcaption><a href="runtime/$taskFilename" target="_blank" rel="noopener"><img src="runtime/$taskFilename" alt="$taskTitle — bản chạy hiện tại" loading="lazy"></a></figure></div></section>
"@
}
$taskBody = $taskSections -join "`n"
$taskHtml = @"
<!doctype html><html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'self' file:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>LMTI — đối chiếu thiết kế và bản chạy</title><style>body{margin:0;background:#f5f7fa;color:#202a3a;font:15px Segoe UI,Arial,sans-serif}header{padding:28px;background:#162238;color:white}header p{max-width:1000px;line-height:1.7;color:#dce5f2}header a{color:#b8d1ff}main{padding:24px;max-width:1700px;margin:auto}section{background:white;border:1px solid #dce3eb;border-radius:8px;padding:18px;margin-bottom:28px}h2{font-size:20px}.note{color:#875400;background:#fff7e7;padding:12px;line-height:1.6}.pair{display:grid;grid-template-columns:1fr 1fr;gap:18px}figure{margin:0}figcaption{margin:8px 0;font-weight:600}img{width:100%;height:auto;display:block}a:focus-visible{outline:3px solid #3563e9}@media(max-width:900px){.pair{grid-template-columns:1fr}}</style></head><body><header><h1>Thiết kế và bản chạy hiện tại</h1><p>26 màn hình đang triển khai. Bên trái là concept AI, bên phải là ảnh chụp từ package Qt với dữ liệu mẫu riêng. Ảnh chụp thành công không chứng minh giao diện đã khớp hoặc mọi thao tác đã hoàn tất. Bản này còn cần sửa bố cục, bổ sung bộ lọc, hoàn thiện dịch và kiểm chứng đầy đủ trạng thái dữ liệu, kích thước, DPI.</p><a href="index.html">Quay lại bộ thiết kế AI</a></header><main>$taskBody</main></body></html>
"@
$taskHtml = $taskHtml.Replace('bổ sung bộ lọc, hoàn thiện dịch', 'hoàn thiện các trạng thái và bản dịch')
$taskHtml = $taskHtml.Replace('<a href="index.html">Quay lại bộ thiết kế AI</a>', '<a href="index.html">Bộ thiết kế AI</a> · <a href="runtime-review.html">English</a> · <a href="runtime-review-vi.html">Tiếng Việt</a>')
$taskHtml | Set-Content -LiteralPath (Join-Path $taskGallery $taskReviewName) -Encoding utf8
Copy-Item -LiteralPath $taskResultsPath -Destination (Join-Path $taskRuntime ('render-results-' + $Language + '.json')) -Force
Write-Output 'Wrote local comparison gallery for 26 current native renders.'
