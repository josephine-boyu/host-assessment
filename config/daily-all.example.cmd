@echo off
setlocal

rem Copy to daily-all.local.cmd and adjust local paths. Never put access keys or secrets here.
set "AWS_SHARED_CREDENTIALS_FILE=C:\Users\your-name\.aws\credentials"
set "AWS_CONFIG_FILE=C:\Users\your-name\.aws\config"
set "SSH_CONFIG=C:\Users\your-name\.ssh\config"
set "SSH_COMMAND=C:\Program Files\Git\usr\bin\ssh.exe"
set "OPS_TOOLKIT_DIR=%~dp0.."
set "NODE_EXE=C:\Program Files\nodejs\node.exe"

if not exist "%NODE_EXE%" (echo [ERROR] Node.js not found: %NODE_EXE% & exit /b 2)
if not exist "%OPS_TOOLKIT_DIR%\config\projects.local.json" (echo [ERROR] projects.local.json not found & exit /b 2)
if not exist "%SSH_CONFIG%" (echo [ERROR] SSH_CONFIG not found: %SSH_CONFIG% & exit /b 2)
if not exist "%SSH_COMMAND%" (echo [ERROR] SSH_COMMAND not found: %SSH_COMMAND% & exit /b 2)
if not exist "%AWS_SHARED_CREDENTIALS_FILE%" (echo [ERROR] AWS credentials file not found & exit /b 2)
if not exist "%AWS_CONFIG_FILE%" (echo [ERROR] AWS config file not found & exit /b 2)

cd /d "%OPS_TOOLKIT_DIR%"
if "%~1"=="" goto run_all
"%NODE_EXE%" bin\ops-audit.mjs daily-all --project "%~1"
exit /b %ERRORLEVEL%

:run_all
"%NODE_EXE%" bin\ops-audit.mjs daily-all
exit /b %ERRORLEVEL%
