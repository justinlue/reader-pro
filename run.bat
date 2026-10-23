@echo off
rem Starts Reader. Pass a .txt path to open it: run.bat "D:\Books\novel.txt"
rem Stays in the caller's directory so relative book paths resolve correctly.
if not exist "%~dp0node_modules\electron\dist\electron.exe" (
  echo Installing dependencies...
  pushd "%~dp0"
  call npm install
  if not exist node_modules\electron\dist\electron.exe node node_modules\electron\install.js
  popd
)
start "" "%~dp0node_modules\electron\dist\electron.exe" "%~dp0." %*
