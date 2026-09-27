package link.cnnic.mclink;

import android.Manifest;
import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.VpnService;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import androidx.activity.result.ActivityResult;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.easytier.jni.EasyTierJNI;
import java.text.SimpleDateFormat;
import java.io.IOException;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.util.ArrayList;
import java.util.Date;
import java.util.List;
import java.util.Locale;
import java.util.TimeZone;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import org.json.JSONObject;

/**
 * 把 {@link MclinkVpnService} 暴露给渲染层的 Capacitor 插件。
 *
 * 接口契约见 `docs/android-vpn.md` §3（那份文档与这里必须一致，改一处就要改另一处）。
 *
 * ## 为什么授权流程要绕一圈
 *
 * `VpnService.prepare()` 返回的 Intent **只能由 Activity 发起**（它要弹系统对话框）。
 * 服务里调不了，也不能用 Application context。所以：
 *
 * ```
 * 插件（有 Activity）→ VpnService.prepare() → 非 null？→ startActivityForResult
 *                                              → null？  → 已经授权过，直接起服务
 * ```
 *
 * 用户点了"允许"才继续；点了"拒绝"是一个**合法的选择**，不是错误 —— 回报 `vpn-denied`
 * 让界面解释清楚，并且**不要再弹一次**（反复弹窗是流氓行为，Android 也会限制）。
 *
 * ## 为什么要等结果再 resolve
 *
 * `start()` 如果立刻 resolve 一个 `running`，而两秒后 `establish()` 失败，界面就已经显示
 * "已联机"了 —— 这是假话。所以这里等服务回报"成功或失败"再 resolve（超时 25 秒）。
 */
@CapacitorPlugin(name = "MclinkVpn")
public class MclinkVpnPlugin extends Plugin implements MclinkVpnState.Listener {

    /** 等服务回报结果的最长时间。建立隧道通常是 1–3 秒，25 秒是给"弱网 + 内核启动慢"留的余量。 */
    private static final int START_TIMEOUT_SECONDS = 25;

    /**
     * 等"房间规则已生效"的最长时间。
     *
     * 比 start 还长：施加 ACL 要先把内核实例停掉、再用新配置起一个（含隧道重新协商），
     * 弱网下比首次连接更慢 —— 而超时表现是"房主以为没踢掉"，宁可多等几秒。
     */
    private static final int ACL_TIMEOUT_SECONDS = 35;

    /** TCP 探测的单次超时与次数 —— 与桌面端 `client/electron/tcping.cjs` 逐字一致 */
    private static final int TCPING_TIMEOUT_MS = 1200;

    private static final int TCPING_ATTEMPTS = 3;

    private static final String EVENT_STATUS = "statusChanged";
    private static final String EVENT_LOG = "log";

    private final Handler main = new Handler(Looper.getMainLooper());

    /** 等授权期间暂存的启动参数（授权回调里要用）。 */
    private MclinkVpnService.Payload pendingPayload;

    /** 等"成功或失败"的信号；由 onStatus 触发。 */
    private volatile CountDownLatch startLatch;

    @Override
    public void load() {
        MclinkVpnState.addListener(this);
    }

    @Override
    protected void handleOnDestroy() {
        MclinkVpnState.removeListener(this);
    }

    /* ------------------------------------------------------------ 事件 */

    @Override
    public void onStatus(MclinkVpnState.Snapshot snapshot) {
        CountDownLatch latch = startLatch;
        if (latch != null && (snapshot.running || snapshot.lastError != null)) {
            latch.countDown();
        }
        final JSObject payload = statusToJs(snapshot);
        main.post(() -> notifyListeners(EVENT_STATUS, payload));
    }

    @Override
    public void onLog(String line) {
        final JSObject payload = new JSObject();
        payload.put("line", line);
        payload.put("at", iso(System.currentTimeMillis()));
        main.post(() -> notifyListeners(EVENT_LOG, payload));
    }

    /* ------------------------------------------------------------ 方法 */

