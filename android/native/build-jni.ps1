# 从上游 EasyTier v2.6.4 交叉编译出 Android(arm64-v8a) 用的 JNI 原生库
#
# 用法（在仓库根执行）：
#   powershell -ExecutionPolicy Bypass -File android/native/build-jni.ps1
#   powershell -ExecutionPolicy Bypass -File android/native/build-jni.ps1 -Proxy http://127.0.0.1:7890
#
# 产物：android/android/app/src/main/jniLibs/arm64-v8a/libeasytier_android_jni.so
#
# ---------------------------------------------------------------------------
# 为什么是"自己编"而不是取官方现成的
# ---------------------------------------------------------------------------
# EasyTier 官方 v2.6.4 的 Release 里**没有** Android JNI 动态库（取证见
# android/native/README.md §1-§3：官方 APK 里只有 Tauri GUI 的 libapp_lib.so，
# 导出的是 Java_com_kkrainbow_easytier_*）。官方 Android 应用走的是 Tauri 的
# vpnservice 插件 + 它自己的 Kotlin 前台服务，不经过 easytier-android-jni。
#
# ---------------------------------------------------------------------------
# 这条链上的 6 个坑（都是本机实测踩出来的，改脚本前先读）
# ---------------------------------------------------------------------------
# 1. **宿主工具链用 GNU 而不是 MSVC**：本机没有 Visual Studio Build Tools，
#    所以 rustup 用 `stable-x86_64-pc-windows-gnu`。但 GNU 宿主编译
#    `windows-sys` 需要 MinGW 的 `dlltool.exe` —— 缺了会报
#    `error calling dlltool 'dlltool.exe': program not found`。
#    本机 MinGW 在 F:\mingw64（winget 的 winlibs 包），下面的 PATH 必须带上它。
# 2. **需要 protoc**：`prost-wkt-types` 的 build script 会找 `protoc`，
#    缺了报 `Could not find 'protoc'`。本机在 F:\protoc（官方 win64 zip）。
# 3. **需要 libclang**：`kcp-sys` 用 bindgen 生成绑定，缺了报
#    `Unable to find libclang`。NDK r27 不再自带 libclang.dll，
#    本机是 `pip install --target F:\libclang libclang` 从 PyPI wheel 里取的。
# 4. **⚠️ BINDGEN_EXTRA_CLANG_ARGS 里的路径必须用正斜杠**。
#    bindgen 用 `shlex::split` 解析这个变量，而 shlex **把反斜杠当转义符**：
#    `F:\android-sdk\...` 会变成 `F:android-sdk...`，于是 `-resource-dir`
#    指向一个不存在的目录，clang 连自己的内置头都找不到，报
#    `fatal error: 'stddef.h' file not found`。这个坑最难查 —— 报错像是
#    sysroot 没配好，实际是反斜杠被吃了。
# 5. **cargo-ndk 的 `-p` 是它自己的 `--platform`**，不是 cargo 的 `--package`；
#    传 `-p <包名>` 会让它 panic。同理 `--config` 也不认。要单编某个包就用
#    普通的 `cargo build`（带 CARGO_TARGET_*_LINKER）或者干脆全量编。
# 6. **github.com 可能不通**（本机实测：api/codeload/raw 都通，只有 github.com:443 超时）。
#    EasyTier 的 Cargo.lock 钉了 7 个 git 依赖全在 github.com 上，所以
#    必须走代理 + `CARGO_NET_GIT_FETCH_WITH_CLI=true`（用系统 git，走 http_proxy）。
#
# ---------------------------------------------------------------------------
# 与上游的两处清单改动（源码一行没动）
# ---------------------------------------------------------------------------
# 上游 v2.6.4 的 JNI crate 用 `unsafe extern "C"` 声明外部符号却不依赖 easytier-ffi，
# 编出来的库对外部符号没有 DT_NEEDED —— 运行时要么靠加载顺序碰运气，要么报
# `cannot locate symbol "set_tun_fd"`。这里把 ffi 改成静态链入（上游 main/2.7.0
# 后来也是这么做的），于是**只需要一个 .so**：
#   easytier-ffi/Cargo.toml        crate-type = ["cdylib", "rlib"]
#   easytier-android-jni/Cargo.toml  依赖 easytier-ffi = { path = "../easytier-ffi" }
# 这个改动由本脚本第 3 步自动施加（幂等）。

