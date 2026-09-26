package link.cnnic.mclink;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.content.pm.ServiceInfo;
import android.net.VpnService;
import android.os.Build;
import android.os.ParcelFileDescriptor;
import androidx.core.app.NotificationCompat;
import androidx.core.content.ContextCompat;
import com.easytier.jni.EasyTierJNI;
import java.io.IOException;
import java.util.ArrayList;
import java.util.List;

/**
 * 把手机接进房间的虚拟局域网。
 *
 * ## 它做的事（顺序不能换）
 *
 * ```
 * startForeground()  →  parseConfig  →  runNetworkInstance  →  establish()  →  setTunFd()
 * ```
 *
 * 每一步的**顺序**都有理由，改之前先读这几条：
 *
 * 1. **`startForeground()` 必须最先**：`startForegroundService()` 之后系统只给 5 秒，
 *    而 `establish()` 可能等系统弹确认，超时就是 ANR/崩溃。
 * 2. **`establish()` 之前必须已经知道要 addRoute 哪些网段**（见 {@link Payload#problem()}）：
 *    **空路由的 VPN 会按默认路由接管整机流量**，用户看到的是"手机突然没网了"。
 *    这条是从 FCL 的线上事故（issue #1429）学来的，宁可连不上也不能整机断网。
 * 3. **`setTunFd()` 放在最后**：内核那边 `tun_mobile.rs` 用一个 channel 一直等 fd
 *    （`fd = tun_fds.recv()`），所以 fd 早到晚到都行 —— 但**我们的顺序是先拿到 TUN 再交给内核**，
 *    这样"隧道没建起来"时不会留下一个已经加入网络的僵尸实例。
 *
 * ## 一个必须知道的静默失败
 *
 * `setTunFd` 返回 0 **不等于**隧道真的通了：内核把 fd 装进虚拟网卡的动作是**异步**的，
 * 失败时只在 Rust 侧打一行 `failed to attach mobile TUN fd`，**不会回传给 Java**。
 * 也就是说这个类能保证的是"接口都调成功了"，真通不通只能靠连通性验证（ping 房主虚拟 IP）。
 * 这一点写在代码里而不是只写在文档里，因为它决定了排查方向。
 */
public class MclinkVpnService extends VpnService {

    public static final String ACTION_START = "link.cnnic.mclink.vpn.START";
    public static final String ACTION_STOP = "link.cnnic.mclink.vpn.STOP";

    private static final String EXTRA_INSTANCE = "instanceName";
    private static final String EXTRA_TOML = "configToml";
    private static final String EXTRA_ADDRESS = "address";
    private static final String EXTRA_PREFIX = "prefix";
    private static final String EXTRA_ROUTES = "routes";
    private static final String EXTRA_MTU = "mtu";

    private static final String CHANNEL_ID = "mclink-vpn";
    private static final int NOTIFICATION_ID = 0x4D43; // "MC"
    private static final String SESSION_NAME = "McLink 联机";

    /**
     * 上次启动参数落盘用的 SharedPreferences。
     *
     * 为什么需要：`START_STICKY` 的服务被系统杀掉后会**用 null intent 重启**
     * （见 onStartCommand 的前几行）。没有这份落盘，重启后的服务就是个不知道连哪儿的空壳。
     */
    private static final String PREFS = "mclink-vpn";
    private static final String KEY_INSTANCE = "instanceName";
    private static final String KEY_TOML = "configToml";
    private static final String KEY_ADDRESS = "address";
    private static final String KEY_PREFIX = "prefix";
    private static final String KEY_ROUTES = "routes";
    private static final String KEY_MTU = "mtu";

    private ParcelFileDescriptor tun;

    public MclinkVpnService() {}

    /* ------------------------------------------------------------ 静态入口（给插件用） */

    public static void start(Context context, Payload payload) {
        ContextCompat.startForegroundService(context, payload.toIntent(context));
    }

    public static void requestStop(Context context) {
        Intent intent = new Intent(context, MclinkVpnService.class).setAction(ACTION_STOP);
        try {
            context.startService(intent);
        } catch (IllegalStateException e) {
            // Android 8+ 在后台不允许"启动"服务。我们只在界面里调这个方法（一定在前台），
            // 所以正常情况下走不到这里；真走到了就让用户重开一次 App，这比崩掉好。
            MclinkVpnState.log("停止指令没能送达（应用不在前台）：" + e.getMessage());
        }
    }

    /* ------------------------------------------------------------ 生命周期 */

