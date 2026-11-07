# maodouwsdk

纯 Node.js 实现的 HarmonyOS Lite Wearable release 出包链。用 JS 复刻 Gradle / hvigor 的构建任务，
不依赖 DevEco Studio、`restool.exe`、`jerry-snapshot.exe`；资源编译、容器读写、zip、CMS 签名、
JerryScript 快照（WASM）全部是纯 JS。唯一还在用的原生模块是 ace-loader 图片转换里的 `sharp`，
仓库另附纯 JS 等价实现 `src/imageToBin.js`（与 sharp 产物 20/20 字节一致）。

## 支持范围

| 项 | 范围 |
|---|---|
| 工程布局 | Gradle（API 5~7，`build.gradle`）／ Hvigor（API 8~12，`build-profile.json5`，含 `"4.0.0(10)"`） |
| 源码 | HML / CSS / JS → webpack bundle；PNG → BGRA `.bin` |
| 快照 | JerryScript v24 `.bc`，内置 WASM 生成，best-effort |
| 打包 | `.bin` 私有容器 → hap → `.app`（含 `pack.info`） |
| 签名 | CMS / p7b，可选；不给 `--p7b` 就出 unsigned 包 |
| 运行 | Node >= 18；Windows / Linux / macOS。图片转换链路依赖 `sharp`（见下方边界说明） |

## 安装

```bash
git clone --recurse-submodules <仓库地址>
cd maodou-hmlwsdk
npm install
cd src/ace-loader && npm install
```

`src/ace-loader` 是 git submodule（记录 commit `6542475`）。已 clone 但没拉子模块时补一句：

```bash
git submodule update --init
```

## 用法

```bash
node bin/hmlwsdk.js verifyRelease <工程目录> --work ./out
node bin/hmlwsdk.js packageReleaseApp <工程目录>
node bin/hmlwsdk.js --plan verifyRelease
npm run build:verify -- <工程目录>
```

工程目录指含 `entry/`（或 `build-profile.json5` 里 `modules[].srcPath` 指向的模块）的那一层。
`verifyRelease` 是推荐入口：它会带出完整依赖链，跑完自动做产物自检。

## CLI 参数

| 参数 | 说明 |
|---|---|
| `--work <dir>` | 中间产物目录，默认 `<工程>/build/hmlwsdk` |
| `--plan` | 只列任务名（纯文本，便于脚本解析），不执行 |
| `--p7b / --p12 / --p12pwd / --key / --cert` | 签名材料；不给就不签 |
| `--compatible <n> / --target <n>` | 覆盖探测出的 `app.apiVersion` |
| `--js-out <name>` | 覆盖 `assets/js/<名字>`（单组件工程有效） |
| `--strip-images <policy>` | `auto`（默认）／`png`／`bin`／`none`，见下 |
| `--verbose` | 展开 webpack 逐文件日志、NOTE、任务产物声明 |
| `--quiet` | 只留结果行（BUILD SUCCESSFUL / FAILED）与 WARN / ERROR |

`--strip-images` 只过滤进 `.app` 的 treeHap 条目，不删磁盘中间产物、不动工程源码 PNG、不改 `.bin` 容器：

| 策略 | 行为 |
|---|---|
| `auto` | API < 10 删 `.png` 留 `.bin`；API >= 10 删 `.bin` 留 `.png` |
| `png` / `bin` | 强制删指定扩展名 |
| `none` | 两种都保留，用于和旧产物对照 |

## 日志

所有输出统一 `>maodouwsdk` 前缀，分级 `INFO / WARN / ERROR / DEBUG`；任务按 hvigor 风格逐条打印，
带序号、产物路径与体积、单任务耗时，最后给 `BUILD SUCCESSFUL` 汇总。

