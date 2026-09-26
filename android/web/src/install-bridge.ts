/**
 * 副作用模块 —— **只做一件事：把 Android 版的 `window.mclink` 装上去**。
 *
 * 为什么值得单独一个文件（而不是在 main.ts 里写一句 installMobileBridge()）：
 *
 * ES 模块的 import 会被提升到模块体之前求值。main.ts 里写
 * ```ts
 * import MobileApp from './MobileApp.vue';
 * installMobileBridge();            // ← 这行实际上在 MobileApp 的整条依赖图求值之后才跑
 * ```
 * 里程碑 1 这样是**能用**的：`client/src/lib/store.ts` 里所有 `window.mclink.*`
 * 调用都在函数体内，模块求值期碰不到它，第一次真调用发生在 onMounted 的 bootstrap()。
 *
 * 但这依赖一个"当前恰好成立"的事实。哪天有人在某个页面组件里写一句模块级的
 * `window.mclink.info()`（很自然的一种改动），就会炸在
 * "Cannot read properties of undefined" 上，而报错栈指向那个无辜的页面 ——
 * 手机上没法开 devtools，这是最难查的一类失败。
 *
 * 把安装动作放进一个**被第一个 import 的模块**里，就把它变成了 ESM 的求值顺序保证：
 * 谁先 import，谁先跑。以后再有人加模块级调用也不会坏。
 */
import { installMobileBridge } from './mobile-bridge.ts';

installMobileBridge();
