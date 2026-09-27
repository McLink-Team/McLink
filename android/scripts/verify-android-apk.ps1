# 成品 APK 验收：把"包对"这件事变成可复跑的断言，而不是靠肉眼看
#
# 用法（在仓库根执行）：
#   pwsh -File .cache/verify-android-apk.ps1
#   pwsh -File .cache/verify-android-apk.ps1 -Apk android/release/mclink-android-0.2.0-debug.apk
#
# 为什么要有它：APK 是"最后一公里"—— .so 有没有真打进去、清单有没有被合并掉、
# 许可材料在不在包里，全都只有解包才能确认。构建成功 ≠ 包是对的。

param(
    [string]$Apk = 'F:\mc\android\android\app\build\outputs\apk\debug\app-debug.apk',
    [string]$JniLibs = 'F:\mc\android\android\app\src\main\jniLibs'
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem

$pass = 0
$fail = 0
function Check([string]$name, [bool]$ok, [string]$detail) {
    if ($ok) { $script:pass++; Write-Host ("  [OK]   " + $name + $(if ($detail) { "  — " + $detail })) }
    else { $script:fail++; Write-Host ("  [FAIL] " + $name + $(if ($detail) { "  — " + $detail })) -ForegroundColor Red }
}

Write-Host ""
Write-Host ("验收目标：" + $Apk)
if (-not (Test-Path $Apk)) { Write-Host "APK 不存在，先构建" -ForegroundColor Red; exit 1 }
$apkItem = Get-Item $Apk
Check 'APK 存在且非空' ($apkItem.Length -gt 0) ((Get-FileHash $Apk -Algorithm SHA256).Hash.ToLower() + ' / ' + $apkItem.Length + ' B')

# ---------- 1. 原生库 ----------
Write-Host ""
Write-Host "1) 原生库（EasyTier，LGPL-3.0，未经修改）"
$zip = [System.IO.Compression.ZipFile]::OpenRead($Apk)
try {
    $libEntries = @($zip.Entries | Where-Object { $_.FullName -like 'lib/*' })
    $names = $libEntries | ForEach-Object { $_.FullName }
    # 单库设计：easytier-ffi 被静态链进 JNI 库（构建补丁见 android/native/README.md §9），
    # 所以包里**应该只有一个** .so。多出 libeasytier_ffi.so 说明构建方式退回了"两库"，
    # 而"两库"在 Android 上加载顺序敏感（上游 v2.6.4 的已知缺陷），要当成失败处理。
    $want = 'lib/arm64-v8a/libeasytier_android_jni.so'
    $entry = $libEntries | Where-Object { $_.FullName -eq $want } | Select-Object -First 1
    if (-not $entry) {
        Check ("包含 " + $want) $false '未找到'
    } else {
        $src = Join-Path $JniLibs 'arm64-v8a\libeasytier_android_jni.so'
        $detail = $entry.Length.ToString() + ' B'
        if (Test-Path $src) {
            # 真比字节：把包内条目解出来算 sha256，与 jniLibs 里的源文件比
            $tmp = [IO.Path]::GetTempFileName()
            [System.IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $tmp, $true)
            $h1 = (Get-FileHash $tmp -Algorithm SHA256).Hash.ToLower()
            $h2 = (Get-FileHash $src -Algorithm SHA256).Hash.ToLower()
            Remove-Item $tmp -Force
            Check ("包含且与源文件逐字节一致 " + $want) ($h1 -eq $h2) ($detail + ' sha256=' + $h1.Substring(0, 16) + '…')
        } else {
            Check ("包含 " + $want) $true ($detail + "（jniLibs 源文件不在本机，跳过字节比对）")
        }
    }
    $extra = $names | Where-Object { $_ -ne $want }
    Check '没有多余的 .so / 多余的 ABI' ($extra.Count -eq 0) $(if ($extra.Count -eq 0) { '只有 arm64-v8a 的 libeasytier_android_jni.so' } else { '多出: ' + ($extra -join ', ') })

    # ---------- 2. 许可材料 ----------
    Write-Host ""
    Write-Host "2) LGPL 合规材料（必须随包分发）"
    $lic = $zip.Entries | Where-Object { $_.FullName -eq 'assets/licenses/EasyTier-LGPL-3.0.txt' } | Select-Object -First 1
    Check '包含 assets/licenses/EasyTier-LGPL-3.0.txt' ($null -ne $lic) $(if ($lic) { $lic.Length.ToString() + ' B' } else { '缺失' })
    if ($lic) {
        $tmp = [IO.Path]::GetTempFileName()
        [System.IO.Compression.ZipFileExtensions]::ExtractToFile($lic, $tmp, $true)
        $hash = (Get-FileHash $tmp -Algorithm SHA256).Hash.ToLower()
        Remove-Item $tmp -Force
        # 与 upstream tag v2.6.4 的 LICENSE 逐字节一致（LF）
        Check 'LGPL 全文与 upstream v2.6.4 一致' ($hash -eq 'e3a994d82e644b03a792a930f574002658412f62407f5fee083f2555c5f23118') ('sha256=' + $hash.Substring(0, 16) + '…')
    }
    $readme = $zip.Entries | Where-Object { $_.FullName -eq 'assets/licenses/README.txt' } | Select-Object -First 1
    Check '包含 assets/licenses/README.txt（说明替换点与来源）' ($null -ne $readme) $(if ($readme) { $readme.Length.ToString() + ' B' } else { '缺失' })

    # ---------- 3. 前端产物 ----------
    Write-Host ""
    Write-Host "3) 前端产物（Capacitor 的 WebView 根目录）"
    $index = $zip.Entries | Where-Object { $_.FullName -eq 'assets/public/index.html' } | Select-Object -First 1
    Check '包含 assets/public/index.html' ($null -ne $index) $(if ($index) { $index.Length.ToString() + ' B' } else { '缺失' })
    $js = @($zip.Entries | Where-Object { $_.FullName -like 'assets/public/assets/index-*.js' })
    Check '包含打包后的 JS bundle' ($js.Count -ge 1) (($js | ForEach-Object { $_.FullName }) -join ', ')
    Check '包含 classes.dex' ($null -ne ($zip.Entries | Where-Object { $_.FullName -eq 'classes.dex' } | Select-Object -First 1)) ''
} finally { $zip.Dispose() }

# ---------- 4. 清单 ----------
Write-Host ""
Write-Host "4) 清单（用 aapt2 读**已构建的包**，不是读源文件）"
$bt = Get-ChildItem 'F:\android-sdk\build-tools' -Directory -ErrorAction SilentlyContinue | Sort-Object Name -Descending | Select-Object -First 1
$aapt2 = if ($bt) { Join-Path $bt.FullName 'aapt2.exe' } else { 'aapt2' }
if (Test-Path $aapt2) {
    $tree = & $aapt2 dump xmltree --file AndroidManifest.xml $Apk 2>&1 | Out-String
    Check '声明了 MclinkVpnService' ($tree -match 'link\.cnnic\.mclink\.MclinkVpnService') ''
    Check '服务带 BIND_VPN_SERVICE 权限' ($tree -match 'android\.permission\.BIND_VPN_SERVICE') ''
    Check 'foregroundServiceType = specialUse (0x40000000)' ($tree -match 'foregroundServiceType\(0x01010599\)=0x40000000') ''
    Check '声明了 PROPERTY_SPECIAL_USE_FGS_SUBTYPE = vpn' (($tree -match 'PROPERTY_SPECIAL_USE_FGS_SUBTYPE') -and ($tree -match 'android:value\(0x01010024\)="vpn"')) ''
    Check '服务带 android.net.VpnService intent-filter' ($tree -match 'android\.net\.VpnService') ''
    foreach ($perm in 'INTERNET', 'ACCESS_NETWORK_STATE', 'FOREGROUND_SERVICE', 'FOREGROUND_SERVICE_SPECIAL_USE', 'POST_NOTIFICATIONS') {
        Check ("权限 " + $perm) ($tree -match [regex]::Escape('android.permission.' + $perm)) ''
    }
} else { Check 'aapt2 可用' $false '找不到 build-tools 里的 aapt2' }

# ---------- 5. 原生库符号自检（这道闸是真机事故换来的，别删） ----------
Write-Host ""
Write-Host "5) 原生库符号自检（未定义符号必须为空）"
<#
    为什么要有这一步：
    0.2.0 那个包**通过了当时所有检查**，装到真机上却立刻报
        dlopen failed: cannot locate symbol "collect_network_infos"
    原因是上游 v2.6.4 的 JNI crate 只在 `unsafe extern "C"` 里声明 FFI 函数、没真正链上实现，
    而 `-shared` 允许未定义符号 → 编译"成功"，失败推迟到 dlopen。
    当时我的检查用的是 `easytier|Java_` 正则，而 `collect_network_infos` / `set_tun_fd`
    这类名字两个都不含 → **静默漏报**。所以现在改成：把 APK 里的 .so 解出来，
    交给 `.cache/check-undefined-symbols.mjs` 按**符号名清单**判定（而不是正则碰运气）。
#>
$checker = Join-Path $PSScriptRoot 'check-undefined-symbols.mjs'
if (-not (Test-Path $checker)) { $checker = 'F:\mc\android\scripts\check-undefined-symbols.mjs' }
if (Test-Path $checker) {
    $zip = [System.IO.Compression.ZipFile]::OpenRead($Apk)
    try {
        $entry = $zip.Entries | Where-Object { $_.FullName -eq 'lib/arm64-v8a/libeasytier_android_jni.so' } | Select-Object -First 1
        if ($entry) {
            $tmpSo = Join-Path ([IO.Path]::GetTempPath()) ('mclink-verify-' + [guid]::NewGuid().ToString('n') + '.so')
            [System.IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $tmpSo, $true)
            $out = & node $checker $tmpSo 2>&1 | Out-String
            Remove-Item $tmpSo -Force -ErrorAction SilentlyContinue
            $ok = ($LASTEXITCODE -eq 0)
            Check '包内 .so 没有残留的 FFI 未定义符号' $ok $(if ($ok) { '（FFI 实现已静态链入）' } else { '有未定义符号 → 装机必 dlopen 失败' })
            if (-not $ok) {
                $out -split "`n" | Select-String -Pattern '没有静态链接进来|collect_network_infos|set_tun_fd' | Select-Object -First 3 | ForEach-Object { Write-Host ('      ' + $_.Line.Trim()) -ForegroundColor Red }
            }
            $summary = ($out -split "`n" | Select-String -Pattern 'DYNSYM:|EXPORTED Java_' | ForEach-Object { $_.Line.Trim() }) -join '  |  '
            if ($summary) { Write-Host ('      ' + $summary) -ForegroundColor DarkGray }
        } else {
            Check '包内有 .so 可供符号自检' $false '没找到 lib/arm64-v8a/libeasytier_android_jni.so'
        }
    } finally { $zip.Dispose() }
} else {
    Check '符号自检脚本存在' $false ('找不到 ' + $checker + '（这道检查不能省）')
}

Write-Host ""
Write-Host ("结果：" + $pass + " 通过 / " + $fail + " 失败") -ForegroundColor $(if ($fail -eq 0) { 'Green' } else { 'Red' })
if ($fail -gt 0) { exit 1 }
