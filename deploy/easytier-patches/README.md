# EasyTier 补丁目录

上游 EasyTier 的行为有两处我们**必须自己修**（详见 `docs/development.md` §10.5 与
`docs/troubleshooting.md` §6.6）：

1. **avoid-relay 在外来网络上失效**：「只协助打洞」的节点靠 `disable_relay_data` 广播
   `avoid_relay_data`，但对端在**代转外来网络（我们的房间）的 public server** 这条链上拿不到
   这个标志，于是惩罚不生效 —— 数据仍然走那台被标记的节点、被它丢掉，房间不通。
   本地复现：`node scripts/repro-easytier-avoid-relay.mjs`（复现时退出码 1）。

## 目录约定

```
deploy/easytier-patches/*.patch         生产补丁（按文件名排序依次 git apply）
deploy/easytier-patches/debug/*.patch   仅用于定位的探针补丁，**不进生产构建**
```

补丁对 **上游源码** 打（基准：`EasyTier/EasyTier` 的 `v2.6.4` = `8428a89d`），
由 `.github/workflows/build-easytier.yml` 编译成三平台二进制，
再用 `scripts/check-easytier-patch.mjs` 对着本地复现脚本验收。

## 为什么不用上游的 release 二进制

上游 2.6.4 的 release 二进制就是我们线上踩到 avoid-relay 失效的那一版；补丁修好之后，
节点与客户端都必须换成我们自己的构建产物，否则「只协助打洞」依旧不可靠。

## 验收判据（每次改补丁都要跑）

```bash
node scripts/repro-easytier-avoid-relay.mjs --case=marked-latency-first
# 上游二进制：exit 1（复现 bug）
# 打过补丁的二进制：exit 0（被标记的那台被绕开）
```
