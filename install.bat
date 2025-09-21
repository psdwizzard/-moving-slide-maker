@echo off
setlocal
cd /d "%~dp0"

echo Installing dependencies for Ken Burns Studio...
call npm install
if errorlevel 1 (
  echo.
  echo npm install failed. See output above for details.
  exit /b %errorlevel%
)

echo.
echo Dependencies installed successfully.
echo You can now run start-app.bat or npm start to launch the app.

endlocal

