#!/usr/bin/env node
import path from "path";

import { runBuild, plan } from "../src/runBuild.js";
import { createTaskContext } from "../src/createTaskContext.js";
import { resolveProject } from "../src/resolveProject.js";
import * as log from "../src/logger.js";

/**
 * hmlwsdk 命令行入口
 *
 *   node bin/hmlwsdk.js signReleaseApp <工程目录>
 *   node bin/hmlwsdk.js packageReleaseApp <工程目录> --work <中间产物目录>
 *   node bin/hmlwsdk.js --plan signReleaseApp        只列要跑哪些任务，不执行
 *
 * 工程布局自动探测（见 src/resolveProject.js）：
 *   Gradle 工程  build.gradle + entry/build.gradle，API 5~7
 *   Hvigor 工程  build-profile.json5，compatibleSdkVersion "4.0.0(10)" 这类，API 8~12
 *
 * 版本/组件覆盖（探测结果不对时用）：
 *   --compatible <n>  覆盖 app.apiVersion.compatible
 *   --target <n>      覆盖 app.apiVersion.target
 *   --js-out <name>   覆盖 assets/js/<名字>（单组件工程有效）
 *
 * 图片素材择一（只影响进 .app 的 treeHap 条目，不改源码与中间产物）：
 *   --strip-images auto  默认，按目标 API 自动选：API<10 删 .png 留 .bin，API>=10 删 .bin 留 .png
 *   --strip-images png   强制删 .png 留 .bin
 *   --strip-images bin   强制删 .bin 留 .png
 *   --strip-images none  两种都保留（用于和旧产物对照）
 *
 * 日志（统一前缀 `>maodouwsdk`，分级 INFO / WARN / ERROR / DEBUG）：
 *   --verbose  展开 webpack 逐文件日志、NOTE、任务产物声明
 *   --quiet    只留 WARN / ERROR
 *   --plan     例外，输出纯任务名列表，方便脚本解析
 *
 * 签名相关参数（不给就跳过签名，出 unsigned 包）：
 *   --p7b <file>      必给，HarmonyOS profile
 *   --p12 <file>      PKCS#12 私钥库，配合 --p12pwd
 *   --p12pwd <pwd>    p12 密码
 *   --key <file>      直接给 PEM 私钥（和 --p12 二选一）
 *   --cert <file>     替换内置的华为根+中间证书链
 *
 * 工程目录指模块目录的上一级，例如 apps/devdemo/devdemo（里面有 entry/）。
 */

const argv = process.argv.slice(2);
const flags = {};
const args = [];

for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--plan") flags.plan = true;
  else if (argv[i] === "--verbose") flags.verbose = true;
  else if (argv[i] === "--quiet") flags.quiet = true;
  else if (argv[i] === "--work") flags.work = argv[++i];
  else if (argv[i] === "--p7b") flags.p7b = argv[++i];
  else if (argv[i] === "--p12") flags.p12 = argv[++i];
  else if (argv[i] === "--p12pwd") flags.p12pwd = argv[++i];
  else if (argv[i] === "--key") flags.key = argv[++i];
  else if (argv[i] === "--cert") flags.cert = argv[++i];
  else if (argv[i] === "--compatible") flags.compatible = Number(argv[++i]);
  else if (argv[i] === "--target") flags.target = Number(argv[++i]);
  else if (argv[i] === "--js-out") flags.jsOut = argv[++i];
  else if (argv[i] === "--strip-images") flags.stripImages = argv[++i];
  else args.push(argv[i]);
}

const STRIP_POLICIES = ["auto", "png", "bin", "none"];
log.configure({ verbose: flags.verbose, quiet: flags.quiet });

if (flags.stripImages !== undefined && !STRIP_POLICIES.includes(flags.stripImages)) {
  log.error(`--strip-images 只接受 ${STRIP_POLICIES.join(" / ")}，收到 "${flags.stripImages}"`);
  process.exit(1);
}

const target = args[0];
const projectDir = args[1];

if (!target) {
  log.error("用法: hmlwsdk <任务名> <工程目录> [--work 目录] [--plan]");
  log.error("例如: hmlwsdk signReleaseApp /path/to/apps/devdemo/devdemo");
  log.error("      hmlwsdk --plan signReleaseApp");
  process.exit(1);
}

// --plan 只输出任务名，保持纯文本便于脚本解析
if (flags.plan) {
  for (const name of plan(target)) console.log(name);
  process.exit(0);
}

if (!projectDir) {
  log.error("缺少工程目录。用法: hmlwsdk <任务名> <工程目录>");
  process.exit(1);
}

log.info(`maodouwsdk · Node ${process.version} · ${process.platform} · ${flags.verbose ? "verbose" : "normal"}`);
log.info(`Project ${path.resolve(projectDir)}`);

const root = path.resolve(projectDir);

const project = resolveProject(root, {
  ...(Number.isFinite(flags.compatible) ? { compatible: flags.compatible } : {}),
  ...(Number.isFinite(flags.target) ? { target: flags.target } : {}),
  ...(flags.jsOut ? { jsOut: flags.jsOut } : {})
});

log.info(
  `Layout ${project.layout} · module ${project.moduleName} · ` +
    `SDK ${project.sdkVersionRaw} → API ${project.apiLevel}`
);
log.info(
  `apiVersion compatible=${project.compatibleSdkVersion} target=${project.compileSdkVersion} · ` +
    `strip-images=${flags.stripImages ?? "auto"}`
);
for (const c of project.components) {
  log.info(`Component ${c.name} → src js/${c.dirName} → out assets/js/${c.buildName}`);
}

const taskContext = createTaskContext({
  projectDir: root,
  moduleDir: project.moduleDir,
  moduleName: project.moduleName,
  layout: project.layout,
  components: project.components,
  work: path.resolve(flags.work ?? path.join(root, "build", "hmlwsdk")),
  srcConfig: project.srcConfig,
  compileSdkVersion: project.compileSdkVersion,
  compatibleSdkVersion: project.compatibleSdkVersion,
  apiLevel: project.apiLevel,
  sdkVersionRaw: project.sdkVersionRaw,
  stripImages: flags.stripImages ?? "auto",
  // 没给 p7b 就是"不签"，与 Gradle 没配 signingConfig 的行为一致
  signingConfig: flags.p7b
    ? { p7b: flags.p7b, p12: flags.p12, password: flags.p12pwd, keyFile: flags.key, certPath: flags.cert }
    : undefined
});

const r = await runBuild(taskContext, target);

if (!r.ok) {
  log.error(`Build stopped at :${r.failedAt}`);
  process.exit(1);
}

log.info(`Output ${taskContext.work}`);
