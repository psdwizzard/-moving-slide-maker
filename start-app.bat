@echo off
setlocal
cd /d "%~dp0"
if not exist node_modules (
  echo Installing dependencies...
  call npm install
) else (
  echo Using existing node_modules
)
echo Starting Ken Burns Studio...
call npm start
endlocal