    @Override
    public void onCreate() {
        super.onCreate();
        ensureChannel();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent == null ? null : intent.getAction();

        if (ACTION_STOP.equals(action)) {
            MclinkVpnState.log("收到断开指令");
            startForegroundCompat(buildNotification("正在断开…"));
            MclinkVpnState.set(new MclinkVpnState.Snapshot(false, null, -1, 0L, null, null));
            teardown(null, null);
            return START_NOT_STICKY;
        }

        Payload payload = Payload.fromIntent(intent);
        if (payload == null) {
            payload = Payload.restore(this);
            if (payload == null) {
                MclinkVpnState.log("服务被系统重启，但找不到上次的启动参数");
                MclinkVpnState.set(
                        new MclinkVpnState.Snapshot(false, null, -1, 0L, "联机参数已丢失，请回到房间页重新连接", "internal"));
                stopSelf();
                return START_NOT_STICKY;
            }
            MclinkVpnState.log("服务被系统重启，用上次的配置恢复");
        }

        final Payload p = payload;
        final String problem = p.problem();
        if (problem != null) {
            startForegroundCompat(buildNotification("无法建立连接"));
            MclinkVpnState.log("拒绝启动：" + problem);
            teardown("no-routes", problem);
            return START_NOT_STICKY;
        }

        startForegroundCompat(buildNotification("正在连接 · " + p.instanceName));
        MclinkVpnState.log("开始建立隧道：实例 " + p.instanceName + "，地址 " + p.address + "/" + p.prefix);
        Thread worker = new Thread(() -> startTunnel(p), "mclink-vpn-start");
        worker.start();
        return START_STICKY;
    }

    @Override
    public void onRevoke() {
        // Android 同一时刻只允许一个 VPN：被别的应用抢占、或用户在系统设置里断开，都会到这里。
        // 不处理的话界面会一直显示"已联机"，而实际上什么都没通。
        MclinkVpnState.log("VPN 被撤销（被其它 VPN 抢占或用户断开）");
        new Thread(
                        () -> teardown("establish-failed", "连接已中断：另一个 VPN 应用占用了本机，或授权被撤销"),
                        "mclink-vpn-revoke")
                .start();
        super.onRevoke();
    }

    @Override
    public void onDestroy() {
        closeTun();
        try {
            EasyTierJNI.stopAllInstances();
        } catch (Throwable t) {
            MclinkVpnState.log("卸载内核实例失败：" + t);
        }
        MclinkVpnState.Snapshot snapshot = MclinkVpnState.get();
        if (snapshot.running) {
            MclinkVpnState.set(new MclinkVpnState.Snapshot(false, null, -1, 0L, null, null));
            MclinkVpnState.log("服务已销毁，连接结束");
        }
        super.onDestroy();
    }

    /* ------------------------------------------------------------ 建隧道 */

    private void startTunnel(Payload p) {
        try {
            if (EasyTierJNI.parseConfig(p.configToml) != 0) {
                throw new TunnelException("core-failed", EasyTierJNI.describeFailure("解析内核配置"));
            }
            if (EasyTierJNI.runNetworkInstance(p.configToml) != 0) {
                throw new TunnelException("core-failed", EasyTierJNI.describeFailure("启动虚拟网络"));
            }
            MclinkVpnState.log("内核实例已启动，等系统建立虚拟网卡");

            tun = establishTun(p);
            int fd = tun.getFd();
            MclinkVpnState.log("虚拟网卡已建立（fd=" + fd + "），交给内核");

            if (EasyTierJNI.setTunFd(p.instanceName, fd) != 0) {
                throw new TunnelException("core-failed", EasyTierJNI.describeFailure("把虚拟网卡交给内核"));
            }

            p.save(this);
            MclinkVpnState.set(
                    new MclinkVpnState.Snapshot(true, p.instanceName, fd, System.currentTimeMillis(), null, null));
            MclinkVpnState.log("已联机（路由：" + join(p.routes) + "）");
            updateNotification("已联机 · " + p.instanceName);
        } catch (TunnelException e) {
            MclinkVpnState.log("建立失败：" + e.getMessage());
            teardown(e.code, e.getMessage());
        } catch (Throwable t) {
            MclinkVpnState.log("建立隧道时发生异常：" + t);
            teardown("internal", "建立连接时发生异常：" + t);
        }
    }

