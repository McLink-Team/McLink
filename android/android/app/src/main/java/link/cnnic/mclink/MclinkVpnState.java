package link.cnnic.mclink;

import java.util.ArrayList;
import java.util.LinkedList;
import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;

/**
 * 进程内的 VPN 状态与事件分发。
 *
 * ## 为什么要有这个类
 *
 * `MclinkVpnService` 是 Service、`MclinkVpnPlugin` 是 Capacitor 插件，两者生命周期完全独立：
 * 插件可能在服务起来之前就被调用（问状态），服务也可能在界面被销毁之后还活着（隧道不该跟 UI 同生共死）。
 * 所以"当前状态"必须放在**两者之外**的进程级位置，谁都能读、谁都能订阅。
 *
 * 同一进程是默认情况（我们没给 Service 指定 `android:process`），所以静态字段够用；
 * 如果哪天为了省内存把它放到独立进程，这个类就必须换成 AIDL 或广播 —— 这一点写在这里，免得后人踩。
 *
 * ## 线程约定
 *
 * `set()` / `log()` 会被服务的工作线程调用；监听者（插件）负责把回调切到主线程再往 JS 推。
 * 这个类自己只保证**它的字段**是安全的，不替调用方切线程。
 */
final class MclinkVpnState {

    /** 一次状态快照。不可变，可以随便跨线程传。 */
    static final class Snapshot {
        final boolean running;
        final String instanceName;
        /** TUN fd；-1 表示当前没有 */
        final int tunFd;
        final long startedAtMs;
        /** 给玩家看的中文错误；null 表示没有错误 */
        final String lastError;
        /**
         * 错误分类（见 docs/android-vpn.md §3 的 code 表）。
         *
         * 为什么要单独一个字段而不是让 JS 去正则匹配 lastError 的文案：文案会改，正则会在改文案那天
         * 悄悄失效 —— 而失效的表现是"错误提示突然变成通用文案"，没人会立刻发现。
         */
        final String lastErrorCode;

        Snapshot(
                boolean running,
                String instanceName,
                int tunFd,
                long startedAtMs,
                String lastError,
                String lastErrorCode) {
            this.running = running;
            this.instanceName = instanceName;
            this.tunFd = tunFd;
            this.startedAtMs = startedAtMs;
            this.lastError = lastError;
            this.lastErrorCode = lastErrorCode;
        }

        static Snapshot stopped() {
            return new Snapshot(false, null, -1, 0L, null, null);
        }
    }

    interface Listener {
        void onStatus(Snapshot snapshot);

        void onLog(String line);
    }

    /** 日志环形缓冲上限。手机上的日志面板只看最近这些，多了没用还占内存。 */
    private static final int MAX_LOGS = 200;

    private static final Object LOCK = new Object();
    private static final CopyOnWriteArrayList<Listener> LISTENERS = new CopyOnWriteArrayList<>();
    private static final LinkedList<String> LOGS = new LinkedList<>();
    private static Snapshot current = Snapshot.stopped();

    private MclinkVpnState() {}

    static Snapshot get() {
        synchronized (LOCK) {
            return current;
        }
    }

    static void set(Snapshot snapshot) {
        synchronized (LOCK) {
            current = snapshot;
        }
        for (Listener listener : LISTENERS) {
            listener.onStatus(snapshot);
        }
    }

    static void log(String line) {
        if (line == null) return;
        synchronized (LOCK) {
            LOGS.addLast(line);
            while (LOGS.size() > MAX_LOGS) LOGS.removeFirst();
        }
        for (Listener listener : LISTENERS) {
            listener.onLog(line);
        }
    }

    static List<String> logs() {
        synchronized (LOCK) {
            return new ArrayList<>(LOGS);
        }
    }

    static void addListener(Listener listener) {
        LISTENERS.addIfAbsent(listener);
    }

    static void removeListener(Listener listener) {
        LISTENERS.remove(listener);
    }
}
