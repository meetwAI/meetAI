# Start all services and wait for readiness
param(
  [int]$TimeoutSeconds = 180
)

# Run from the repo root regardless of where the script is invoked from
# (it lives in scripts/, repo root is one level up).
Set-Location (Join-Path $PSScriptRoot '..')

$ComposeFile = 'infra/docker/docker-compose.yml'

Write-Host 'Bringing up containers (build if needed)...'
docker.exe compose -f $ComposeFile up --build -d

# auth-service listens on HTTPS by default (see compose: AUTH_USE_HTTPS=true).
# Mirror that here, and skip cert validation for the self-signed 0.0.0.0 pair.
$authScheme = if ($env:AUTH_USE_HTTPS -and $env:AUTH_USE_HTTPS -ne 'true') { 'http' } else { 'https' }
$targets = @(
  "http://0.0.0.0:4010/health",
  "${authScheme}://0.0.0.0:4020/health",
  "http://0.0.0.0:4001/health"
)
$start = Get-Date

foreach ($t in $targets) {
  Write-Host "Waiting for $t ..."
  $ok = $false
  while (-not $ok) {
    try {
      # -SkipCertificateCheck for the self-signed 0.0.0.0 cert on auth-service.
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
Write-Host 'Frontend:' 'https://0.0.0.0:5173'
Write-Host 'Gateway:' 'http://0.0.0.0:4010'
Write-Host 'Auth:' 'http://0.0.0.0:4020'
Write-Host 'Meeting:' 'http://0.0.0.0:4001'
