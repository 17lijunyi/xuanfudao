# 第二轮源码检查证据

对应报告：`docs/源码第二轮检查-2026-09-21.md`。

- `second-pass-probes.cjs`：7 类缺陷的隔离复现，执行现有函数；密钥库使用临时文件，网络只访问自己启动的本地测试服务。
- `second-pass-probes.json`：上述复现结果。
- `second-pass-renderer.cjs`：使用真实 renderer 与 preload；验证正常初始化、两种非数组存储数据，以及模拟设备下的录音启动竞争。
- `second-pass-renderer.json`：页面复现结果。录音竞争与第一份脚本重复验证，合计确认 8 类缺陷。
- `second-pass-verification.json`：源码摘要哈希与本轮检查结果。

从项目根目录执行：

```sh
node docs/audits/2026-09-21/second-pass-probes.cjs "$PWD"
env -u ELECTRON_RUN_AS_NODE node_modules/.bin/electron docs/audits/2026-09-21/second-pass-renderer.cjs "$PWD"
```

这些脚本断言的是“缺陷在当时的源码中可复现”，成功退出不代表应用没有问题；它们没有加入 `npm test`。修复后应把相关场景改成验证正确行为的正式回归测试。函数切片定位失效也会让复现脚本失败，不能把这种失败当作缺陷已修复。

渲染复现使用独立用户数据目录、拒绝实际权限请求及外部网页请求；音频设备是测试替身，不采集真实音频。脚本不加载实际主进程、不操作安装版，也不读取用户密钥库。所有示例内容均为测试占位内容。
