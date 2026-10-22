# Deterministic delivery derivatives of the existing Image AI masters.
# This build utility changes resolution/encoding only; source artwork is retained.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$taskRepo = Split-Path -Parent $PSScriptRoot
$taskAssets = Join-Path $taskRepo 'apps/web-ui/src/assets'
$taskOutput = Join-Path $taskAssets 'delivery'
foreach ($taskPath in @($taskAssets,(Join-Path $taskAssets 'icons'),(Join-Path $taskAssets 'brand'))) {
    if ((Get-Item -LiteralPath $taskPath).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Linked artwork input refused.' }
}
if (Test-Path -LiteralPath $taskOutput) {
    if ((Get-Item -LiteralPath $taskOutput).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Linked artwork output refused.' }
} else { New-Item -ItemType Directory -Path $taskOutput | Out-Null }
$taskInputs = @('overview','work','architecture','knowledge','agent','connection','project','activity') | ForEach-Object { @{ Name=$_; Source="icons/$_.png"; Size=128 } }
$taskInputs += @{ Name='lmti-mark'; Source='brand/lmti-mark.png'; Size=160 }
$taskRows = @()
foreach ($taskEntry in $taskInputs) {
    $taskSource = Join-Path $taskAssets $taskEntry.Source
    $taskTarget = Join-Path $taskOutput ($taskEntry.Name + '.png')
    if ((Get-Item -LiteralPath $taskSource).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Linked artwork source refused.' }
    if ((Test-Path -LiteralPath $taskTarget) -and ((Get-Item -LiteralPath $taskTarget).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Linked artwork target refused.' }
    $taskImage = [Drawing.Image]::FromFile($taskSource)
    $taskBitmap = [Drawing.Bitmap]::new($taskEntry.Size,$taskEntry.Size,[Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $taskGraphics = [Drawing.Graphics]::FromImage($taskBitmap)
    $taskAttributes = [Drawing.Imaging.ImageAttributes]::new()
    try {
        $taskGraphics.CompositingMode = [Drawing.Drawing2D.CompositingMode]::SourceCopy
        $taskGraphics.CompositingQuality = [Drawing.Drawing2D.CompositingQuality]::HighQuality
        $taskGraphics.InterpolationMode = [Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $taskGraphics.PixelOffsetMode = [Drawing.Drawing2D.PixelOffsetMode]::HighQuality
        $taskAttributes.SetWrapMode([Drawing.Drawing2D.WrapMode]::TileFlipXY)
        $taskGraphics.DrawImage($taskImage,[Drawing.Rectangle]::new(0,0,$taskEntry.Size,$taskEntry.Size),0,0,$taskImage.Width,$taskImage.Height,[Drawing.GraphicsUnit]::Pixel,$taskAttributes)
        $taskBitmap.Save($taskTarget,[Drawing.Imaging.ImageFormat]::Png)
    } finally { $taskAttributes.Dispose(); $taskGraphics.Dispose(); $taskBitmap.Dispose(); $taskImage.Dispose() }
    $taskRows += [pscustomobject]@{ File=$taskEntry.Name+'.png'; Edge=$taskEntry.Size; Bytes=(Get-Item -LiteralPath $taskTarget).Length; Sha256=(Get-FileHash -LiteralPath $taskTarget -Algorithm SHA256).Hash.ToLowerInvariant(); MasterSha256=(Get-FileHash -LiteralPath $taskSource -Algorithm SHA256).Hash.ToLowerInvariant() }
}
$taskRows | ConvertTo-Json -Depth 3
