@echo off
setlocal EnableExtensions EnableDelayedExpansion

set "ROOT=%~dp0.."
set "PORT=8080"

call :LoadEnv "%ROOT%\.env"

echo Stopping JMeter Agent services...

set "STOPPED=0"

call :StopPort %PORT% "Backend"
call :StopPort 5173 "Frontend dev server"

rem Close helper windows started by start-services.bat
taskkill /FI "WINDOWTITLE eq JMeter Agent Backend*" /F >nul 2>&1
taskkill /FI "WINDOWTITLE eq JMeter Agent Frontend*" /F >nul 2>&1

if "%STOPPED%"=="0" (
  echo No running services found on ports %PORT% or 5173.
) else (
  echo Done.
)

exit /b 0

:LoadEnv
set "ENV_FILE=%~1"
if not exist "%ENV_FILE%" exit /b 0
for /f "usebackq eol=# tokens=1,* delims==" %%a in ("%ENV_FILE%") do (
  set "KEY=%%a"
  set "VAL=%%b"
  if defined VAL (
    if "!VAL:~0,1!"==" " set "VAL=!VAL:~1!"
  )
  if /I "!KEY!"=="PORT" set "PORT=!VAL!"
)
exit /b 0

:StopPort
set "TARGET_PORT=%~1"
set "LABEL=%~2"
for /f "tokens=5" %%p in ('netstat -aon ^| findstr ":%TARGET_PORT%" ^| findstr "LISTENING"') do (
  if not "%%p"=="0" (
    echo Stopping %LABEL% ^(PID %%p, port %TARGET_PORT%^)...
    taskkill /F /PID %%p >nul 2>&1
    set "STOPPED=1"
  )
)
exit /b 0
