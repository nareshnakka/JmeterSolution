# PowerShell script to install JMeter Agent as a Windows service using NSSM
# Download NSSM from https://nssm.cc/download and add to PATH first.

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$Backend = Join-Path $Root "backend"
$VenvPython = Join-Path $Backend "venv\Scripts\python.exe"
$EnvFile = Join-Path $Root ".env"

if (-not (Test-Path $VenvPython)) {
    Write-Host "Create venv first: cd backend; python -m venv venv; .\venv\Scripts\pip install -r requirements.txt"
    exit 1
}

$ServiceName = "JMeterAgent"
$AppParams = "-m uvicorn app.main:app --host 0.0.0.0 --port 8080 --timeout-keep-alive 75"

nssm install $ServiceName $VenvPython $AppParams
nssm set $ServiceName AppDirectory $Backend
nssm set $ServiceName AppEnvironmentExtra "PYTHONPATH=$Backend"
nssm set $ServiceName DisplayName "JMeter Agent Server"
nssm set $ServiceName Description "Lightweight JMeter test management and execution server"
nssm set $ServiceName Start SERVICE_AUTO_START

Write-Host "Service installed. Start with: nssm start $ServiceName"
