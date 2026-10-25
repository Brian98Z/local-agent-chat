$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$root = $PSScriptRoot
$sizes = @(16, 24, 32, 48, 64, 128, 256)
$images = @()
foreach ($size in $sizes) {
    $bmp = New-Object System.Drawing.Bitmap($size, $size)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.Clear([System.Drawing.Color]::Transparent)
    $g.ScaleTransform(($size / 256.0), ($size / 256.0))
    $tile = New-Object System.Drawing.Drawing2D.GraphicsPath
    $tile.AddArc(8, 8, 72, 72, 180, 90)
    $tile.AddArc(176, 8, 72, 72, 270, 90)
    $tile.AddArc(176, 176, 72, 72, 0, 90)
    $tile.AddArc(8, 176, 72, 72, 90, 90)
    $tile.CloseFigure()
    $green = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(26, 91, 75))
    $white = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(241, 250, 244))
    $mint = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(132, 218, 169))
    $g.FillPath($green, $tile)
    $bubble = New-Object System.Drawing.Drawing2D.GraphicsPath
    $bubble.AddArc(42, 48, 48, 48, 180, 90)
    $bubble.AddArc(166, 48, 48, 48, 270, 90)
    $bubble.AddArc(166, 136, 48, 48, 0, 90)
    $bubble.AddLine(190, 184, 106, 184)
    $bubble.AddLine(106, 184, 66, 213)
    $bubble.AddLine(66, 213, 66, 184)
    $bubble.AddArc(42, 136, 48, 48, 90, 90)
    $bubble.CloseFigure()
    $g.FillPath($white, $bubble)
    $pen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(26, 91, 75), 8)
    $g.DrawLine($pen, 81, 129, 128, 96)
    $g.DrawLine($pen, 128, 96, 175, 129)
    $g.DrawLine($pen, 81, 129, 175, 129)
    $g.FillEllipse($green, 66, 114, 30, 30)
    $g.FillEllipse($green, 160, 114, 30, 30)
    $g.FillEllipse($green, 109, 77, 38, 38)
    $g.FillEllipse($mint, 117, 85, 22, 22)
    $stream = New-Object System.IO.MemoryStream
    $bmp.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
    $images += ,($stream.ToArray())
    if ($size -eq 256) { $bmp.Save((Join-Path $root 'chat-icon.png'), [System.Drawing.Imaging.ImageFormat]::Png) }
    $stream.Dispose(); $pen.Dispose(); $bubble.Dispose(); $tile.Dispose()
    $green.Dispose(); $white.Dispose(); $mint.Dispose(); $g.Dispose(); $bmp.Dispose()
}
$file = [System.IO.File]::Create((Join-Path $root 'chat-icon.ico'))
$writer = New-Object System.IO.BinaryWriter($file)
try {
    $writer.Write([uint16]0); $writer.Write([uint16]1); $writer.Write([uint16]$sizes.Count)
    $offset = 6 + 16 * $sizes.Count
    for ($i = 0; $i -lt $sizes.Count; $i++) {
        $dim = $sizes[$i] % 256
        $writer.Write([byte]$dim); $writer.Write([byte]$dim)
        $writer.Write([byte]0); $writer.Write([byte]0)
        $writer.Write([uint16]1); $writer.Write([uint16]32)
        $writer.Write([uint32]$images[$i].Length); $writer.Write([uint32]$offset)
        $offset += $images[$i].Length
    }
    foreach ($image in $images) { $writer.Write([byte[]]$image) }
} finally { $writer.Dispose(); $file.Dispose() }
Write-Output 'Built chat-icon.ico (16/24/32/48/64/128/256) and chat-icon.png'
