# Start all services and wait for readiness
param(
  [int]$TimeoutSeconds = 180
)

# Run from the repo root regardless of where the script is invoked from
# (it lives in scripts/, repo root is one level up).
Set-Location (Join-Path $PSScriptRoot '..')

Write-Host 'Bringing up containers (build if needed)...'
docker.exe compose up --build -d

# auth-service listens on HTTPS by default (see compose: AUTH_USE_HTTPS=true).
# Mirror that here, and skip cert validation for the self-signed localhost pair.
$authScheme = if ($env:AUTH_USE_HTTPS -and $env:AUTH_USE_HTTPS -ne 'true') { 'http' } else { 'https' }
$targets = @(
  "http://localhost:4010/health",
  "${authScheme}://localhost:4020/health",
  "http://localhost:4001/health"
)
$start = Get-Date

foreach ($t in $targets) {
  Write-Host "Waiting for $t ..."
  $ok = $false
  while (-not $ok) {
    try {
      # -SkipCertificateCheck for the self-signed localhost cert on auth-service.
      $r = Invoke-RestMethod -Uri $t -Method Get -TimeoutSec 5 -SkipCertificateCheck
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
