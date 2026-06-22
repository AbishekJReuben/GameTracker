# Generates branded NSIS installer artwork (24-bit BMPs) that match the app's
# dark / accent "Tracker" theme. Run from the src-tauri/installer folder.
Add-Type -AssemblyName System.Drawing

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$iconPng = Join-Path $here "..\icons\icon.png"

function New-Tile([int]$w, [int]$h) {
  $bmp = New-Object Drawing.Bitmap $w, $h, ([Drawing.Imaging.PixelFormat]::Format24bppRgb)
  $g = [Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = 'AntiAlias'
  $g.InterpolationMode = 'HighQualityBicubic'
  $g.TextRenderingHint = 'ClearTypeGridFit'
  return @($bmp, $g)
}

function Fill-Background($g, [int]$w, [int]$h) {
  $rect = New-Object Drawing.Rectangle 0, 0, $w, $h
  $top = [Drawing.Color]::FromArgb(13, 14, 24)
  $bot = [Drawing.Color]::FromArgb(6, 7, 14)
  $grad = New-Object Drawing.Drawing2D.LinearGradientBrush $rect, $top, $bot, 90
  $g.FillRectangle($grad, $rect)
  $grad.Dispose()
}

# Soft radial accent glow centered at ($cx,$cy)
function Add-Glow($g, [int]$cx, [int]$cy, [int]$r, $color) {
  $path = New-Object Drawing.Drawing2D.GraphicsPath
  $path.AddEllipse(($cx - $r), ($cy - $r), ($r * 2), ($r * 2))
  $pg = New-Object Drawing.Drawing2D.PathGradientBrush $path
  $pg.CenterColor = $color
  $pg.SurroundColors = @([Drawing.Color]::FromArgb(0, $color))
  $g.FillPath($pg, $path)
  $pg.Dispose(); $path.Dispose()
}

function Rounded-Rect([int]$x, [int]$y, [int]$w, [int]$h, [int]$rad) {
  $p = New-Object Drawing.Drawing2D.GraphicsPath
  $d = $rad * 2
  $p.AddArc($x, $y, $d, $d, 180, 90)
  $p.AddArc(($x + $w - $d), $y, $d, $d, 270, 90)
  $p.AddArc(($x + $w - $d), ($y + $h - $d), $d, $d, 0, 90)
  $p.AddArc($x, ($y + $h - $d), $d, $d, 90, 90)
  $p.CloseFigure()
  return $p
}

# Accent palette (aurora): violet -> blue -> cyan
$violet = [Drawing.Color]::FromArgb(255, 124, 92, 255)
$cyan = [Drawing.Color]::FromArgb(255, 34, 211, 238)
$white = [Drawing.Color]::FromArgb(255, 244, 245, 250)
$dim = [Drawing.Color]::FromArgb(255, 150, 156, 180)

function Draw-LogoTile($g, [int]$x, [int]$y, [int]$size) {
  $tile = Rounded-Rect $x $y $size $size ([int]($size * 0.28))
  $rect = New-Object Drawing.Rectangle $x, $y, $size, $size
  $lg = New-Object Drawing.Drawing2D.LinearGradientBrush $rect, $violet, $cyan, 135
  $g.FillPath($lg, $tile)
  $lg.Dispose()
  if (Test-Path $iconPng) {
    $img = [Drawing.Image]::FromFile((Resolve-Path $iconPng))
    $pad = [int]($size * 0.16)
    $g.SetClip($tile)
    $g.DrawImage($img, ($x + $pad), ($y + $pad), ($size - 2 * $pad), ($size - 2 * $pad))
    $g.ResetClip()
    $img.Dispose()
  }
  $tile.Dispose()
}

# ---------------- Sidebar (164 x 314) : welcome / finish pages ----------------
$res = New-Tile 164 314
$bmp = $res[0]; $g = $res[1]
Fill-Background $g 164 314
Add-Glow $g 20 36 150 ([Drawing.Color]::FromArgb(120, $violet))
Add-Glow $g 150 300 170 ([Drawing.Color]::FromArgb(110, $cyan))

# faint vertical accent line
$pen = New-Object Drawing.Pen ([Drawing.Color]::FromArgb(40, 255, 255, 255)), 1
$g.DrawLine($pen, 0, 0, 0, 314); $pen.Dispose()

Draw-LogoTile $g 50 56 64

$fBrand = New-Object Drawing.Font 'Segoe UI Semibold', 19, ([Drawing.FontStyle]::Bold)
$fVer = New-Object Drawing.Font 'Segoe UI Semibold', 9, ([Drawing.FontStyle]::Bold)
$fTag = New-Object Drawing.Font 'Segoe UI', 8
$bWhite = New-Object Drawing.SolidBrush $white
$bDim = New-Object Drawing.SolidBrush $dim
$bAcc = New-Object Drawing.SolidBrush $cyan
$sf = New-Object Drawing.StringFormat
$sf.Alignment = 'Center'

$g.DrawString('TRACKER', $fBrand, $bWhite, (New-Object Drawing.RectangleF 0, 150, 164, 30), $sf)

# version pill
$pillW = 44; $pillX = (164 - $pillW) / 2
$pill = Rounded-Rect ([int]$pillX) 184 $pillW 18 9
$pillBrush = New-Object Drawing.SolidBrush ([Drawing.Color]::FromArgb(38, 34, 211, 238))
$g.FillPath($pillBrush, $pill); $pillBrush.Dispose()
$g.DrawString('v3.0', $fVer, $bAcc, (New-Object Drawing.RectangleF 0, 186, 164, 16), $sf)

$g.DrawString('Play & app analytics', $fTag, $bDim, (New-Object Drawing.RectangleF 0, 280, 164, 16), $sf)

$g.Dispose()
$bmp.Save((Join-Path $here 'sidebar.bmp'), [Drawing.Imaging.ImageFormat]::Bmp)
$bmp.Dispose()

# ---------------- Header (150 x 57) : top strip on inner pages ----------------
$res = New-Tile 150 57
$bmp = $res[0]; $g = $res[1]
Fill-Background $g 150 57
Add-Glow $g 135 10 90 ([Drawing.Color]::FromArgb(90, $cyan))
Draw-LogoTile $g 10 11 34

$fH = New-Object Drawing.Font 'Segoe UI Semibold', 11, ([Drawing.FontStyle]::Bold)
$fHV = New-Object Drawing.Font 'Segoe UI Semibold', 7, ([Drawing.FontStyle]::Bold)
$g.DrawString('TRACKER', $fH, $bWhite, 52, 12)
$g.DrawString('v3.0', $fHV, $bAcc, 54, 33)

$g.Dispose()
$bmp.Save((Join-Path $here 'header.bmp'), [Drawing.Imaging.ImageFormat]::Bmp)
$bmp.Dispose()

Write-Output 'Installer art written: sidebar.bmp, header.bmp'
