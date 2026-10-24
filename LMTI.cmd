@echo off
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -File "%~dp0scripts\setup-local-web.ps1"
if errorlevel 1 (
  echo LMTI setup could not complete. Check the trusted package and installed Node, Python and MSVC runtimes.
  echo Existing folders were preserved. No execution policy bypass or runtime installation was used.
  pause
)
