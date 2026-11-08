import fs from "fs";
import path from "path";

import { stringifyConfig } from "./processConfig.js";
import { parseRTable, fillResourceIds } from "./parseResourceTable.js";
import { todo } from "./createTaskContext.js";

/**
 * generateReleaseBinSource —— 组装 .bin 的原料目录
 *
 * 整条链最大的缺口。Gradle 的实现类叫 GenerateJsBinSource（注解写着
 * Use Node.js，但实现里一行 node 都没调，全是 copy）。
 *
 * 实测产出（apps/devdemo/devdemo/entry/build/intermediates/js/release/source/lite）：
 *   config.json                       3422 B
 *   assets/entry/resources.index       338 B
 *   assets/entry/resources/base/media/attributes.key   1 B
 *   assets/entry/resources/base/media/constants.key    1 B
 *   assets/entry/resources/base/media/contents.key     1 B
 *   assets/entry/resources/base/media/nodes.key        1 B
 *   assets/entry/resources/base/media/icon.bin     51992 B
 *   assets/entry/resources/base/media/icon.png      3621 B
 *   assets/entry/resources/base/media/icon_small.bin  25608 B
 *   assets/entry/resources/base/media/icon_small.png   6165 B
 *   assets/entry/resources/rawfile/fileReadTest.txt   1392 B
 *   assets/js/default/app.js / app.bc / manifest.json
 *   assets/js/default/common/*.bin + *.png（每个页面图标一对）
 *
 * 注意 .png 和 .bin 并存 —— Gradle 复制 assets 时只排除 .txt 后缀，没排除 .png。
 * 而 .bin 那批不是 restool 的产物，是 ace-loader 的 ImageCoverterPlugin
 * 在 webpack 阶段顺手做的（webpack.lite.config.js 第 185 行）。
 */

export const name = "generateReleaseBinSource";
export const produces = "js/release/source/lite/ 整个目录 + config.json";

export function run(taskContext) {
  const sourceRoot = path.join(taskContext.work, "js", "release", "source", "lite");
  // 注意：这里**不能** rmSync 整个目录。webpack（compileReleaseJsWithNode）已经把
  // assets/js/** 直接写进这个目录了，整体清空会把 81 个文件删掉 —— 之前 .bin 里
  // 只有 config.json 一个条目就是这个原因。要清理的只有 assets/entry，见第 2 段。
  fs.mkdirSync(sourceRoot, { recursive: true });

  // ── 第 1 段：config.json 加工。这部分已能跑 ──────────────────────────
  // 两处改动才能从 process 阶段的产物变成最终打进包的版本：
  //   1. abilities 里回填 iconId / labelId（从 R.txt 查出来）
  //   2. deviceType 清空后只写回 LITE_WEARABLE
  if (!taskContext.config) todo(name, "缺少 taskContext.config，必须先跑 mergeReleaseProfile");
  if (!taskContext.paths.rTxt) todo(name, "缺少 R.txt，必须先跑 compileReleaseResources");

  const rtable = parseRTable(fs.readFileSync(taskContext.paths.rTxt, "utf8"));
  const config = structuredClone(taskContext.config);
  fillResourceIds(config, rtable);

  if (config.module) {
    config.module.deviceType = ["liteWearable"];
  }

  // 写回 taskContext.config —— packageReleaseHap 打文件树形态时用的就是它。
  // 不写回的话那边拿到的是没回填 iconId / labelId 的版本，
  // 实测 config.json 少 39 B（module.abilities[0].iconId 缺失）。
  taskContext.config = config;

  const configOut = path.join(sourceRoot, "config.json");
  fs.writeFileSync(configOut, stringifyConfig(config));
  taskContext.paths.binSource = sourceRoot;
  taskContext.paths.binSourceConfig = configOut;

  // ── 第 2 段：复制 assets/entry ──────────────────────────────────────
  // 分工已经实测清楚（devdemo release 产物共 92 个文件）：
  //   assets/js/**    81 个  ← webpack 直接写在这个目录里，本任务不能碰
  //   assets/entry/** 10 个  ← 本任务负责
  //     8 个来自 restool 输出（resources.index + resources/ 整个目录，含 4 个 .key 和压缩后的 png）
  //     2 个来自图片转换（icon.bin / icon_small.bin）
  //   config.json      1 个  ← 上面已写
  //
  // 所以**不能整体清空 sourceRoot** —— 那会把 webpack 刚编好的 81 个文件删掉。
  // 只清理 assets/entry 这一块，避免重复运行时残留。
  fs.rmSync(path.join(sourceRoot, "assets", "entry"), { recursive: true, force: true });

  // 兜底：sourceRoot 根下只允许有 assets/ 和 config.json。
  // 早期的错误实现会把 webpack 产物写到根下（/app.js、/common/、/_releaseMap/ …），
  // 换到正确 buildDir 后这些老文件会残留，被打进 .bin 里变成多余条目。
  for (const ent of fs.readdirSync(sourceRoot)) {
    if (ent === "assets" || ent === "config.json") continue;
    fs.rmSync(path.join(sourceRoot, ent), { recursive: true, force: true });
  }

  const resOut = path.dirname(taskContext.paths.resources); // work/res/release/normal/lite
  const entryDir = path.join(sourceRoot, "assets", "entry");

  // a. restool 的 resources/ 整个目录 → assets/entry/resources/
  copyDir(path.join(resOut, "resources"), path.join(entryDir, "resources"));

  // b. restool 的 resources.index → assets/entry/resources.index
  fs.mkdirSync(entryDir, { recursive: true });
  fs.copyFileSync(taskContext.paths.resources, path.join(entryDir, "resources.index"));

  // c. 双后缀 .png.bin：Gradle 产物不带，但 API 8+ 真机可装包单/双后缀都出现过。
  //    先清掉 ace-loader 生成的，再给应用图标补一份双后缀副本，两种命名都覆盖。
  removeDoubleSuffixBin(sourceRoot);
  if (taskContext.layout === "hvigor") addIconDoubleSuffixBin(sourceRoot);

  return sourceRoot;
}

/**
 * 删掉形如 icon.png.bin 的双后缀文件
 * 依据 ace-loader/lib/lite/lite-image2bin.js：
 *   f = t.replace(/\.(png|jpg|jpeg|bmp)$/i, ".bin")   // 单后缀
 *   h = t + ".bin"                                     // 双后缀
 *   两个都 writeFileSync
 */
function removeDoubleSuffixBin(dir) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) removeDoubleSuffixBin(p);
    else if (/\.(png|jpg|jpeg|bmp)\.bin$/i.test(ent.name)) fs.rmSync(p, { force: true });
  }
}

/** 给应用图标的 BGRA 位图补一份 xxx.png.bin 双后缀副本（内容相同） */
function addIconDoubleSuffixBin(dir) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      addIconDoubleSuffixBin(p);
    } else if (/^icon(_small)?\.bin$/i.test(ent.name)) {
      const dbl = p.replace(/\.bin$/i, ".png.bin");
      if (!fs.existsSync(dbl)) fs.copyFileSync(p, dbl);
    }
  }
}

/** 递归复制目录，目标不存在就建 */
function copyDir(src, dest) {
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(dest, { recursive: true });
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, ent.name);
    const d = path.join(dest, ent.name);
    if (ent.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}
