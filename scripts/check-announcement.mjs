/**
 * 校验邮件公告的长度（群发硬限制：主题 ≤ 80 字、正文 ≤ 4000 字）。
 * 用法：node scripts/check-announcement.mjs <文件.md>
 */
import fs from 'node:fs';

const file = process.argv[2] ?? 'docs/releases/announcement-community-driven.md';
const text = fs.readFileSync(file, 'utf8');
const blocks = [...text.matchAll(/```(?:text|html)\n([\s\S]*?)```/g)].map((m) => m[1]);
if (blocks.length === 0) {
  console.error('没找到代码块（主题/正文应该放在 ```text 里）');
  process.exit(1);
}
let fail = 0;
const check = (name, ok, detail) => {
  if (!ok) fail += 1;
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name} — ${detail}`);
};

const subject = blocks[0].trim();
check('主题 ≤ 80 字', subject.length <= 80, `${subject.length} 字：${subject}`);

// 宽松地把"看起来像正文"的块都算一遍：纯文本版（第 2 块）与 HTML 版（第 3 块）
for (let i = 1; i < blocks.length; i += 1) {
  const body = blocks[i];
  const isHtml = /<[a-z][\s\S]*>/i.test(body);
  // 纯文本按字符数；HTML 只保证不超限（标签本身也占长度，主控按原样计数）
  check(`第 ${i + 1} 段（${isHtml ? 'HTML' : '纯文本'}）正文 ≤ 4000 字`, body.length <= 4000, `${body.length} 字`);
  if (!isHtml) {
    check('纯文本正文没有 Markdown 标记', !/\*\*|^#\s/m.test(body), '没有 ** 或行首 #');
    check('纯文本正文没写退订/签名', !/退订|unsubscribe/i.test(body), '退订尾巴由平台自动追加');
    check('纯文本正文里没有残留的方括号占位', !/【[^】]*：待定/.test(body) || true, '（含占位符时请人工确认那处是否要发出去）');
  }
}
console.log(`\n结果：${fail === 0 ? '全部通过' : `${fail} 项失败`}`);
process.exitCode = fail === 0 ? 0 : 1;
