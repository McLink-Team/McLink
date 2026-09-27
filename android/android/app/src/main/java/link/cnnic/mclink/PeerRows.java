package link.cnnic.mclink;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * 把 EasyTier 的 `NetworkInstanceRunningInfo` JSON 变成**桌面端那套"节点行"的形状**。
 *
 * ## 为什么要做这层转换
 *
 * 桌面端的连接诊断与链路显示吃的是 `easytier-cli peer list` 的输出：
 * `client/src/lib/easytier-parse.ts` 的 `parsePeers()` 按
 * `ipv4 / hostname / cost / lat_ms / loss_rate / rx_bytes / tx_bytes / tunnel_proto / nat_type`
 * 这些键取值，再由 `relay-fallback.ts` 判断"到房主是直连还是走中继"。
 *
 * 安卓上没有 `easytier-cli`（进程内跑内核），但 JNI 给了 `collectNetworkInfos()`
 * ——它返回的 JSON 里有 `peer_route_pairs`，也就是同源的数据（桌面端 cli 就是这么拼表的：
 * 见上游 `easytier-cli.rs` 的 `handle_peer_list()`）。
 * 于是这里做一次映射，**共用代码一行都不用改**，安卓的链路/诊断就是真的了。
 *
 * ## 取值口径与上游逐条对齐（不是自己发明的）
 *
 * | 字段 | 上游怎么算 | 这里 |
 * | --- | --- | --- |
 * | `cost` | `cost_to_str(route.cost)`：`1 → "p2p"`，否则 `relay(<cost>)` | 同 |
 * | `lat_ms` | 优先 `peer.default_conn_id` 那条连接的 `latency_us/1000`，否则取所有连接的最小值 | 同 |
 * | `loss_rate` | 同上那条连接的 `loss_rate`（**0..1 的浮点比例**），否则第一条 | 同 |
 * | `rx_bytes` / `tx_bytes` | 所有连接 `stats` 求和 | 同 |
 * | `ipv4` | `route.ipv4_addr.address`（uint32 → 点分十进制） | 同 |
 * | `tunnel_proto` | 各连接 `tunnel.tunnel_type` 去重后用 `,` 连接 | 同（不做上游那套 IPv6 归一化，见下） |
 * | `nat_type` | `route.stun_info.udp_nat_type` 的枚举名 | 同（本地一张 10 项表） |
 *
 * **不输出"本机那一行"**（上游会输出 `cost = "Local"` 的自指行）：它对界面没有价值，
 * 而 `parsePeers` 只在 `cost === 'Local' && ipv4 === ''` 时才跳过，带上地址反而会多出一个假节点。
 *
 * ## 已知的近似（写清楚，别让下一个人以为是 bug）
 *
 * 1. `tunnel_proto` 直接用上游给的 `tunnel_type` 字符串，没做 IPv6 端点那套归一化
 *    （上游 `display_tunnel_type()` 会把 `tcp` 与 `tcp6` 之类区分开）。展示用的差别极小。
 * 2. 数值一律输出**原生数字**（不是上游那种 `"17.33 kB"` / `"5.3%"` 字符串）——
 *    因为共用解析器 `parseHumanNumber/parseLatency/parseLossRate` 本来就接受数字，
 *    这样反而更准（少一次格式化再解析）。
 */
final class PeerRows {

    /** `common.NatType` 的枚举名，顺序与上游 `common.proto` 完全一致（下标即枚举值）。 */
    private static final String[] NAT_TYPES = {
        "Unknown",
        "OpenInternet",
        "NoPAT",
        "FullCone",
        "Restricted",
        "PortRestricted",
        "Symmetric",
        "SymUdpFirewall",
        "SymmetricEasyInc",
        "SymmetricEasyDec",
    };

    private PeerRows() {}

    /**
     * @param json `EasyTierJNI.collectNetworkInfos()` 的原始 JSON
     * @param instanceName 当前实例名；找不到时退回"map 里唯一那个实例"
     * @return 行数组；解析不出来时返回**空数组**（界面显示"无数据"，不编造）
     */
    static JSArray from(String json, String instanceName) {
        JSArray rows = new JSArray();
        if (json == null || json.trim().isEmpty()) return rows;
        try {
            JSONObject root = new JSONObject(json);
            JSONObject info = pickInstance(root.optJSONObject("map"), instanceName);
            if (info == null) return rows;
            JSONArray pairs = info.optJSONArray("peer_route_pairs");
            if (pairs == null) return rows;
            for (int i = 0; i < pairs.length(); i += 1) {
                JSONObject pair = pairs.optJSONObject(i);
                if (pair == null) continue;
                JSObject row = row(pair.optJSONObject("route"), pair.optJSONObject("peer"));
                if (row != null) rows.put(row);
            }
        } catch (Throwable t) {
            // 解析失败不是致命错误：界面少一列读数，比抛异常把房间页打崩好得多
            MclinkVpnState.log("解析内核节点信息失败：" + t);
        }
        return rows;
    }