    private ParcelFileDescriptor establishTun(Payload p) throws TunnelException {
        Builder builder = new Builder().setSession(SESSION_NAME).setMtu(p.mtu).addAddress(p.address, p.prefix);

        /*
         * 只加房间网段的路由，**永远不加 0.0.0.0/0**。
         * 具体网段的安全性在 Payload.problem() 里校验过（前缀 8–24、必须落在 10.200.0.0/16）。
         */
        for (String cidr : p.routes) {
            String[] parts = cidr.split("/");
            builder.addRoute(parts[0].trim(), Integer.parseInt(parts[1].trim()));
            MclinkVpnState.log("加上路由 " + cidr);
        }

        /*
         * 明确不调 addDnsServer。
         * 上游模板里硬编码了 223.5.5.5 / 114.114.114.114，那会把玩家的 DNS 解析改到那两台机器上 ——
         * 我们只路由一个 /24，不需要劫持解析，也不该顺手改用户的上网行为。
         */

        try {
            // 自己的流量不走隧道：否则 EasyTier 连中继的包会被塞回它自己的隧道里，形成死锁
            builder.addDisallowedApplication(getPackageName());
        } catch (PackageManager.NameNotFoundException e) {
            throw new TunnelException("internal", "排除自身包名失败：" + e.getMessage());
        }

        ParcelFileDescriptor fd = builder.establish();
        if (fd == null) {
            throw new TunnelException(
                    "establish-failed", "系统拒绝建立虚拟网络：可能已有其它 VPN 在运行，或被设备策略禁止");
        }
        return fd;
    }

    /* ------------------------------------------------------------ 收尾 */

    private void teardown(String code, String message) {
        try {
            EasyTierJNI.stopAllInstances();
        } catch (Throwable t) {
            MclinkVpnState.log("停止内核实例失败：" + t);
        }
        closeTun();
        Payload.clear(this);
        MclinkVpnState.set(new MclinkVpnState.Snapshot(false, null, -1, 0L, message, code));
        stopForegroundCompat();
        stopSelf();
    }

    private void closeTun() {
        ParcelFileDescriptor fd = tun;
        tun = null;
        if (fd == null) return;
        try {
            fd.close();
        } catch (IOException e) {
            MclinkVpnState.log("关闭虚拟网卡失败：" + e.getMessage());
        }
    }

    /* ------------------------------------------------------------ 通知 */

