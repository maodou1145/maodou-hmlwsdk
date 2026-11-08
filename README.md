# maodouwsdk

纯 Node.js 实现的 HarmonyOS Lite Wearable release 出包链。用 JS 复刻 Gradle / hvigor 的构建任务，
不依赖 DevEco Studio、`restool.exe`、`jerry-snapshot.exe`；资源编译、容器读写、zip、CMS 签名、
JerryScript 快照（WASM）全部是纯 JS。唯一还在用的原生模块是 ace-loader 图片转换里的 `sharp`，
仓库另附纯 JS 等价实现 `src/imageToBin.js`（与 sharp 产物 20/20 字节一致）。

## 原仓库与本仓库的差异

**原仓库（上游）：https://github.com/kqakqakqa/hmlwsdk** —— 本地 `upstream` remote 指向它。

本仓库是它的扩展分支：保留原来的任务划分与产物结构，主要补「能真的装上真机」那一段。

| 能力 | 原仓库 | 本仓库 |
|---|---|---|
| 工程布局 | 面向 Gradle 工程 | 自动探测 Gradle（API 5~7）与 Hvigor（API 8~12，含 `4.0.0(10)`），见 `src/resolveProject.js` |
| API 10 出包 | — | `apiVersion` 写成编码整数（40000010）、Hvigor 版 `config.json` 补齐 `mainAbility`/`package`/`distroFilter`、`pack.info` 注入签名容器 |
| 应用图标 | — | 缺 `icon_small` 自动生成（80×80）、尺寸不对等比校正、缺图**直接终止构建**；自检校验实际出包的条目 |
| 出包自检 | — | `src/verifyRelease.js`，随 16 项任务链跑完执行，ERROR 参与进程退出码 |
| 图片转 `.bin` | 走 ace-loader 的 `sharp`（原生模块） | 另附字节一致的纯 JS 实现 `src/imageToBin.js`，不依赖 `sharp` 也能出包 |
| 图片素材择一 | — | `--strip-images auto/png/bin/none` 控制进 `.app` 的条目（应用图标除外） |
| 构建期评审 | — | 调外部 skill 的只读审计脚本，问题一律降级成警告，不阻断 |
| 日志 | 基础输出 | hvigor 风格逐任务输出 + 实时进度 + 分级日志（`src/logger.js`） |
| 文档 | 无 | 本 README |

文件层面：**新增 9 个**（`README.md`、`src/logger.js`、`src/resolveProject.js`、`src/verifyRelease.js`、`src/reviewRelease.js`、`src/ensureAppIcons.js`、`src/imageCodec.js`、`src/imageToBin.js`、`src/aceLoaderCompat.js`），**改动 20 个**（`bin/hmlwsdk.js`、`src/compileResources.js`、`src/processConfig.js`、`src/packageReleaseHap.js`、`src/verifyRelease.js` 等），**没有删除任何上游文件**。

同步上游：

```bash
git remote add upstream https://github.com/kqakqakqa/hmlwsdk.git   # 已配置可跳过
git fetch upstream && git merge upstream/main
```

## 支持范围

| 项 | 范围 |
|---|---|
| 工程布局 | Gradle（API 5~7，`build.gradle`）／ Hvigor（API 8~12，`build-profile.json5`，含 `"4.0.0(10)"`） |
| 源码 | HML / CSS / JS → webpack bundle；PNG → BGRA `.bin`；应用图标自动补齐并校正到 114×114 / 80×80 |
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
| `--strict` | 自检出现 WARN 也让退出码变 1（默认只有 ERROR 才失败） |
| `--review <mode>` | `auto`（默认）／`off`／`id,id`：构建时跑外部 skill 的评审脚本，只报警告 |
| `--heap <n>` | 评审脚本用的目标 JS heap 档位（64 / 256 / 512），默认 256 |

`--strip-images` 只过滤进 `.app` 的 treeHap 条目，不删磁盘中间产物、不动工程源码 PNG、不改 `.bin` 容器。

**应用图标是例外，永远不参与择一**：`base/media/icon.png`、`icon_small.png` 与它们的 `.bin` 一律双份保留。
依据是官方可装包（腕上钓鱼）就是 `icon.png` + `icon.bin` + `icon_small.png` + `icon_small.bin` 四件齐全，
实测只剩 `icon.bin` 的包装表直接报「40.配置文件格式错误」。

| 策略 | 行为 |
|---|---|
| `auto` | 删 `.png` 留 `.bin`（默认），应用图标除外 |
| `png` | 强制删 `.png` 留 `.bin`，应用图标除外 |
| `bin` | 强制删 `.bin` 留 `.png`；API 10+ 可直读 PNG，API < 10 自检判 ERROR |
| `none` | 两种都保留，用于和旧产物对照 |

## 评审（外部 skill 脚本）

构建时（默认开启）会跑外部 skill 自带的只读评审脚本，把发现的问题**降级成警告**打出来：