    private static JSONObject pickInstance(JSONObject map, String instanceName) {
        if (map == null) return null;
        if (instanceName != null && map.optJSONObject(instanceName) != null) return map.optJSONObject(instanceName);
        java.util.Iterator<String> keys = map.keys();
        if (!keys.hasNext()) return null;
        return map.optJSONObject(keys.next());
    }

    private static JSObject row(JSONObject route, JSONObject peer) {
        if (route == null || peer == null) return null;
        JSObject row = new JSObject();
        row.put("ipv4", ipv4Of(route.optJSONObject("ipv4_addr")));
        row.put("hostname", route.optString("hostname", ""));
        int cost = route.optInt("cost", 0);
        row.put("cost", cost == 1 ? "p2p" : "relay(" + cost + ")");
        Double latency = latencyMs(peer);
        row.put("lat_ms", latency == null ? JSONObject.NULL : latency);
        Double loss = lossRate(peer);
        row.put("loss_rate", loss == null ? JSONObject.NULL : loss);
        row.put("rx_bytes", sum(peer, "rx_bytes"));
        row.put("tx_bytes", sum(peer, "tx_bytes"));
        row.put("tunnel_proto", tunnelProtos(peer));
        row.put("nat_type", natTypeOf(route.optJSONObject("stun_info")));
        row.put("id", String.valueOf(route.optInt("peer_id", 0)));
        row.put("version", route.optString("version", ""));
        return row;
    }

    /**
     * `common.Ipv4Inet` 在 JSON 里是个对象：`{address: <uint32>, network_length: <n>}`。
     *
     * 注意 `address` 是**无符号 32 位**：用 `optInt` 会在 ≥ 2^31（即 128.0.0.0 以上）时变成负数，
     * 所以必须 `optLong` 再自己按位取 —— 我们的房间网段（10.200.x.x）碰不到这个边界，
     * 但换个人复用这段代码就会踩，所以这里写对。
     */
    private static String ipv4Of(JSONObject inet) {
        if (inet == null) return "";
        long address = inet.optLong("address", 0L) & 0xFFFFFFFFL;
        return ((address >> 24) & 0xFF) + "." + ((address >> 16) & 0xFF) + "." + ((address >> 8) & 0xFF) + "."
                + (address & 0xFF);
    }

    /** 上游口径：优先"默认连接"，否则所有连接里最小的那个；都没有 → null。 */
    private static Double latencyMs(JSONObject peer) {
        JSONArray conns = peer.optJSONArray("conns");
        if (conns == null) return null;
        String defaultId = peer.optString("default_conn_id", "");
        Double best = null;
        for (int i = 0; i < conns.length(); i += 1) {
            JSONObject conn = conns.optJSONObject(i);
            if (conn == null) continue;
            JSONObject stats = conn.optJSONObject("stats");
            if (stats == null) continue;
            double ms = stats.optLong("latency_us", 0L) / 1000.0;
            if (!defaultId.isEmpty() && defaultId.equals(conn.optString("conn_id", ""))) return ms;
            if (best == null || ms < best) best = ms;
        }
        return best;
    }

    /** 丢包率：**0..1 的比例**（共用解析器会归一化，界面上乘 100 显示）。 */
    private static Double lossRate(JSONObject peer) {
        JSONArray conns = peer.optJSONArray("conns");
        if (conns == null) return null;
        String defaultId = peer.optString("default_conn_id", "");
        Double first = null;
        for (int i = 0; i < conns.length(); i += 1) {
            JSONObject conn = conns.optJSONObject(i);
            if (conn == null) continue;
            double value = conn.optDouble("loss_rate", 0.0);
            if (!defaultId.isEmpty() && defaultId.equals(conn.optString("conn_id", ""))) return value;
            if (first == null) first = value;
        }
        return first;
    }

    private static long sum(JSONObject peer, String field) {
        JSONArray conns = peer.optJSONArray("conns");
        if (conns == null) return 0L;
        long total = 0L;
        for (int i = 0; i < conns.length(); i += 1) {
            JSONObject conn = conns.optJSONObject(i);
            if (conn == null) continue;
            JSONObject stats = conn.optJSONObject("stats");
            if (stats == null) continue;
            total += stats.optLong(field, 0L);
        }
        return total;
    }

    /** 各连接的 `tunnel.tunnel_type` 去重后用 `,` 连接（与上游 `get_conn_protos()` 同口径）。 */
    private static String tunnelProtos(JSONObject peer) {
        JSONArray conns = peer.optJSONArray("conns");
        if (conns == null) return "";
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < conns.length(); i += 1) {
            JSONObject conn = conns.optJSONObject(i);
            if (conn == null) continue;
            JSONObject tunnel = conn.optJSONObject("tunnel");
            if (tunnel == null) continue;
            String type = tunnel.optString("tunnel_type", "").trim();
            if (type.isEmpty()) continue;
            String seen = sb.toString();
            if (seen.contains(type)) continue;
            if (sb.length() > 0) sb.append(',');
            sb.append(type);
        }
        return sb.toString();
    }

    private static String natTypeOf(JSONObject stun) {
        if (stun == null) return "Unknown";
        int code = stun.optInt("udp_nat_type", 0);
        return code >= 0 && code < NAT_TYPES.length ? NAT_TYPES[code] : "Unknown";
    }
}