    @PluginMethod
    public void start(PluginCall call) {
        MclinkVpnService.Payload payload = buildPayload(call);
        if (payload == null) return; // buildPayload 里已经 reject 过

        Context context = getContext();
        if (context == null) {
            call.reject("应用上下文不可用", "internal");
            return;
        }

        Intent prepare = VpnService.prepare(context);
        if (prepare != null) {
            pendingPayload = payload;
            startActivityForResult(call, prepare, "vpnPermissionResult");
            return;
        }
        launch(call, payload);
    }

    /**
     * 系统 VPN 授权对话框的回调。方法名与 {@code startActivityForResult(..., "vpnPermissionResult")} 对应，
     * 参数签名必须是 {@code (PluginCall, ActivityResult)} —— Capacitor 7 用反射按名字找这个方法。
     */
    @ActivityCallback
    private void vpnPermissionResult(PluginCall call, ActivityResult result) {
        MclinkVpnService.Payload payload = pendingPayload;
        pendingPayload = null;
        if (payload == null) {
            if (call != null) call.reject("授权结果与请求对不上，请重试", "internal");
            return;
        }
        if (call == null) return;
        if (result == null || result.getResultCode() != Activity.RESULT_OK) {
            call.reject("没有授予 VPN 权限：加入虚拟局域网需要它", "vpn-denied");
            return;
        }
        launch(call, payload);
    }

    @PluginMethod
    public void stop(PluginCall call) {
        Context context = getContext();
        if (context != null) MclinkVpnService.requestStop(context);
        new Thread(
                        () -> {
                            long deadline = System.currentTimeMillis() + 5000;
                            while (System.currentTimeMillis() < deadline && MclinkVpnState.get().running) {
                                try {
                                    Thread.sleep(50);
                                } catch (InterruptedException e) {
                                    Thread.currentThread().interrupt();
                                    break;
                                }
                            }
                            MclinkVpnState.Snapshot snapshot = MclinkVpnState.get();
                            JSObject out = statusToJs(snapshot);
                            out.put("ok", !snapshot.running);
                            resolve(call, out);
                        },
                        "mclink-vpn-stop")
                .start();
    }

    @PluginMethod
    public void status(PluginCall call) {
        call.resolve(statusToJs(MclinkVpnState.get()));
    }

    /**
     * 节点列表（连接诊断、以及"到房主是直连还是走中继"都靠它）。
     *
     * 数据来自 `EasyTierJNI.collectNetworkInfos()` —— 与桌面端 `easytier-cli peer list` 同源
     * （上游 cli 也是从 `peer_route_pairs` 拼表的），映射见 {@link PeerRows}。
     *
     * 为什么放工作线程：JNI 调用 + JSON 解析，几毫秒到几十毫秒，而界面每隔几秒就会问一次；
     * 放主线程会跟界面抢那点时间，不值得。
     */
    @PluginMethod
    public void peers(PluginCall call) {
        final MclinkVpnState.Snapshot snapshot = MclinkVpnState.get();
        if (!snapshot.running) {
            JSObject out = new JSObject();
            out.put("ok", false);
            out.put("error", "还没有联机，暂时没有节点数据");
            call.resolve(out);
            return;
        }
        new Thread(
                        () -> {
                            JSObject out = new JSObject();
                            try {
                                String json = EasyTierJNI.collectNetworkInfos();
                                out.put("ok", true);
                                out.put("data", PeerRows.from(json, snapshot.instanceName));
                            } catch (Throwable t) {
                                out.put("ok", false);
                                out.put("error", "读取节点信息失败：" + t);
                            }
                            resolve(call, out);
                        },
                        "mclink-vpn-peers")
                .start();
    }

