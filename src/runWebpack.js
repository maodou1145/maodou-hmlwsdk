import fs from "fs";
import path from "path";
import { spawnSync } from "child_process";

import { resolveTools, resolveNode } from "./findTools.js";
import { ensureCssCompat } from "./aceLoaderCompat.js";
import * as log from "./logger.js";

/**
 * 调 node + ace-loader/webpack 编译 JS/HML/CSS
 *
 * 对应 Gradle 的 compileReleaseJsWithNode。
 *
 * 实测命令（apps/_empty/_empty）：
 *   node --openssl-legacy-provider <ace-loader>/node_modules/webpack/bin/webpack.js
 *        --config <ace-loader>/webpack.lite.config.js
 *        --env deviceType=liteWearable buildMode=debug sourceMap=none
 *   环境变量：aceModuleRoot / aceModuleBuild / aceManifestPath / watchMode=false / hapMode
 *
 * ⚠ aceModuleRoot 必须是**组件目录**，例如 <模块>/src/main/js/default，不是 src/main。
 *   依据 webpack.lite.config.js 第 119 行：
 *     projectPath = env.aceModuleRoot || process.env.aceModuleRoot || cwd
 *   而 main.product.js 的 loadEntryObj 会检查 <projectPath>/app.js 是否存在，
 *   不存在就报 "ERROR: missing app.js"。所以 Gradle 是每个组件各调一次 webpack。
 *
 * 实测耗时：首次 59 s（webpack cache 为空），第二次 1.76 s。
 * devdemo（24 个页面）release 一次约 20 s。
 *
 * 注意：webpack.lite.config.js 第 138 行会 deleteFolderRecursive(buildPath)，
 * 所以 opts.buildDir 必须是专用目录，不要指到别的产物目录上。
 */
export function compileJs(opts) {
  const tools = opts.tools ?? resolveTools();
  const node = opts.node ?? resolveNode();

  // API 8+ 工程常见 `* { box-sizing: ... }`，api6 校验器会直接判 ERROR。
  // 只在高 API 时放宽，API 6/7 工程保持原样，字节一致性不受影响。
  ensureCssCompat(tools.aceLoader, {
    apiLevel: opts.apiLevel,
    log: opts.log ?? log.info
  });

  const webpackBin = path.join(tools.aceLoader, "node_modules", "webpack", "bin", "webpack.js");
  const webpackConfig = path.join(tools.aceLoader, "webpack.lite.config.js");

  if (!fs.existsSync(webpackBin)) throw new Error(`找不到 webpack：${webpackBin}`);
  if (!fs.existsSync(webpackConfig)) throw new Error(`找不到 webpack 配置：${webpackConfig}`);

  fs.mkdirSync(opts.buildDir, { recursive: true });

  const env = {
    ...process.env,
    // webpack 的 cwd 是 tools.aceLoader，不是调用方目录。所有路径必须绝对化，
    // 否则相对路径会被解析到 ace-loader/ 下面，表现为
    //   ERROR: the manifest file is lost or format is invalid.
    // 而且产物会被写进 ace-loader 目录里。
    aceModuleRoot: path.resolve(opts.moduleRoot),
    aceModuleBuild: path.resolve(opts.buildDir),
    aceManifestPath: path.resolve(opts.manifestPath),
    watchMode: "false",
    buildMode: opts.buildMode ?? "debug",
    hapMode: opts.hapMode ? "true" : "false",
    // webpack.lite.config.js 第 121 行：cachePath 默认是 ace-loader/node_modules/.cache，
    // 实际缓存目录是 <cachePath>/.lite_cache。
    // 这个缓存里存了 manifest 的绝对路径，换一个输出目录就会报
    //   Module not found: Can't resolve '<旧路径>/manifest.json'
    // 所以必须把缓存绑到输出目录旁边，跟输出一起生灭。
    // 不设这个变量，第二次换 work 目录构建就会拿到陈旧缓存、编译失败。
    cachePath: path.resolve(opts.cacheDir ?? path.join(path.dirname(opts.buildDir), "cache")),
    // iconPath：lite-image-coverter-plugin.js 里
    //   "" !== iconPath && getDir(iconPath).forEach(img2bin)
    // 设了它才会把该目录下的 png 也转成 .bin。Gradle 用它把 restool 输出目录里的
    // icon.png 转成 assets/entry/resources/base/media/icon.bin。
    // 注意 img2bin 会同时写 xxx.bin 和 xxx.png.bin 两份，后者要过滤掉。
    ...(opts.iconPath ? { iconPath: path.resolve(opts.iconPath) } : {})
  };

  const dev = opts.deviceType ?? "liteWearable";
  const mode = opts.buildMode ?? "debug";
  const sm = opts.sourceMap ?? "none";

  const args = [
    "--openssl-legacy-provider",
    webpackBin,
    "--config", webpackConfig,
    // api6 的 webpack.lite.config.js 读的是 argv.xxx（第 130-143 行）：
    //   if (argv.deviceType) ... / if (argv.sourceMap === 'none') / if (argv.buildMode === 'release')
    // 所以必须传**直接参数**，不能传 --env。传 --env 只会进 env 对象，
    // argv.buildMode 永远是 undefined → mode 停在 development、产物不压缩
    // （实测 app.js 8195 B，gradle 的是 1604 B）。
    `--deviceType=${dev}`,
    `--buildMode=${mode}`,
    `--sourceMap=${sm}`,
    // 关掉 ace-loader 内建的 SnapshotPlugin —— 它 exec 的是 Windows 专属的
    // jerry-snapshot.exe。依据 webpack.lite.config.js 第 144 行：
    //   if (argv.isPreview !== "true") { webpackConfig.plugins.push(new SnapshotPlugin(...)) }
    // .bc 改由本 SDK 自己用 jerry-parser-wasm 生成，见 src/generateJsSnapshot.js。
    "--isPreview=true",
    // api7 的配置读的是 env.xxx，两个都传，谁用谁取
    "--env", `deviceType=${dev}`,
    "--env", `buildMode=${mode}`,
    "--env", `sourceMap=${sm}`
  ];

  if (opts.appResource) args.push("--env", `appResource=${opts.appResource}`);

  // ⚠ cwd 必须是 ace-loader 目录。
  // Babel 7 的 babel.config.js 是「root 配置」，只从 cwd 往上找。
  // 不设 cwd 的话，它会去 hmlwsdk 根目录找，找不到就静默不转译 ——
  // 结果是产物里没有 "use strict"、没有被 babel 处理过的模块，
  // 模块 ID 也跟着错位（实测 app.js 少 2 字节、index.js 少 414 字节）。
  log.debug(`webpack cmd: ${node} ${args.join(" ")}`);
  log.debug(`webpack cwd: ${tools.aceLoader}`);
  const t0 = Date.now();
  const r = spawnSync(node, args, {
    encoding: "utf8",
    env,
    cwd: tools.aceLoader,
    maxBuffer: 32 * 1024 * 1024
  });

  const ok = (r.stdout ?? "").includes("COMPILE RESULT:SUCCESS");
  // 子进程的几十行输出以前被 spawnSync 全吞了，这里逐行转发并分级：
  // COMPILE RESULT / ERROR 始终可见，loader 逐文件日志与 NOTE 在 --verbose 下展开。
  log.childOutput(r.stdout);
  log.childOutput(r.stderr);
  log.info(`webpack ${ok ? "SUCCESS" : "FAIL"} · exit=${r.status ?? -1} · ${log.formatMs(Date.now() - t0)}`);

  return {
    ok,
    code: r.status ?? -1,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
    buildDir: opts.buildDir
  };
}
