param(
  [Parameter(Mandatory=$true)][string]$Pptx,
  [Parameter(Mandatory=$true)][string]$Pdf
)
$ErrorActionPreference = "Stop"
$Pptx = (Resolve-Path $Pptx).Path

# Attach to a running PowerPoint when present and never quit it (see export_pptx.ps1).
$owned = $false
try {
  $ppt = [System.Runtime.InteropServices.Marshal]::GetActiveObject("PowerPoint.Application")
} catch {
  $ppt = New-Object -ComObject PowerPoint.Application
  $owned = $true
}
try {
  $pres = $ppt.Presentations.Open($Pptx, $true, $false, $false)  # ReadOnly, Untitled, WithoutWindow
  $pres.SaveAs($Pdf, 32)   # 32 = ppSaveAsPDF
  $pres.Close()
  Write-Output ("wrote " + $Pdf)
} finally {
  if ($owned -and $ppt.Presentations.Count -eq 0) { $ppt.Quit() }
  [System.Runtime.Interopservices.Marshal]::ReleaseComObject($ppt) | Out-Null
}
