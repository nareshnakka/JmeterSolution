#Requires -Version 5.1
<#
.SYNOPSIS
  Verify Azure Monitor credentials from JMeter Agent .env (no secrets printed).

.DESCRIPTION
  Reads AZURE_TENANT_ID, AZURE_CLIENT_ID, AZURE_CLIENT_SECRET, AZURE_SUBSCRIPTION_ID
  from the project-root .env (or backend\.env), then:
    1) Obtains an Azure AD access token (client credentials)
    2) Optionally calls Azure Monitor Metrics for a VM resource ID

.EXAMPLE
  .\scripts\verify-azure-monitor.ps1

.EXAMPLE
  .\scripts\verify-azure-monitor.ps1 -ResourceId "/subscriptions/.../virtualMachines/PQSQCVAL2022N01"
#>

[CmdletBinding()]
param(
  [string]$EnvFile = "",
  [string]$ResourceId = "",
  [string]$ResourceGroup = "",
  [string]$VmName = ""
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
if (-not $EnvFile) {
  $rootEnv = Join-Path $Root ".env"
  $backendEnv = Join-Path $Root "backend\.env"
  if (Test-Path $rootEnv) { $EnvFile = $rootEnv }
  elseif (Test-Path $backendEnv) { $EnvFile = $backendEnv }
  else {
    Write-Host "ERROR: No .env found at:" -ForegroundColor Red
    Write-Host "  $rootEnv"
    Write-Host "  $backendEnv"
    exit 1
  }
}

function Read-DotEnv {
  param([string]$Path)
  $map = @{}
  Get-Content -LiteralPath $Path -Encoding UTF8 | ForEach-Object {
    $line = $_.Trim()
    if (-not $line -or $line.StartsWith("#")) { return }
    $idx = $line.IndexOf("=")
    if ($idx -lt 1) { return }
    $key = $line.Substring(0, $idx).Trim()
    $val = $line.Substring($idx + 1).Trim()
    if (($val.StartsWith('"') -and $val.EndsWith('"')) -or ($val.StartsWith("'") -and $val.EndsWith("'"))) {
      $val = $val.Substring(1, $val.Length - 2)
    }
    $map[$key] = $val
  }
  return $map
}

function Mask-Value([string]$v) {
  if ([string]::IsNullOrWhiteSpace($v)) { return "EMPTY" }
  if ($v.Length -le 8) { return "SET (len=$($v.Length))" }
  return "SET (len=$($v.Length), ends-with ...$($v.Substring($v.Length - 4)))"
}

Write-Host "========================================"
Write-Host " Azure Monitor credential check"
Write-Host "========================================"
Write-Host "Env file: $EnvFile"
Write-Host ""

$envMap = Read-DotEnv -Path $EnvFile
$tenant = $envMap["AZURE_TENANT_ID"]
$clientId = $envMap["AZURE_CLIENT_ID"]
$secret = $envMap["AZURE_CLIENT_SECRET"]
$subId = $envMap["AZURE_SUBSCRIPTION_ID"]
$authMode = if ($envMap["AZURE_AUTH_MODE"]) { $envMap["AZURE_AUTH_MODE"].Trim().ToLowerInvariant() } else { "client_secret" }
if ($authMode -in @("cli", "azure_cli", "default")) { $authMode = "cli" } else { $authMode = "client_secret" }

Write-Host "AZURE_AUTH_MODE        : $authMode"
Write-Host "AZURE_TENANT_ID        : $(Mask-Value $tenant)"
Write-Host "AZURE_CLIENT_ID        : $(Mask-Value $clientId)"
Write-Host "AZURE_CLIENT_SECRET    : $(Mask-Value $secret)"
Write-Host "AZURE_SUBSCRIPTION_ID  : $(Mask-Value $subId)"
Write-Host ""

if ([string]::IsNullOrWhiteSpace($subId)) {
  Write-Host "FAIL: AZURE_SUBSCRIPTION_ID is missing." -ForegroundColor Red
  exit 1
}

$accessToken = $null
$expiresIn = $null

if ($authMode -eq "cli") {
  Write-Host "[1/3] Getting token via Azure CLI (az account get-access-token) ..."
  try {
    $azJson = az account get-access-token --resource https://management.azure.com -o json 2>&1
    if ($LASTEXITCODE -ne 0) { throw "$azJson" }
    $azTok = $azJson | ConvertFrom-Json
    $accessToken = $azTok.accessToken
    Write-Host "OK: Token from Azure CLI (user/session auth)" -ForegroundColor Green
  } catch {
    Write-Host "FAIL: Azure CLI token failed. Run: az login" -ForegroundColor Red
    Write-Host $_
    exit 1
  }
} else {
  $missing = @()
  if ([string]::IsNullOrWhiteSpace($tenant)) { $missing += "AZURE_TENANT_ID" }
  if ([string]::IsNullOrWhiteSpace($clientId)) { $missing += "AZURE_CLIENT_ID" }
  if ([string]::IsNullOrWhiteSpace($secret)) { $missing += "AZURE_CLIENT_SECRET" }
  if ($missing.Count -gt 0) {
    Write-Host "FAIL: Missing keys: $($missing -join ', ')" -ForegroundColor Red
    Write-Host "Or set AZURE_AUTH_MODE=cli and run az login (no app IAM needed)."
    exit 1
  }

  Write-Host "[1/3] Requesting access token from login.microsoftonline.com ..."
  $tokenBody = @{
    grant_type    = "client_credentials"
    client_id     = $clientId
    client_secret = $secret
    scope         = "https://management.azure.com/.default"
  }

  try {
    $tokenResp = Invoke-RestMethod `
      -Method Post `
      -Uri "https://login.microsoftonline.com/$tenant/oauth2/v2.0/token" `
      -ContentType "application/x-www-form-urlencoded" `
      -Body $tokenBody
  } catch {
    Write-Host "FAIL: Token request failed." -ForegroundColor Red
    Write-Host $_.Exception.Message
    if ($_.ErrorDetails -and $_.ErrorDetails.Message) {
      Write-Host $_.ErrorDetails.Message
    }
    exit 1
  }

  if (-not $tokenResp.access_token) {
    Write-Host "FAIL: No access_token in response." -ForegroundColor Red
    exit 1
  }
  $accessToken = $tokenResp.access_token
  $expiresIn = $tokenResp.expires_in
  Write-Host "OK: Access token received (expires_in=${expiresIn}s)" -ForegroundColor Green
}

Write-Host ""
Write-Host "[2/3] Checking subscription access ..."
$headers = @{ Authorization = "Bearer $accessToken" }
try {
  $sub = Invoke-RestMethod `
    -Method Get `
    -Uri "https://management.azure.com/subscriptions/$subId`?api-version=2020-01-01" `
    -Headers $headers
  Write-Host "OK: Subscription visible: $($sub.displayName) [$($sub.subscriptionId)]" -ForegroundColor Green
} catch {
  Write-Host "FAIL: Cannot read subscription $subId" -ForegroundColor Red
  Write-Host $_.Exception.Message
  if ($_.ErrorDetails -and $_.ErrorDetails.Message) {
    Write-Host $_.ErrorDetails.Message
  }
  Write-Host ""
  Write-Host "Common causes:"
  Write-Host "  - Wrong AZURE_SUBSCRIPTION_ID"
  Write-Host "  - App lacks Reader / Monitoring Reader on the subscription or RG"
  exit 1
}

# Build resource id if RG + VM name given
if (-not $ResourceId -and $ResourceGroup -and $VmName) {
  $ResourceId = "/subscriptions/$subId/resourceGroups/$ResourceGroup/providers/Microsoft.Compute/virtualMachines/$VmName"
}

if (-not $ResourceId) {
  Write-Host ""
  Write-Host "[3/3] Skipping VM metrics probe (no -ResourceId / -ResourceGroup+-VmName)." -ForegroundColor Yellow
  Write-Host "Credentials look valid. To also test CPU metrics, run:"
  Write-Host "  .\scripts\verify-azure-monitor.ps1 -ResourceGroup 'YOUR_RG' -VmName 'PQSQCVAL2022N01'"
  Write-Host "or:"
  Write-Host "  .\scripts\verify-azure-monitor.ps1 -ResourceId '/subscriptions/.../virtualMachines/NAME'"
  Write-Host ""
  Write-Host "PASS: Azure credentials are correct." -ForegroundColor Green
  exit 0
}

Write-Host ""
Write-Host "[3/3] Probing Percentage CPU for:"
Write-Host "  $ResourceId"

$end = (Get-Date).ToUniversalTime()
$start = $end.AddMinutes(-15)
$timespan = "{0:yyyy-MM-ddTHH:mm:ssZ}/{1:yyyy-MM-ddTHH:mm:ssZ}" -f $start, $end
$metricUrl = "https://management.azure.com$ResourceId/providers/Microsoft.Insights/metrics" +
  "?api-version=2023-10-01" +
  "&metricnames=Percentage%20CPU" +
  "&aggregation=Average" +
  "&interval=PT1M" +
  "&timespan=$([uri]::EscapeDataString($timespan))"

try {
  $metrics = Invoke-RestMethod -Method Get -Uri $metricUrl -Headers $headers
  $points = @()
  if ($metrics.value -and $metrics.value[0].timeseries -and $metrics.value[0].timeseries[0].data) {
    $points = $metrics.value[0].timeseries[0].data | Where-Object { $null -ne $_.average }
  }
  if ($points.Count -eq 0) {
    Write-Host "WARN: Metrics API OK but no Percentage CPU points in last 15 minutes." -ForegroundColor Yellow
    Write-Host "      VM may be deallocated, or diagnostics not emitting yet."
  } else {
    $last = $points[-1].average
    Write-Host ("OK: Latest Percentage CPU average ~= {0:N1}%" -f [double]$last) -ForegroundColor Green
  }
} catch {
  Write-Host "FAIL: Metrics call failed." -ForegroundColor Red
  Write-Host $_.Exception.Message
  if ($_.ErrorDetails -and $_.ErrorDetails.Message) {
    Write-Host $_.ErrorDetails.Message
  }
  Write-Host ""
  Write-Host "Common causes:"
  Write-Host "  - Wrong resource ID / resource group / VM name"
  Write-Host "  - App missing Monitoring Reader on that resource group"
  exit 1
}

Write-Host ""
Write-Host "PASS: Azure credentials and metrics access look correct." -ForegroundColor Green
exit 0