    /**
     * TCP 连接探测（延迟）。
     *
     * 与桌面端 `client/electron/tcping.cjs` **同口径**：单次 1200ms 超时、连打 3 次取最快、
     * 下限 1ms（亚毫秒握手显示成「0 ms」会让人以为没测到）。键与桌面一致：`host:port`。
     *
     * 为什么值得在安卓上也做：它同时解决两件事 ——
     *   1. 建房页的节点延迟不再全是「—」（此前是空实现，节点选择没有依据）；
     *   2. **它是"隧道通不通"的可靠判据**：ICMP 在虚拟网络上不可信（对端防火墙、路由表歧义，
     *      见 docs/android-vpn.md §5），而 MC 本来就走 TCP。
     */
    @PluginMethod
    public void tcping(PluginCall call) {
        JSArray targets = call.getArray("targets");
        final List<String[]> list = new ArrayList<>();
        if (targets != null) {
            for (int i = 0; i < targets.length(); i += 1) {
                JSONObject target = targets.optJSONObject(i);
                if (target == null) continue;
                String host = target.optString("host", "").trim();
                int port = target.optInt("port", 0);
                if (host.isEmpty() || port <= 0 || port > 65535) continue;
                list.add(new String[] {host, String.valueOf(port)});
            }
        }
        new Thread(
                        () -> {
                            JSObject results = new JSObject();
                            for (String[] target : list) {
                                Integer ms = probeTcp(target[0], Integer.parseInt(target[1]));
                                results.put(target[0] + ":" + target[1], ms == null ? JSONObject.NULL : ms);
                            }
                            JSObject out = new JSObject();
                            out.put("results", results);
                            resolve(call, out);
                        },
                        "mclink-vpn-tcping")
                .start();
    }

    /** 单次 TCP 握手耗时（ms）；三次都连不上返回 null（契约里 null 就是这个含义）。 */
    private static Integer probeTcp(String host, int port) {
        Integer best = null;
        for (int attempt = 0; attempt < TCPING_ATTEMPTS; attempt += 1) {
            Socket socket = new Socket();
            try {
                long started = System.nanoTime();
                socket.connect(new InetSocketAddress(host, port), TCPING_TIMEOUT_MS);
                int ms = (int) ((System.nanoTime() - started) / 1_000_000L);
                if (ms < 1) ms = 1; // 与桌面端一致：亚毫秒不当 0
                if (best == null || ms < best) best = ms;
            } catch (Throwable ignored) {
                // 连不上不是错误：null 表示"三次都没连上"，界面显示「—」
            } finally {
                try {
                    socket.close();
                } catch (IOException ignored) {
                    // 连接本来就没建立，关不掉也无所谓
                }
            }
        }
        return best;
    }

    /**
     * 施加房主的房间规则（踢人/封禁）。
     *
     * 返回形状与 start/stop 一致：**平铺** `{ ok, mode?, error? }`（契约见 docs/android-vpn.md §3）。
     *
     * 为什么要等服务回报再 resolve：安卓这边是"重启内核实例"式施加（与桌面端 2.6.4 走的回退路径同一条，
     * 因为 2.6.4 没有 `acl set` 热更新），要几秒钟才生效。先 resolve 一个 ok 再偷偷失败的话，
     * 房主会以为人已经踢掉了 —— 而对方还在房间里玩。
     */
    @PluginMethod
    public void applyAcl(PluginCall call) {
        String aclToml = call.getString("aclToml");
        if (aclToml == null || aclToml.trim().isEmpty()) {
            call.reject("房间规则是空的", "internal");
            return;
        }
        // 只做形状检查：真正的解析交给内核（parseConfig）—— 这里拦的是"明显不是 ACL 的东西"
        if (!aclToml.contains("[acl.")) {
            call.reject("房间规则格式不对（缺少 [acl.*] 段）", "internal");
            return;
        }
        Context context = getContext();
        if (context == null) {
            call.reject("应用上下文不可用", "internal");
            return;
        }
        if (!MclinkVpnState.get().running) {
            call.reject("还没有联机，无法应用房间规则", "not-running");
            return;
        }

        final long before = MclinkVpnState.aclOutcome().id;
        MclinkVpnService.applyAcl(context, aclToml);

        new Thread(
                        () -> {
                            MclinkVpnState.AclOutcome outcome = null;
                            long deadline = System.currentTimeMillis() + ACL_TIMEOUT_SECONDS * 1000L;
                            while (System.currentTimeMillis() < deadline) {
                                MclinkVpnState.AclOutcome now = MclinkVpnState.aclOutcome();
                                if (now.id != before) {
                                    outcome = now;
                                    break;
                                }
                                try {
                                    Thread.sleep(80);
                                } catch (InterruptedException e) {
                                    Thread.currentThread().interrupt();
                                    break;
                                }
                            }
                            JSObject out = new JSObject();
                            if (outcome == null) {
                                out.put("ok", false);
                                out.put("error", "应用房间规则超时：内核没有在 " + ACL_TIMEOUT_SECONDS + " 秒内回报结果");
                            } else if (outcome.ok) {
                                out.put("ok", true);
                                out.put("mode", outcome.mode == null ? "restart" : outcome.mode);
                            } else {
                                out.put("ok", false);
                                out.put("error", outcome.error == null ? "应用房间规则失败" : outcome.error);
                            }
                            resolve(call, out);
                        },
                        "mclink-vpn-acl-await")
                .start();
    }

