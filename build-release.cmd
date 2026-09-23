@echo off
rem mdreader 一键打包：前端 → 桌面壳 → Inno Setup 安装程序
setlocal
cd /d "%~dp0"

set "ISCC="
if exist "D:\Program Files\Inno Setup 7\ISCC.exe" set "ISCC=D:\Program Files\Inno Setup 7\ISCC.exe"
if exist "C:\Program Files (x86)\Inno Setup 6\ISCC.exe" set "ISCC=C:\Program Files (x86)\Inno Setup 6\ISCC.exe"
if exist "C:\Program Files (x86)\Inno Setup 7\ISCC.exe" set "ISCC=C:\Program Files (x86)\Inno Setup 7\ISCC.exe"

if "%ISCC%"=="" (
  echo [错误] 没有找到 ISCC.exe，请修改本脚本里的路径。
  exit /b 1
)

echo.
echo [1/4] 构建前端...
call npm run build
if errorlevel 1 exit /b 1

echo.
echo [2/4] 发布桌面程序（self-contained win-x64）...
pushd desktop
dotnet publish -c Release -r win-x64 --self-contained true -o publish
if errorlevel 1 (popd & exit /b 1)
popd

echo.
echo [3/4] 编译安装程序...
"%ISCC%" "installer\mdreader.iss"
if errorlevel 1 exit /b 1

echo.
echo [4/4] 完成。安装包位于 release\ 目录：
dir /b release\*.exe
endlocal