param(
    [string]$Proxy = 'http://127.0.0.1:7890',
    [string]$Tag = 'v2.6.4',
    [string]$RepoRoot = 'F:\mc',
    [string]$SrcDir = '',
    [string]$CargoHome = 'F:\cargo',
    [string]$RustupHome = 'F:\rustup',
    [string]$MinGW = 'F:\mingw64',
    [string]$ProtocDir = 'F:\protoc',
    [string]$LibClangDir = 'F:\libclang\clang\native',
    [switch]$SkipFetch
)

$ErrorActionPreference = 'Stop'
if (-not $SrcDir) { $SrcDir = Join-Path $RepoRoot ('.cache\src\EasyTier-' + $Tag) }
$JniLibs = Join-Path $RepoRoot 'android\android\app\src\main\jniLibs\arm64-v8a'

function Step($n, $msg) { Write-Host ("`n[" + $n + "] " + $msg) -ForegroundColor Cyan }
function Fail($msg) { Write-Host ("  ✗ " + $msg) -ForegroundColor Red; exit 1 }
function Ok($msg) { Write-Host ("  ✓ " + $msg) -ForegroundColor Green }

# ---------------------------------------------------------------- 0. 工具链自检
Step 0 '工具链自检'
foreach ($probe in @(
        @{ p = (Join-Path $MinGW 'bin\dlltool.exe'); what = 'MinGW dlltool（坑 1）' },
        @{ p = (Join-Path $ProtocDir 'bin\protoc.exe'); what = 'protoc（坑 2）' },
        @{ p = (Join-Path $LibClangDir 'libclang.dll'); what = 'libclang（坑 3）' },
        @{ p = (Join-Path $CargoHome 'bin\cargo.exe'); what = 'cargo' }
    )) {
    if (Test-Path $probe.p) { Ok ($probe.what + ' → ' + $probe.p) } else { Fail ($probe.what + ' 不在 ' + $probe.p + '（先装它，见脚本头部注释）') }
}
$ndkRoot = 'F:\android-sdk\ndk'
if (-not (Test-Path $ndkRoot)) { Fail ('找不到 NDK 目录 ' + $ndkRoot) }
$ndk = (Get-ChildItem $ndkRoot -Directory | Sort-Object Name -Descending | Select-Object -First 1).FullName
Ok ('NDK → ' + $ndk)

# 路径统一转成正斜杠：坑 4 说的就是这个
$llvm = ($ndk -replace '\\', '/') + '/toolchains/llvm/prebuilt/windows-x86_64'
$sysroot = $llvm + '/sysroot'
$resdir = $llvm + '/lib/clang/18'
if (-not (Test-Path ($resdir + '/include/stddef.h'))) { Fail ('NDK 的 clang 资源目录里没有 stddef.h：' + $resdir) }

# ---------------------------------------------------------------- 1. 环境变量
Step 1 '设置构建环境（代理 / 工具链 / bindgen 参数）'
$env:CARGO_HOME = $CargoHome
$env:RUSTUP_HOME = $RustupHome
$env:PATH = ((Join-Path $MinGW 'bin'), (Join-Path $ProtocDir 'bin'), (Join-Path $CargoHome 'bin')) -join ';' + ';' + $env:PATH
$env:PROTOC = Join-Path $ProtocDir 'bin\protoc.exe'
$env:LIBCLANG_PATH = $LibClangDir
$env:CLANG_PATH = ($llvm + '/bin/clang.exe') -replace '/', '\'
if ($Proxy) {
    $env:HTTP_PROXY = $Proxy; $env:HTTPS_PROXY = $Proxy; $env:ALL_PROXY = $Proxy
    # 坑 6：git 依赖在 github.com 上，必须让 cargo 用系统 git（它认 http_proxy）
    $env:CARGO_NET_GIT_FETCH_WITH_CLI = 'true'
}
$env:CARGO_HTTP_TIMEOUT = '180'
$env:ANDROID_NDK_HOME = $ndk
$env:ANDROID_NDK_ROOT = $ndk

