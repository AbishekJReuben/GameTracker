@echo off
REM Windows entry for the pre-commit hook. Git for Windows prefers this over a
REM shebang script when `.githooks/pre-commit` (no extension) is absent — that
REM avoids routing through WSL's bash.exe stub when no distro is installed.
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0pre-commit.ps1" %*
exit /b %ERRORLEVEL%
