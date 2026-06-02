# Run this AFTER closing Cursor and stopping npm start.
# Deletes the old OneDrive copy (optional).

$old = "C:\Users\moham\OneDrive\Desktop\website\whatsapp tool"
$new = "C:\dev\whatsapp tool"

Stop-Process -Name node -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2

if (-not (Test-Path $new)) {
  Write-Error "New folder not found: $new"
  exit 1
}

if (Test-Path $old) {
  Write-Host "Removing old OneDrive folder..."
  Remove-Item -LiteralPath $old -Recurse -Force
  Write-Host "Removed: $old"
} else {
  Write-Host "Old folder already gone."
}

Write-Host ""
Write-Host "Use the project at: $new"
Write-Host "  cd `"$new`""
Write-Host "  npm start"
