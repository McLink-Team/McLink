package link.cnnic.mclink;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

/**
 * 应用入口。
 *
 * 唯一与模板不同的地方是注册了一个**本地**插件（`MclinkVpn`）。
 *
 * ⚠️ `registerPlugin()` 必须在 `super.onCreate()` **之前**调用：
 * `BridgeActivity.onCreate()` 内部会 `bridgeBuilder.addPlugins(...).create()` 把 Bridge 建出来，
 * 那时候插件列表已经定型了 —— 放在 super 之后就是一个永远调不到的插件（表现为 JS 侧
 * `registerPlugin('MclinkVpn')` 报 "not implemented"，而 Java 侧一点报错都没有）。
 *
 * 为什么不用 `capacitor.plugins.json` 那种自动发现：那份清单是给 npm 依赖里的插件用的，
 * 我们这个插件在 app 模块内部，没有对应的 npm 包。
 */
public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(MclinkVpnPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
