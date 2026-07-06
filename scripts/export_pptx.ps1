param(
  [Parameter(Mandatory=$true)][string]$Pptx,
  [Parameter(Mandatory=$true)][string]$OutDir,
  [int]$Width = 1280,
  [int]$Height = 720
)
$ErrorActionPreference = "Stop"
$Pptx = (Resolve-Path $Pptx).Path
if (-not (Test-Path $OutDir)) { New-Item -ItemType Directory -Force -Path $OutDir | Out-Null }
$OutDir = (Resolve-Path $OutDir).Path

# PowerPoint is single-instance: attach to the user's running instance when present and
# NEVER quit it (that would close their open decks). Only quit instances we created.
$owned = $false
try {
  $ppt = [System.Runtime.InteropServices.Marshal]::GetActiveObject("PowerPoint.Application")
} catch {
  $ppt = New-Object -ComObject PowerPoint.Application
  $owned = $true
}
try {
  $pres = $ppt.Presentations.Open($Pptx, $true, $false, $false)  # ReadOnly, Untitled, WithoutWindow
  $i = 1
  foreach ($slide in $pres.Slides) {
    $out = Join-Path $OutDir ("slide-{0:D2}.png" -f $i)
    $slide.Export($out, "PNG", $Width, $Height)
    $i++
  }
  $pres.Close()
  Write-Output ("exported " + ($i-1) + " slides to " + $OutDir)
} finally {
  if ($owned -and $ppt.Presentations.Count -eq 0) { $ppt.Quit() }
  [System.Runtime.Interopservices.Marshal]::ReleaseComObject($ppt) | Out-Null
}
