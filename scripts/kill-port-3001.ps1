# Frees port 3001 when a previous `npm run dev:backend` was killed without
# releasing it — Windows keeps the listener alive and the next start fails with
# EADDRINUSE. Was an untitled `frontend/txt.tx` sitting in the client workspace.
#
#   powershell -ExecutionPolicy Bypass -File scripts/kill-port-3001.ps1
param([int]$Port = 3001)

$procIds = Get-NetTCPConnection -LocalPort $Port -ErrorAction SilentlyContinue |
  Select-Object -ExpandProperty OwningProcess -Unique

if (-not $procIds) { Write-Host "Nothing is listening on port $Port."; exit 0 }
foreach ($procId in $procIds) {
  Stop-Process -Id $procId -Force
  Write-Host "Stopped process $procId, which held port $Port."
}