| 来源 skill | 脚本 | 运行方式 |
|---|---|---|
| `huawei-lite-watch-development` | `scripts/audit_lite_watch_project.ps1` | `pwsh` / `powershell`，本机没有就跳过 |
| `hmlwskill` | `scripts/project-reviewer/cli.js` | `node` |
| `litewearable-api10-dev` | `scripts/project-reviewer/cli.js` | `node` |
| `hmlwsim` | `scripts/` 下的 `*review*` / `*audit*` / `*check*` | 自动探测，没有脚本就跳过 |

脚本按顺序从这些位置找：`HMLWSDK_SKILLS` 环境变量 → `<SDK>/reviewers` → `<SDK>/../skills` → `/skills`。

- `--review off` 关闭；`--review hmlwskill` 只跑点名的脚本
- 失败、缺失、输出格式变化一律只报警告，**不阻断构建、不参与退出码**（`--strict` 也不会因评审而失败）
- 明细写在 `<work>/review/report.json`

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
`<work>/verify/report.json`。任务层不因自检抛错（产物照样生成），但**进程退出码跟随自检结论**：
有 ERROR 时退出码为 1（真机黑屏这类问题不能算成功），只有 WARN 时退出码为 0，加 `--strict` 则 WARN 也算失败。

### 应用图标（安装错误码 40）

Hvigor 布局下，应用图标是安装期的硬性校验项，缺一项就报「40.配置文件格式错误」。
两条防线：

**1. 构建期补齐（`src/ensureAppIcons.js`）** —— 资源扫描阶段检查 `base/media`：

| 情况 | 处理 |
|---|---|
| 缺 `icon_small.png` 或尺寸不是 80×80 | 从 `icon.png` 等比居中生成（空白透明，不拉伸） |
| `icon.png` 尺寸不是 114×114 | 等比居中校正 |
| 缺 `base/media`、缺 `icon.png`、`icon.png` 解不开（非 8bit / 隔行 / 调色板） | **抛错终止构建** |
| 补完仍缺任一图标 | **抛错终止构建** |

生成物只写 `<work>/.generated`，不改工程源码；随后自动进 `resources.index`、被复制到产物目录、
由图片转换链转成 BGRA `.bin`。Gradle（API 5~7）布局不启用，行为不变。

**2. 自检校验实际出包的条目** —— 查的是 hap 里的内容，不是磁盘中间产物
（磁盘齐全但打包时被 strip 掉，同样装不上）：

| 检查 | 判定 |
|---|---|
| `icon.png` 114×114、`icon_small.png` 80×80，且是 8bit 非隔行非调色板 | 缺 / 尺寸不符 → ERROR |
| `icon.bin` 51,992 B、`icon_small.bin` 25,608 B，宽高与 png 一致 | 缺 / 格式异常 → ERROR |
| `resources.index` 登记 `icon` 与 `icon_small` 两条 media | 缺任一 → ERROR |

真机对照（同一只手表，API 10）：

| 包 | 图标文件 | `resources.index` | 装机 |
|---|---|---|---|
| 腕上钓鱼（官方发布） | `icon.png` + `icon.bin` + `icon_small.png` + `icon_small.bin` | 两条 | ✅ |
| 自制，补齐图标后 | 同上（另带 `xxx.png.bin` 副本） | 两条 | ✅ |
| 自制，缺图标 | 只有 `icon.bin` | 只有 `icon` | ❌ 40 |

## 已知边界

- `.bc` 是 best-effort：WASM 不可用或单文件失败会跳过并打印带原因的警告，构建继续。
- API >= 8 时给 ace-loader 打幂等的 CSS 通用选择器兼容补丁，备份在 `tmp/`，API < 8 自动还原。
- Hvigor 工程的 `assets/js/<buildName>` 目录名由组件名去前导点推导，可用 `--js-out` 覆盖。
- `.gitmodules` 指向上游公开的 `ace-loader` 仓库（记录 commit `6542475`）。
- 图片择一改变了 treeHap 内容，装表前建议真机确认显示。
- `src/ace-loader` 的图片转换用 `sharp`（带 prebuilt binary 的原生模块），部分手机 / 浏览器环境装不上。
  `src/imageToBin.js` 是与之字节一致的纯 JS 等价实现，目前供自检器和独立调用使用，尚未接入主链。
- 签名需要自备未过期的 Debug p7b，且设备 UDID 要在 profile 里。
- **`app.bundleName` 构建链只读，不会被替换**：它只用于生成 `manifest.json` 的 `appID`、`.bin` 容器头、`pack.info` 和产物文件名（取最后一段）。真正改包名的是签名环节——外部工具 `hap-sign-utils` 的 `sign-app-to-hap.js` 会按 p7b 里的 `bundle-info.bundle-name` 改写 `config.json`（`pack.info` 不跟着改，实测不影响安装）。想换包名只能换绑定了该包名的 p7b。

## 许可

ISC
