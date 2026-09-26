package com.easytier.jni;

/**
 * EasyTier 官方 Android JNI 的宿主侧门面。
 *
 * ## 为什么这个文件长这样
 *
 * 这份声明**逐字对应** EasyTier v2.6.4 的
 * `easytier-contrib/easytier-android-jni/src/lib.rs` 里那些
 * `#[unsafe(no_mangle)] pub extern "system" fn Java_com_easytier_jni_EasyTierJNI_<方法>`
 * —— 也就是说上游用的是**名字约定导出**：类名、包名、方法名、签名必须完全一致，
 * 否则运行时是 `UnsatisfiedLinkError`。我们没有选择包名的自由。
 *
 * 上游在 v2.6.4 里**没有** `JNI_OnLoad`、**没有** `RegisterNatives`、**没有**方法表，
 * 只有 6 个原生方法（下面这 6 个 `native`）。上游那份 Kotlin 门面里还有
 * `deleteNetworkInstance` / `listInstances` / `callJsonRpc` / `startConfigServerClient`
 * 等等 —— **那些在 v2.6.4 的 .so 里不存在**（它们是 main/2.7.0 才加的），
 * 所以这里一个都不声明：声明了就是运行时崩溃。
 *
 * ⚠️ `collectNetworkInfos` 在 v2.6.4 是**无参**的（上限在 Rust 里写死），
 * 而上游 Kotlin 门面却写成 `collectNetworkInfos(maxLength: Int)` —— 两边不一致。
 * JNI 的短名回退能让带参声明"碰巧"命中无参实现，但那是未定义行为，
 * 所以这里**照 .so 的真实导出声明无参版本**。
 *
 * ## 与桌面端的版本关系
 *
 * 桌面端 `client/vendor/easytier/` 是 `2.6.4-8428a89d`，这两个 `.so` 也从
 * **同一个 tag `v2.6.4`** 的源码构建，保证手机作为房客与主控中继、桌面房主
 * 说的是同一版协议。
 *
 * ## 许可证
 *
 * EasyTier 是 **LGPL-3.0**。这两个 `.so` 是**未经修改**的上游构建产物
 * （不 strip、不改名、不重链接），以动态库形式使用；替换点就是
 * `android/android/app/src/main/jniLibs/arm64-v8a/` 下的文件。
 */
public final class EasyTierJNI {

    /**
     * 两个库的加载顺序是**故意的**。
     *
     * v2.6.4 的 JNI 库在 `lib.rs` 里用 `unsafe extern "C" { ... }` 声明了一组外部符号
     * （`set_tun_fd` / `parse_config` / …），却没有把 `easytier-ffi` 写进依赖，
     * 于是上游编出来的库对外部符号**没有 `DT_NEEDED`** —— 运行时要么靠加载顺序碰运气，
     * 要么报 `cannot locate symbol "set_tun_fd"`。
     *
     * 我们交付的 `libeasytier_android_jni.so` 是**自包含**的：构建时把 `easytier-ffi` 改成
     * 静态链入（见 `android/native/build-jni.ps1` 头部的说明），所以**不需要**第二个 `.so`。
     *
     * 那为什么还要先尝试加载的 `easytier_ffi`：万一将来有人换回上游那套"两库"构建，
     * 先加载 FFI 库至少是**对**的顺序 —— 而顺序写错的表现是 `UnsatisfiedLinkError`，
     * 排查要从头读一遍上游 `lib.rs`。代价只是失败时吞掉一条异常。
     */
    static {
        try {
            System.loadLibrary("easytier_ffi");
        } catch (UnsatisfiedLinkError ignored) {
            // 单库构建下这里必然失败，且**不需要**成功 —— 见上面的说明
        }
        System.loadLibrary("easytier_android_jni");
    }

    private EasyTierJNI() {}

    /** 把 VpnService 建立出来的 TUN fd 交给内核。 */
    public static native int setTunFd(String instanceName, int fd);

    /** 只校验 TOML，不启动实例。 */
    public static native int parseConfig(String config);

    /** 用 TOML 启动一个网络实例。 */
    public static native int runNetworkInstance(String config);

    /** 保留数组里列出的实例，停掉其余实例；传 null 或空数组 = 停掉全部。 */
    public static native int retainNetworkInstance(String[] instanceNames);

    /** 运行中实例的信息（JSON），失败返回 null。**v2.6.4 无参**。 */
    public static native String collectNetworkInfos();

    /** 最近一次错误（线程局部）。**必须先查它再拼错误信息**，否则只能拿到一句 "returns -1"。 */
    public static native String getLastError();

    /**
     * 便利方法：停掉全部实例（上游 Kotlin 门面里也是这么写的，转发到 retainNetworkInstance(null)）。
     *
     * 为什么不用 `deleteNetworkInstance`：v2.6.4 的 .so 里没有那个导出。
     */
    public static int stopAllInstances() {
        return retainNetworkInstance(null);
    }

    /**
     * 把 `getLastError()` 变成一句能看的错误描述。
     *
     * 为什么要包一层：原生方法失败时返回 -1，而**只有 getLastError() 才知道原因**；
     * 直接 `"启动失败: " + (-1)` 这种信息对排查毫无价值。
     */
    public static String describeFailure(String what) {
        String detail = null;
        try {
            detail = getLastError();
        } catch (Throwable ignored) {
            // 连 getLastError 都调不动（例如库根本没加载上），只能退化
        }
        if (detail == null || detail.trim().isEmpty()) return what + "失败（内核没有给出原因）";
        return what + "失败：" + detail.trim();
    }
}
