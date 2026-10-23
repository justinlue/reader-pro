@echo off
rem Starts Reader. Pass a .txt path to open it: run.bat "D:\Books\novel.txt"
cd /d "%~dp0"
if not exist node_modules\electron (
  echo Installing dependencies...
  call npm install || exit /b 1
)
start "" "%~dp0node_modules\electron\dist\electron.exe" "%~dp0." %*
