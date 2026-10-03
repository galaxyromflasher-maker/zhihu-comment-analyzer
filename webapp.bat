@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo 启动提示词工作台: http://127.0.0.1:8765
python webapp.py
pause