    @PluginMethod
    public void logs(PluginCall call) {
        JSArray lines = new JSArray();
        for (String line : MclinkVpnState.logs()) {
            // Android 的 JSONArray.put(Object) 不声明受检异常（与参考实现不同），所以这里不需要 try/catch
            lines.put(line);
        }
        JSObject out = new JSObject();
        out.put("lines", lines);
        call.resolve(out);
    }

    /* ------------------------------------------------------------ 内部 */

    private void launch(PluginCall call, MclinkVpnService.Payload payload) {
        Context context = getContext();
        if (context == null) {
            call.reject("应用上下文不可用", "internal");
            return;
        }

        requestNotificationPermission();

        // 先建 latch 再起服务：服务可能在极短时间内就回报结果，晚建就漏掉信号了
        final CountDownLatch latch = new CountDownLatch(1);
        startLatch = latch;

        try {
            MclinkVpnService.start(context, payload);
        } catch (Throwable t) {
            startLatch = null;
            call.reject("无法启动联机服务：" + t.getMessage(), "internal");
            return;
        }

        new Thread(
                        () -> {
                            boolean settled = false;
                            try {
                                settled = latch.await(START_TIMEOUT_SECONDS, TimeUnit.SECONDS);
                            } catch (InterruptedException e) {
                                Thread.currentThread().interrupt();
                            }
                            startLatch = null;

                            MclinkVpnState.Snapshot snapshot = MclinkVpnState.get();
                            JSObject out = statusToJs(snapshot);
                            out.put("ok", snapshot.running);
                            if (!snapshot.running) {
                                out.put(
                                        "code",
                                        snapshot.lastErrorCode != null ? snapshot.lastErrorCode : "internal");
                                out.put(
                                        "message",
                                        snapshot.lastError != null
                                                ? snapshot.lastError
                                                : (settled
                                                        ? "连接没有成功，请重试"
                                                        : "启动超时：内核没有在 " + START_TIMEOUT_SECONDS + " 秒内就绪"));
                            }
                            resolve(call, out);
                        },
                        "mclink-vpn-await")
                .start();
    }

