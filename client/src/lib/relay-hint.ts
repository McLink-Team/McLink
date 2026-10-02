/**
 * 中继提示横幅的**文案**（纯函数，回归脚本 `client/scripts/verify-relay-roles.mjs` 钉着）。
 *
 * 为什么文案要在客户端拼：同一条提示推给房间里所有人，但**房主和成员要做的事不一样** ——
 * 房主那台该出现「立即切换」按钮，成员那台该看到"需要房主更换"。服务端发一句通用话术，
 * 两边读起来总有一边别扭；而"我是谁"只有客户端自己知道（`session.isHost`）。
 * 于是服务端只下发**结构**（kind + 两台节点的名字），文字在这里按角色生成。
 *
 * 三种 kind（与 `room.relayHint` 事件、以及心跳发现的 `apply` 对应）：
 *   · `switch` —— 主控已准备好更空闲的中继：房主 → 可切换；成员 → 等房主；
 *   · `notice` —— 到线了但没得换：两边都只是被告知（没有可点的动作）；
 *   · `apply`  —— 房主已经切完，成员点「重连」接上新中继（这条由心跳触发，见 store）。
 */
export type RelayHintKind = 'switch' | 'notice' | 'apply';

export interface RelayHintLike {
  kind?: RelayHintKind;
  /** 当前中继的名字（缺省时退回"当前中继"） */
  currentLabel?: string;
  /** 准备好的新中继名字（`notice`/`apply` 时可能没有） */
  targetLabel?: string;
  /** 服务端给的通用文案（结构字段缺失时的兜底，老主控只发这一条） */
  message?: string;
}

export interface RelayHintCopy {
  /** 系统通知的标题（短） */
  title: string;
  /** 横幅正文（长，含"需要房主"这类角色信息） */
  body: string;
  /**
   * 横幅主按钮的文案：
   *   · 空字符串 = 不显示按钮（成员在房主切换前无事可做，只留「知道了」）；
   *   · 其余就是按钮文字（点了走 `applyRelayHint()` → 重取票据重建隧道）。
   */
  action: string;
}

/** 名字兜底：缺字段时不要显示成「undefined」 */
function label(value: string | undefined, fallback: string): string {
  const trimmed = (value ?? '').trim();
  return trimmed.length > 0 ? trimmed : fallback;
}

export function relayHintCopy(hint: RelayHintLike, isHost: boolean): RelayHintCopy {
  const kind = hint.kind;
  /**
   * 老主控只发一条通用文案（那时还没有 kind / 名字字段）：照原样显示，按钮照旧给 ——
   * 点了就是重取票据重建隧道，语义与当初一致。
   */
  if (!kind) {
    return {
      title: '中继提示',
      body: label(hint.message, '这个房间的中继有点挤，可以切换到更空闲的中继。'),
      action: '现在切换',
    };
  }
  const current = label(hint.currentLabel, '当前中继');
  const target = label(hint.targetLabel, '更空闲的节点');

  if (kind === 'apply') {
    return {
      title: '房间已换到新的中继',
      body: '房主已经把房间换到更空闲的中继了。点下面的「重连」接上新的中继（会卡顿几秒），不重连会连不上房间。',
      action: '重连',
    };
  }

  if (kind === 'notice') {
    return {
      title: '中继节点已到容量上限',
      body:
        `您好，当前房间所使用的中继节点「${current}」已经到容量上限，可能会出现卡顿等情况。` +
        '目前没有更空闲的节点可以换 —— 先忍一下，稍后可以点「重连」再看一次。',
      // 没有可切换的目标，不给按钮（给了也切不动）
      action: '',
    };
  }

  if (isHost) {
    return {
      title: '中继节点已到容量上限，可以切换',
      body:
        `您好，当前房间所使用的中继节点「${current}」已经到容量上限，可能会出现卡顿等情况，` +
        `可切换到新节点「${target}」。切换时你和其他成员都会卡顿几秒，` +
        '重连后其他人点一下「重连」就能跟上。',
      action: '立即切换',
    };
  }

  return {
    title: '中继节点已到容量上限',
    body:
      `您好，当前房间所使用的中继节点「${current}」已经到容量上限，可能会出现卡顿等情况。` +
      `可切换到新节点「${target}」，但需要房主更换 —— 房主切完之后你点「重连」就能跟上。`,
    // 房主还没切，成员自己点重连没有意义（拿到的还是旧中继），所以不给按钮
    action: '',
  };
}
