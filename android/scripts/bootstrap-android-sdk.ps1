# bootstrap-android-sdk.ps1
# 为什么存在：本机（以及大多数 CI/新克隆）没有 Android SDK，无法产出 APK。
# 这个脚本把「装 SDK」变成一条可重复执行的命令，命令行工具版本固定（可复现）。
#
# 用法：
#   pwsh -File android/scripts/bootstrap-android-sdk.ps1
#   pwsh -File android/scripts/bootstrap-android-sdk.ps1 -SdkRoot D:\android-sdk
#
# 装完会打印要设置的环境变量；android/local.properties 由 build-apk.ps1 自动写入。

[CmdletBinding()]
param(
  # 默认装在仓库外，避免把 ~1GB 的 SDK 混进 git 工作区
  [string]$SdkRoot = "F:\android-sdk",
  # 固定版本：命令行工具的 zip 名带 build 号，必须钉住才能复现
  [string]$CmdlineToolsUrl = "https://dl.google.com/android/repository/commandlinetools-win-11076708_latest.zip",
  [string]$Platform = "android-35",
  [string]$BuildTools = "35.0.0"
)

$ErrorActionPreference = "Stop"

Write-Host "== McLink Android SDK bootstrap ==" -ForegroundColor Cyan
Write-Host "SDK root : $SdkRoot"
Write-Host "Platform : $Platform"
Write-Host "BuildTools: $BuildTools"

# --- 前置检查：sdkmanager 需要 JDK（不只是 JRE） -------------------------------
$java = Get-Command java -ErrorAction SilentlyContinue
if (-not $java) { throw "找不到 java。请先装 JDK 17/21（推荐 Temurin 21），并把它加到 PATH。" }
$javac = Get-Command javac -ErrorAction SilentlyContinue
if (-not $javac) { throw "找得到 java 但找不到 javac —— 现在装的是 JRE，Android 构建需要完整 JDK。" }
Write-Host "JDK      : $($javac.Source)" -ForegroundColor Green

# --- 1. 下载命令行工具 ---------------------------------------------------------
$dlDir = Join-Path $SdkRoot "_download"
New-Item -ItemType Directory -Force -Path $dlDir | Out-Null
$zipPath = Join-Path $dlDir "cmdline-tools.zip"

if (-not (Test-Path $zipPath) -or (Get-Item $zipPath).Length -lt 100MB) {
  Write-Host "下载 cmdline-tools ..." -ForegroundColor Yellow
  # curl.exe 比 Invoke-WebRequest 快很多，且 Windows 10+ 自带
  & curl.exe -L --fail --retry 3 --retry-delay 2 -o $zipPath $CmdlineToolsUrl
  if ($LASTEXITCODE -ne 0) { throw "下载 cmdline-tools 失败（exit $LASTEXITCODE）" }
} else {
  Write-Host "cmdline-tools zip 已存在，跳过下载" -ForegroundColor Green
}

# --- 2. 解压到 <sdk>/cmdline-tools/latest -------------------------------------
# sdkmanager 只认 <sdk>/cmdline-tools/latest/bin 这个确切布局，zip 里却是 cmdline-tools/
$latest = Join-Path $SdkRoot "cmdline-tools\latest"
if (-not (Test-Path (Join-Path $latest "bin\sdkmanager.bat"))) {
  Write-Host "解压 cmdline-tools ..." -ForegroundColor Yellow
  $tmp = Join-Path $dlDir "extract"
  if (Test-Path $tmp) { Remove-Item -Recurse -Force $tmp }
  Expand-Archive -Path $zipPath -DestinationPath $tmp -Force
  New-Item -ItemType Directory -Force -Path (Split-Path $latest) | Out-Null
  if (Test-Path $latest) { Remove-Item -Recurse -Force $latest }
  Move-Item (Join-Path $tmp "cmdline-tools") $latest
  Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}

$sdkmanager = Join-Path $latest "bin\sdkmanager.bat"
if (-not (Test-Path $sdkmanager)) { throw "sdkmanager 不在预期位置：$sdkmanager" }
Write-Host "sdkmanager: $sdkmanager" -ForegroundColor Green

# --- 3. 接受许可 + 安装必需组件 ------------------------------------------------
# 为什么先 yes：sdkmanager 交互式问许可，无人值守必须把 y 灌进去
Write-Host "接受许可协议 ..." -ForegroundColor Yellow
$yes = (1..60 | ForEach-Object { "y" }) -join "`n"
$yes | & $sdkmanager --sdk_root="$SdkRoot" --licenses | Out-Null

Write-Host "安装 platform-tools / $Platform / build-tools;$BuildTools ..." -ForegroundColor Yellow
& $sdkmanager --sdk_root="$SdkRoot" "platform-tools" "platforms;$Platform" "build-tools;$BuildTools"
if ($LASTEXITCODE -ne 0) { throw "sdkmanager 安装组件失败（exit $LASTEXITCODE）" }

# --- 4. 汇报 ------------------------------------------------------------------
Write-Host ""
Write-Host "== 完成 ==" -ForegroundColor Green
Write-Host "adb: $SdkRoot\platform-tools\adb.exe"
Write-Host ""
Write-Host "把下面两行加到用户环境变量（或每次构建前设置）：" -ForegroundColor Cyan
Write-Host "  `$env:ANDROID_HOME = `"$SdkRoot`""
Write-Host "  `$env:ANDROID_SDK_ROOT = `"$SdkRoot`""