    /**
     * 把 JS 传来的参数变成 Service 用的对象，并在这里做**第一道**校验。
     *
     * 第二道在 `MclinkVpnService.Payload#problem()`（Service 侧不信任任何入参）。
     * 这一道存在的意义是**给出更好的错误分类**：路由算不出来是 `no-routes`（前端要重拉票据），
     * 参数缺失是 `internal`（前端 bug），两者对玩家的含义完全不同。
     */
    private MclinkVpnService.Payload buildPayload(PluginCall call) {
        String instanceName = trim(call.getString("instanceName"));
        String toml = call.getString("configToml");
        JSObject address = call.getObject("address");
        JSArray routes = call.getArray("routes");
        Integer mtu = call.getInt("mtu");

        if (instanceName == null || instanceName.isEmpty()) {
            call.reject("缺少实例名", "internal");
            return null;
        }
        if (toml == null || toml.trim().isEmpty()) {
            call.reject("缺少内核配置", "internal");
            return null;
        }
        if (address == null) {
            call.reject("缺少虚拟地址：票据里没有可用的房间网段", "no-routes");
            return null;
        }
        String ip = trim(address.getString("ip"));
        Integer prefix = address.getInteger("prefix", 0);
        if (ip == null || prefix == null || prefix <= 0) {
            call.reject("虚拟地址不完整：" + address, "no-routes");
            return null;
        }

        List<String> list = new ArrayList<>();
        if (routes != null) {
            for (int i = 0; i < routes.length(); i += 1) {
                JSONObject route = routes.optJSONObject(i);
                if (route == null) continue;
                String routeIp = trim(route.optString("ip", null));
                int routePrefix = route.optInt("prefix", 0);
                if (routeIp == null || routePrefix <= 0) continue;
                list.add(routeIp + "/" + routePrefix);
            }
        }
        if (list.isEmpty()) {
            // 这是最重要的一次拒绝：没有路由的 VPN 会接管整机流量
            call.reject("算不出房间网段，已拒绝建立虚拟网络（宁可连不上，也不能让手机断网）", "no-routes");
            return null;
        }

        return new MclinkVpnService.Payload(
                instanceName, toml, ip, prefix, list, mtu == null || mtu <= 0 ? 1380 : mtu);
    }

    private JSObject statusToJs(MclinkVpnState.Snapshot snapshot) {
        JSObject out = new JSObject();
        out.put("running", snapshot.running);
        out.put("instanceName", snapshot.instanceName == null ? JSONObject.NULL : snapshot.instanceName);
        if (snapshot.tunFd >= 0) {
            out.put("tunFd", snapshot.tunFd);
        } else {
            out.put("tunFd", JSONObject.NULL);
        }
        out.put("startedAt", snapshot.startedAtMs > 0 ? iso(snapshot.startedAtMs) : JSONObject.NULL);
        out.put("lastError", snapshot.lastError == null ? JSONObject.NULL : snapshot.lastError);
        out.put("lastErrorCode", snapshot.lastErrorCode == null ? JSONObject.NULL : snapshot.lastErrorCode);
        out.put("vpnAuthorized", vpnAuthorized());
        return out;
    }

    /**
     * 系统是否已经给过我们 VPN 授权。
     *
     * `VpnService.prepare()` 只是**查询**（返回 null = 已授权 / 非 null = 需要弹窗），
     * 它不会弹任何东西，所以在 status() 里随便调是安全的。
     */
    private boolean vpnAuthorized() {
        try {
            return VpnService.prepare(getContext()) == null;
        } catch (Throwable t) {
            return false;
        }
    }

    /**
     * Android 13+ 通知需要运行时权限。
     *
     * 这里**只请求、不等待**：拿不到权限的后果仅仅是"前台服务的常驻通知看不见"，
     * 隧道照样能跑。为它阻塞一次联机不值得。
     */
    private void requestNotificationPermission() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return;
        Context context = getContext();
        Activity activity = getActivity();
        if (context == null || activity == null) return;
        if (ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS)
                == PackageManager.PERMISSION_GRANTED) {
            return;
        }
        try {
            ActivityCompat.requestPermissions(
                    activity, new String[] {Manifest.permission.POST_NOTIFICATIONS}, 0x4D43);
        } catch (Throwable t) {
            MclinkVpnState.log("请求通知权限失败（不影响联机）：" + t.getMessage());
        }
    }

    /** 统一在主线程 resolve —— JS 桥只能在主线程碰。 */
    private void resolve(final PluginCall call, final JSObject data) {
        main.post(() -> call.resolve(data));
    }

    private static String trim(String value) {
        if (value == null) return null;
        String trimmed = value.trim();
        return trimmed.isEmpty() ? null : trimmed;
    }

    private static String iso(long millis) {
        SimpleDateFormat format = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US);
        format.setTimeZone(TimeZone.getTimeZone("UTC"));
        return format.format(new Date(millis));
    }
}
