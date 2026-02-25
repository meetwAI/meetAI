# Start all services and wait for readiness
param(
  [int]$TimeoutSeconds = 180
)

Write-Host 'Bringing up containers (build if needed)...'
docker.exe compose up --build -d

$targets = @("http://localhost:4010/health","http://localhost:4020/health","http://localhost:4001/health")
$start = Get-Date

foreach ($t in $targets) {
  Write-Host "Waiting for $t ..."
  $ok = $false
  while (-not $ok) {
    try {
      $r = Invoke-RestMethod -Uri $t -Method Get -TimeoutSec 5
      if ($r -and ($r.status -eq 'ok' -or $r.Status -eq 'ok')) { $ok = $true; break }
      $ok = $true
    } catch {
      # ignore and retry
    }
    if ((Get-Date) - $start -gt [TimeSpan]::FromSeconds($TimeoutSeconds)) {
      Write-Error "Timed out waiting for $t"
      exit 1
    }
    Start-Sleep -Seconds 2
  }
  Write-Host "$t is ready"
}

Write-Host 'All services appear ready.'
Write-Host 'Frontend:' 'http://localhost:5173'
Write-Host 'Gateway:' 'http://localhost:4010'
Write-Host 'Auth:' 'http://localhost:4020'
Write-Host 'Meeting:' 'http://localhost:4001'
