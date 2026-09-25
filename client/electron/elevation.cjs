/**
 * 「能不能建虚拟网卡」的判定（纯逻辑，不依赖 electron，便于离线验证）。
 *
 * 为什么单独抽出来：这条判定已经错过一次 —— 第一版只看完整性级别（whoami 里的
 * S-1-16-12288），于是 `runas /trustlevel:0x20000` 的**受限令牌**被当成"已提权"，
 * 界面显示"已以管理员身份运行，虚拟网卡可用"，而核心建不出网卡、退出码 1。
 * 第二版改成去 whoami 里找 RESTRICTED(S-1-5-12) —— 那个 SID 属于令牌的"受限 SID 列表"，
 * whoami 不列它，于是判定照旧返回"已提权"（用户复测："还是不行，没有提示无权限"）。
 *
 * 现在判定只依赖一个权威事实：`WindowsPrincipal.IsInRole(Administrator)`
 * （UAC 过滤令牌与受限令牌都是 false），whoami 那份输出只用来**解释原因**。
 * 抽成纯函数之后，四种组合都能被脚本断言，不必再靠"在真机上碰运气"。
 */

/**
 * @param adminIsInRole `IsInRole(Administrator)` 的结果：true/false；探测失败传 null
 * @param high 令牌完整性级别是不是 High（whoami 里的 S-1-16-12288）
 * @param restricted whoami 里是否出现 RESTRICTED(S-1-5-12)（受限令牌**可能**会带，但不保证）
 * @returns {{ ok: boolean, reason: string | null }}
 */
function decideElevation({ adminIsInRole, high, restricted }) {
  if (adminIsInRole === true) return { ok: true, reason: null };

  if (adminIsInRole === false) {
    if (restricted) {
      return {
        ok: false,
        reason: '当前进程是受限令牌（例如用 runas /trustlevel 启动）：无法创建虚拟网卡，请直接用「以管理员身份重启」',
      };
    }
    if (high) {
      return {
        ok: false,
        reason:
          '令牌的完整性级别是 High，但 Administrators 组是 deny-only（被 UAC 过滤，或用了受限令牌）—— 实际没有管理员权限，无法创建虚拟网卡，请用「以管理员身份重启」',
      };
    }
    return { ok: false, reason: '未以管理员身份运行：创建虚拟网卡需要管理员权限，请用「以管理员身份重启」' };
  }

  /*
   * 探测失败（没有 PowerShell、被策略拦住、超时）：退回原来的 SID 判断。
   * 原则是**宁可保守**：High 才算"有权限"，其余一律按"没权限"提示 ——
   * 反之（误报"已提权"）会让玩家在完全错误的方向上排查，本次事故就是这么来的。
   */
  if (restricted) {
    return { ok: false, reason: '当前进程是受限令牌：无法创建虚拟网卡，请用「以管理员身份重启」' };
  }
  if (!high) {
    return { ok: false, reason: '未以管理员身份运行：创建虚拟网卡需要管理员权限，请用「以管理员身份重启」' };
  }
  return { ok: true, reason: null };
}

/**
 * 组装"以管理员身份重启"用的 PowerShell 命令。
 *
 * 为什么必须抽出来单独测：用户实测"以管理员身份重启这个按钮按了没用" ——
 * 打包版**没有额外参数**，而老代码无条件拼了 `-ArgumentList `（后面空着），
 * PowerShell 直接报 `Missing an argument for parameter 'ArgumentList'` 并以 1 退出，
 * 既不弹授权框也没有任何提示。开发版带着入口参数，所以怎么点都是好的 ——
 * 这条路径**必须按打包形态断言**，不能只在开发版上点一下就算验过。
 */
function buildElevateCommand(exe, args = []) {
  const quote = (s) => `'${String(s).replace(/'/g, "''")}'`;
  // 没有参数时**完全不要出现** -ArgumentList（空值会让 PowerShell 报参数缺失）
  const argList = args.length > 0 ? ` -ArgumentList @(${args.map(quote).join(',')})` : '';
  return `Start-Process -FilePath ${quote(exe)}${argList} -Verb RunAs`;
}

module.exports = { decideElevation, buildElevateCommand };
