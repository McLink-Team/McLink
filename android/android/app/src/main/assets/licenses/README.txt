McLink Android 端随包附带的开源许可材料
=======================================

本目录里的文件是**随 APK 一起分发**的第三方许可材料。打包时它们在 APK 的
`assets/licenses/` 下，可以用 `unzip -l app-debug.apk | grep licenses` 看到。

--------------------------------------------------------------------------------
EasyTier-LGPL-3.0.txt
--------------------------------------------------------------------------------

**这是什么**：GNU Lesser General Public License v3.0 全文，来自
`https://github.com/EasyTier/EasyTier` 的 tag `v2.6.4`（`LICENSE` 文件）。

sha256 = e3a994d82e644b03a792a930f574002658412f62407f5fee083f2555c5f23118
（与上游 tag 上的文件**逐字节一致**，LF 行尾；本地 `git checkout` 会把它变成 CRLF，
所以比对时先归一化行尾。）

**它为什么在这里**：APK 里包含一个 EasyTier 的动态库

```
android/android/app/src/main/jniLibs/arm64-v8a/libeasytier_android_jni.so
```

这个库是 EasyTier 项目以 **LGPL-3.0** 发布的（源码：tag `v2.6.4`）。
它由我们**从上游源码构建**，构建方式见 `android/native/README.md` §9 与构建脚本
`android/native/build-jni.ps1`；EasyTier 的**源码本身未作任何修改**，
只改了两处构建清单（`Cargo.toml`）——把 `easytier-ffi` 从"另一个动态库"改成
静态链入 JNI 库。这么做的原因很实际：上游 v2.6.4 那套"两个 .so"的装法不自洽
（JNI 库对外部符号没有 `DT_NEEDED`，靠加载顺序碰运气），单库版本没有这个隐患。

因为我们是以**未经修改的动态库**形式使用它们（不 strip、不改名、不重新链接，
构建产物逐字节就是构建脚本的产物），需要：

1. 随分发物附上 LGPL-3.0 全文 —— 就是这个文件；
2. 指明获取对应源码的位置 —— `https://github.com/EasyTier/EasyTier`，tag `v2.6.4`（commit `8428a89`）；
3. 保证用户可以**替换**这个库 —— 见下。

**替换点（LGPL 的"可替换库"要求）**：要让应用使用你自己编译/修改过的版本，
只需替换上面那个 `.so` 后重新打包 APK 即可，**不需要修改本项目的任何源代码**。
它是 APK 里唯一与 EasyTier 相关的二进制；我们的 Java 代码（`com.easytier.jni.EasyTierJNI`）
只是一层 `native` 方法声明，不含 EasyTier 的任何实现。

**我们做了哪些改动**：**源码零改动**。构建方式与所用工具链记在
`android/native/README.md`（§9）；构建脚本是 `android/native/build-jni.ps1`。

--------------------------------------------------------------------------------
其它
--------------------------------------------------------------------------------

- McLink 自身的许可与第三方依赖清单位于仓库根目录（见 `LICENSE` 与各 `package.json`）。
- Capacitor 及其插件的许可不重复放在这里：它们以 npm 依赖形式打包，各自的 `LICENSE`
  随 `node_modules` 分发，且都是 MIT。