# 坑 4：整串参数里**不能有反斜杠**
$bindgenArgs = '--target=aarch64-linux-android21 --sysroot=' + $sysroot + ' -resource-dir ' + $resdir +
    ' -isystem ' + $resdir + '/include' +
    ' -isystem ' + $sysroot + '/usr/include' +
    ' -isystem ' + $sysroot + '/usr/include/aarch64-linux-android'
foreach ($name in @('BINDGEN_EXTRA_CLANG_ARGS', 'BINDGEN_EXTRA_CLANG_ARGS_aarch64-linux-android', 'BINDGEN_EXTRA_CLANG_ARGS_aarch64_linux_android')) {
    [Environment]::SetEnvironmentVariable($name, $bindgenArgs, 'Process')
}
Ok ('bindgen 参数（无反斜杠）：' + $bindgenArgs.Substring(0, [Math]::Min(90, $bindgenArgs.Length)) + '…')

# ---------------------------------------------------------------- 2. 取源码
Step 2 ('取上游源码 tag ' + $Tag)
if ($SkipFetch) {
    Ok '按 -SkipFetch 跳过'
} elseif (Test-Path (Join-Path $SrcDir '.git')) {
    Ok ('已存在，复用：' + $SrcDir)
} else {
    New-Item -ItemType Directory -Force -Path (Split-Path $SrcDir -Parent) | Out-Null
    & git -c "http.proxy=$Proxy" clone --depth 1 --branch $Tag https://github.com/EasyTier/EasyTier.git $SrcDir
    if ($LASTEXITCODE -ne 0) { Fail 'clone 失败（代理没通？）' }
    Ok ('已 clone 到 ' + $SrcDir)
}
$commit = (& git -C $SrcDir rev-parse --short HEAD).Trim()
Ok ('commit = ' + $commit + '（桌面端 easytier 是 2.6.4-8428a89d，应与之一致）')

