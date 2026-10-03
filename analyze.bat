@echo off
chcp 65001 >nul
cd /d "%~dp0"
if "%~1"=="" (
  echo 用法: 把 xxx.bundle.json 拖到本 bat 上，或:
  echo   analyze.bat "路径\xxx.bundle.json"
  exit /b 1
)
python run.py %*
pause
