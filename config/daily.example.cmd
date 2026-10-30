@echo off
setlocal

rem 複製為 daily.local.cmd 後調整；此檔不可放任何 Access Key 或 Secret。
set "AWS_PROFILE=ops-toolkit-readonly"
set "AWS_SHARED_CREDENTIALS_FILE=C:\Users\your-name\.aws\credentials"
set "AWS_CONFIG_FILE=C:\Users\your-name\.aws\config"
set "SSH_CONFIG=C:\Users\your-name\.ssh\config"
set "SSH_COMMAND=C:\Program Files\Git\usr\bin\ssh.exe"

cd /d "%~dp0.."
"C:\Program Files\nodejs\node.exe" bin\ops-audit.mjs daily example-wp-staging 14
exit /b %ERRORLEVEL%