```
>maodouwsdk INFO  maodouwsdk · Node v22.22.2 · win32 · normal
>maodouwsdk INFO  Layout hvigor · module entry · SDK 4.0.0(10) → API 10
>maodouwsdk INFO  Build target: verifyRelease · 16 tasks
>maodouwsdk       > Task :compileReleaseResources [7/16]
>maodouwsdk         + resources: res\release\normal\lite\resources.index (555 B)
>maodouwsdk         + rTxt: res\release\normal\lite\R.txt (184 B)
>maodouwsdk         Done :compileReleaseResources in 159 ms
>maodouwsdk       > Task :compileReleaseJsWithNode [9/16]
>maodouwsdk INFO  COMPILE RESULT:SUCCESS {"WARN":1,"NOTE":5}
>maodouwsdk INFO  webpack SUCCESS · exit=0 · 10 s 549 ms
>maodouwsdk INFO  快照 2/2 个 .bc · 17,408 B · 75 ms
>maodouwsdk       > Task :packageReleaseHap [13/16]
>maodouwsdk INFO  strip-images=auto → 剔除 .bin 2 个条目，treeHap 保留 15 个
>maodouwsdk         + treeHap: hap\release\entry-release-lite-unsigned.hap (53,126 B)
>maodouwsdk       > Task :packageReleaseApp [14/16]
>maodouwsdk         + app: app\release\tile_guess-release-unsigned.app (29,445 B)
>maodouwsdk INFO  BUILD SUCCESSFUL in 10 s 991 ms
>maodouwsdk INFO  16 tasks executed · 0 failed
```

## 构建链

`verifyRelease` 共 16 个任务，按依赖拓扑排序执行；其它入口只跑各自依赖的子集。

| # | 任务 | 产出 |
|---|---|---|
| 1 | `validateReleaseDistroFilterTask` | 纯校验 |
| 2–3 | `processReleaseJavaRes` / `processReleaseLibsFile` | jar / libs 目录 |
| 4 | `mergeReleaseResources` | `merge_res_file.index` |
| 5–6 | `mergeReleaseProfile` / `processReleaseProfile` | 加工后的 `config.json` |
| 7 | `compileReleaseResources` | `resources.index` + `R.txt`（纯 JS 复刻 restool -z） |
| 8 | `generateReleaseJsManifest` | 每组件一份 `manifest.json` |
| 9 | `compileReleaseJsWithNode` | webpack bundle + 图片 `.bin` + `.bc` 快照 |
| 10 | `generateReleaseBinSource` | 组装 `source/lite/` |
| 11–12 | `generateReleaseJsBin` / `signReleaseJsBin` | `.bin` 私有容器 |
| 13 | `packageReleaseHap` | 单 `.bin` 形态 hap + 文件树形态 hap |
| 14 | `packageReleaseApp` | `.app` = treeHap + `pack.info` |
| 15 | `signReleaseApp` | 可选签名 |
| 16 | `verifyRelease` | `verify/report.json` |

只有**文件树形态**的 hap 会进 `.app`；单 `.bin` 形态是旁支产物。

## 产物与自检

`verifyRelease` 检查首页是否为 `pages/index/index`、`.bc` 魔数与版本、图片 `.bin` 头、
`.bin` 容器、`.app` 条目、`config.json` 与 `pack.info` 的 `apiVersion`，报告写到
`<work>/verify/report.json`。自检**只报告不阻断构建**。

## 已知边界

- `.bc` 是 best-effort：WASM 不可用或单文件失败会跳过并打印带原因的警告，构建继续。
- API >= 8 时给 ace-loader 打幂等的 CSS 通用选择器兼容补丁，备份在 `tmp/`，API < 8 自动还原。
- Hvigor 工程的 `assets/js/<buildName>` 目录名由组件名去前导点推导，可用 `--js-out` 覆盖。
- `.gitmodules` 仍指向上游公开的 `ace-loader` 仓库；本仓库为私有。
- 图片择一改变了 treeHap 内容，装表前建议真机确认显示。
- `src/ace-loader` 的图片转换用 `sharp`（带 prebuilt binary 的原生模块），部分手机 / 浏览器环境装不上。
  `src/imageToBin.js` 是与之字节一致的纯 JS 等价实现，目前供自检器和独立调用使用，尚未接入主链。
- 签名需要自备未过期的 Debug p7b，且设备 UDID 要在 profile 里。

## 许可

ISC
