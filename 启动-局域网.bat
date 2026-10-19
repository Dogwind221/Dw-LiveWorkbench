@echo off
chcp 936 >nul
title 普洱茶直播工作台（局域网模式）
cd /d "%~dp0"

echo.
echo   普洱茶直播工作台 —— 局域网模式
echo   ---------------------------------
echo   让手机 / 别的电脑 也能访问
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo   [错误] 没找到 node，请先安装 Node.js 20 或更高版本
  echo.
  pause
  exit /b 1
)

echo   安全提醒：局域网模式 + 未开认证时，同一 WiFi 下任何人都能改你的数据。
echo   只是自己用手机演示没问题；给别人看之前建议先建账号（见 README 第一章）。
echo.
echo   启动后请看这个窗口里列出的地址，
echo   "192.168 开头"的那个通常就是手机应该输的网址。
echo.

start "" http://127.0.0.1:8788

set HOST=0.0.0.0
node server/index.mjs 8788

echo.
echo   服务已停止。
pause