    private void ensureChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager == null || manager.getNotificationChannel(CHANNEL_ID) != null) return;
        NotificationChannel channel = new NotificationChannel(CHANNEL_ID, "联机状态", NotificationManager.IMPORTANCE_LOW);
        channel.setDescription("显示 McLink 是否已接入虚拟局域网");
        channel.setShowBadge(false);
        channel.enableVibration(false);
        channel.setSound(null, null);
        manager.createNotificationChannel(channel);
    }

    private Notification buildNotification(String text) {
        Intent open = new Intent(this, MainActivity.class)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent content = PendingIntent.getActivity(this, 0, open, pendingFlags());
        PendingIntent disconnect = PendingIntent.getService(
                this, 1, new Intent(this, MclinkVpnService.class).setAction(ACTION_STOP), pendingFlags());

        return new NotificationCompat.Builder(this, CHANNEL_ID)
                .setSmallIcon(R.drawable.ic_mclink_notify)
                .setContentTitle("McLink 联机")
                .setContentText(text)
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                .setShowWhen(false)
                .setPriority(NotificationCompat.PRIORITY_LOW)
                .setCategory(NotificationCompat.CATEGORY_SERVICE)
                .setContentIntent(content)
                .addAction(0, "断开", disconnect)
                .build();
    }

    private void updateNotification(String text) {
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager == null) return;
        manager.notify(NOTIFICATION_ID, buildNotification(text));
    }

    private static int pendingFlags() {
        return Build.VERSION.SDK_INT >= Build.VERSION_CODES.M
                ? PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
                : PendingIntent.FLAG_UPDATE_CURRENT;
    }

    private void startForegroundCompat(Notification notification) {
        if (Build.VERSION.SDK_INT >= 34) {
            // manifest 里声明的是 specialUse（VPN 不属于 dataSync 等任何一类，
            // 而且 dataSync 在 Android 15 上有每天 6 小时的时长上限）
            startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
        } else {
            startForeground(NOTIFICATION_ID, notification);
        }
    }

    private void stopForegroundCompat() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            stopForeground(STOP_FOREGROUND_REMOVE);
        } else {
            stopForeground(true);
        }
    }

    private static String join(List<String> items) {
        StringBuilder sb = new StringBuilder();
        for (String item : items) {
            if (sb.length() > 0) sb.append('、');
            sb.append(item);
        }
        return sb.toString();
    }

    /* ------------------------------------------------------------ 参数与校验 */

    /** 一次启动需要的全部参数。 */
    public static final class Payload {
        final String instanceName;
        final String configToml;
        final String address;
        final int prefix;
        final List<String> routes;
        final int mtu;

        public Payload(
                String instanceName, String configToml, String address, int prefix, List<String> routes, int mtu) {
            this.instanceName = instanceName;
            this.configToml = configToml;
            this.address = address;
            this.prefix = prefix;
            this.routes = routes == null ? new ArrayList<>() : new ArrayList<>(routes);
            this.mtu = mtu;
        }

        /**
         * 八条硬规则里最要紧的两条的**最后一道闸**：在这里拒绝，就永远不会 establish 一个危险的路由。
         *
         * 为什么在 Service 里再校验一遍（TS 侧已经算过一次）：插件是 Java 写的、TS 侧算出来的东西
         * 要经过 JS 桥才到这里，中间任何一环出问题（旧版前端、手写调用、调试注入）都会绕过前面的校验。
         * 这条校验的成本是几十微秒，代价是"整机断网"，不值得省。
         */
        String problem() {
            if (instanceName == null || instanceName.trim().isEmpty()) return "缺少实例名";
            if (configToml == null || configToml.trim().isEmpty()) return "缺少内核配置";
            if (address == null || !address.trim().matches("\\d{1,3}(\\.\\d{1,3}){3}")) return "虚拟地址不合法";
            if (!address.trim().startsWith("10.200.")) return "虚拟地址不在房间网段内（应为 10.200.x.x）";
            if (prefix < 8 || prefix > 24) return "网络前缀不合法：" + prefix;
            if (routes.isEmpty()) return "没有可路由的房间网段：拒绝建立会接管整机流量的空路由 VPN";
            for (String cidr : routes) {
                if (!isSafeRoute(cidr)) return "拒绝不安全的网段：" + cidr;
            }
            if (mtu < 576 || mtu > 1500) return "MTU 不合法：" + mtu;
            return null;
        }

        private static boolean isSafeRoute(String cidr) {
            if (cidr == null) return false;
            String[] parts = cidr.trim().split("/");
            if (parts.length != 2) return false;
            int length;
            try {
                length = Integer.parseInt(parts[1].trim());
            } catch (NumberFormatException e) {
                return false;
            }
            // /8 以下（含 0.0.0.0/0）一律拒绝；房间网段是 /24，给到 /24 为止
            if (length < 8 || length > 24) return false;
            String network = parts[0].trim();
            if ("0.0.0.0".equals(network)) return false;
            return network.startsWith("10.200.");
        }

        Intent toIntent(Context context) {
            Intent intent = new Intent(context, MclinkVpnService.class).setAction(ACTION_START);
            intent.putExtra(EXTRA_INSTANCE, instanceName);
            intent.putExtra(EXTRA_TOML, configToml);
            intent.putExtra(EXTRA_ADDRESS, address);
            intent.putExtra(EXTRA_PREFIX, prefix);
            intent.putExtra(EXTRA_ROUTES, routes.toArray(new String[0]));
            intent.putExtra(EXTRA_MTU, mtu);
            return intent;
        }

        static Payload fromIntent(Intent intent) {
            if (intent == null) return null;
            String instance = intent.getStringExtra(EXTRA_INSTANCE);
            String toml = intent.getStringExtra(EXTRA_TOML);
            String address = intent.getStringExtra(EXTRA_ADDRESS);
            if (instance == null || toml == null || address == null) return null;
            String[] routes = intent.getStringArrayExtra(EXTRA_ROUTES);
            List<String> list = new ArrayList<>();
            if (routes != null) {
                for (String route : routes) list.add(route);
            }
            return new Payload(
                    instance,
                    toml,
                    address,
                    intent.getIntExtra(EXTRA_PREFIX, 24),
                    list,
                    intent.getIntExtra(EXTRA_MTU, 1380));
        }

        void save(Context context) {
            SharedPreferences prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
            prefs.edit()
                    .putString(KEY_INSTANCE, instanceName)
                    .putString(KEY_TOML, configToml)
                    .putString(KEY_ADDRESS, address)
                    .putInt(KEY_PREFIX, prefix)
                    .putString(KEY_ROUTES, join(routes))
                    .putInt(KEY_MTU, mtu)
                    .apply();
        }

        static Payload restore(Context context) {
            SharedPreferences prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
            String instance = prefs.getString(KEY_INSTANCE, null);
            String toml = prefs.getString(KEY_TOML, null);
            String address = prefs.getString(KEY_ADDRESS, null);
            if (instance == null || toml == null || address == null) return null;
            String routes = prefs.getString(KEY_ROUTES, "");
            List<String> list = new ArrayList<>();
            if (routes != null) {
                for (String route : routes.split("、")) {
                    if (!route.trim().isEmpty()) list.add(route.trim());
                }
            }
            return new Payload(
                    instance, toml, address, prefs.getInt(KEY_PREFIX, 24), list, prefs.getInt(KEY_MTU, 1380));
        }

        static void clear(Context context) {
            context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().clear().apply();
        }
    }

    /** 带错误分类的内部异常，避免用字符串正则去猜错误类型。 */
    private static final class TunnelException extends Exception {
        final String code;

        TunnelException(String code, String message) {
            super(message);
            this.code = code;
        }
    }
}
