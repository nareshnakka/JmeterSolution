@echo off
set ROOT=%~dp0..
cd /d %ROOT%\backend

if not exist venv (
  python -m venv venv
  call venv\Scripts\activate.bat
  pip install -r requirements.txt
) else (
  call venv\Scripts\activate.bat
)

if exist ..\.env (
  copy /Y ..\.env .env >nul 2>&1
)

echo Starting JMeter Agent Server on http://localhost:8080
uvicorn app.main:app --host 0.0.0.0 --port 8080
