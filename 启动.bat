@echo off
chcp 936 >nul
title 普洱茶直播工作台
cd /d "%~dp0"

echo.
echo   普洱茶直播工作台
echo   ----------------
echo   正在启动本地服务...
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo   [错误] 没找到 node，请先安装 Node.js 20 或更高版本。
  echo.
  pause
  exit /b 1
)

echo   启动后浏览器会自动打开 http://127.0.0.1:8788
echo   关闭这个窗口即可停止服务。
echo.

start "" http://127.0.0.1:8788
node server/index.mjs 8788

echo.
echo   服务已停止。
pause