# ---------------------------------------------------------------- 3. 施加两处清单改动
Step 3 '把 ffi 改成静态链入（幂等；源码本身不改）'
$ffiToml = Join-Path $SrcDir 'easytier-contrib\easytier-ffi\Cargo.toml'
$jniToml = Join-Path $SrcDir 'easytier-contrib\easytier-android-jni\Cargo.toml'
$before = Get-Content $ffiToml -Raw
$after = $before -replace 'crate-type = \["cdylib"\]', 'crate-type = ["cdylib", "rlib"]'
if ($after -ne $before) { [IO.File]::WriteAllText($ffiToml, $after, (New-Object Text.UTF8Encoding($false))); Ok 'ffi: crate-type 加 rlib' } else { Ok 'ffi: 已是目标状态' }
$before2 = Get-Content $jniToml -Raw
if ($before2 -notmatch 'easytier-ffi') {
    $after2 = $before2 -replace '(?m)^easytier = \{ path = "\.\./\.\./easytier" \}$', "easytier = { path = `"../../easytier`" }`neasytier-ffi = { path = `"../easytier-ffi`" }"
    if ($after2 -eq $before2) { Fail 'JNI crate 的依赖锚点没匹配上，需要人工处理' }
    [IO.File]::WriteAllText($jniToml, $after2, (New-Object Text.UTF8Encoding($false)))
    Ok 'jni: 加 easytier-ffi 依赖'
} else { Ok 'jni: 已加过' }

# ---------------------------------------------------------------- 4. 编译
Step 4 '交叉编译（首次 15–40 分钟，之后增量很快）'
Push-Location (Join-Path $SrcDir 'easytier-contrib\easytier-android-jni')
try {
    $sw = [Diagnostics.Stopwatch]::StartNew()
    & (Join-Path $CargoHome 'bin\cargo.exe') ndk -t arm64-v8a build --release
    $code = $LASTEXITCODE
    $mins = [math]::Round($sw.Elapsed.TotalMinutes, 1)
} finally { Pop-Location }
if ($code -ne 0) { Fail ('cargo ndk 失败（退出码 ' + $code + '），完整日志看控制台输出') }
Ok ('编译完成，用时 ' + $mins + ' 分钟')

# ---------------------------------------------------------------- 5. 落位
Step 5 '复制到 jniLibs'
$produced = Join-Path $SrcDir 'target\aarch64-linux-android\release\libeasytier_android_jni.so'
if (-not (Test-Path $produced)) { Fail ('没找到产物：' + $produced) }
New-Item -ItemType Directory -Force -Path $JniLibs | Out-Null
Copy-Item $produced (Join-Path $JniLibs 'libeasytier_android_jni.so') -Force
$so = Join-Path $JniLibs 'libeasytier_android_jni.so'
$hash = (Get-FileHash $so -Algorithm SHA256).Hash.ToLower()
Ok ('libeasytier_android_jni.so  ' + (Get-Item $so).Length + ' B  sha256=' + $hash)

# 顺带确认没有第二个 .so（两库方案已废弃；真出现了要当失败处理）
$stray = Get-ChildItem $JniLibs -Filter '*.so' | Where-Object { $_.Name -ne 'libeasytier_android_jni.so' }
if ($stray) { Write-Host ('  ⚠ jniLibs 里还有别的 .so：' + ($stray.Name -join ', ') + ' —— 单库方案下不该有，确认后再删') -ForegroundColor Yellow }

# ---------------------------------------------------------------- 6. 二进制自检
Step 6 '二进制自检'
$bytes = [IO.File]::ReadAllBytes($so)
$head = ($bytes[0..19] | ForEach-Object { $_.ToString('x2') }) -join ' '
Ok ('ELF 头前 20 字节: ' + $head)
if ($bytes[0] -ne 0x7f -or $bytes[1] -ne 0x45 -or $bytes[2] -ne 0x4c -or $bytes[3] -ne 0x46) { Fail '不是 ELF 文件' }
if ($bytes[4] -ne 2) { Fail '不是 64 位 ELF' }
$machine = $bytes[18] + ($bytes[19] -shl 8)
if ($machine -ne 183) { Fail ('e_machine = ' + $machine + '，期望 183(AArch64)') }
Ok '64 位 / AArch64 ✓'
$scan = Join-Path $RepoRoot '.cache\scan-so.mjs'
if (Test-Path $scan) {
    Write-Host '  （用 .cache/scan-so.mjs 解析导出符号与 DT_NEEDED）'
    & node $scan $so 2>&1 | Select-String -Pattern 'Java_com_easytier|DT_NEEDED|undefined|AArch64|ET_DYN' | Select-Object -First 12 | ForEach-Object { '    ' + $_.Line.Trim() }
} else {
    Write-Host '  （没有 .cache/scan-so.mjs，跳过符号解析）' -ForegroundColor Yellow
}

Write-Host "`n完成。下一步：重建 APK 并跑验收脚本" -ForegroundColor Green
Write-Host '  F:\mc\android\android\gradlew.bat assembleDebug' -ForegroundColor Gray
Write-Host '  powershell -File F:\mc\.cache\verify-android-apk.ps1' -ForegroundColor Gray
Write-Host "`n别忘了把 android/native/README.md 里的构建实录更新成本次的实际数字。" -ForegroundColor Yellow
