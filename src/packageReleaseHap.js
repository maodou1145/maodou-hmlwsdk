import fs from "fs";
import path from "path";

import { packHap } from "./packHap.js";
import { writeZip } from "./readWriteZip.js";
import { stringifyConfigMinified } from "./processConfig.js";
import { collect, sortEntries } from "./generateReleaseJsBin.js";
import { todo } from "./createTaskContext.js";
import * as log from "./logger.js";

/**
 * packageReleaseHap —— 出 hap（release 变体要出两种形态）
 *
 * 依据（反编译 SingleLiteOptionsBuilder.executePack + AppVariantEvaluator.evaluateIsNeedPack）：
 *   if (isLiteWearable) {
 *       先跑 binBuilder 出 .bin 形态              ← 一定走
 *       if (isNeedPackage()) 再跑 jsBundleBuilder 出文件树形态
 *   }
 *   isNeedPackage = (buildType.name == selectedBuildType.name)，默认选中 RELEASE
 *
 * 实测两种产物的区别（devdemo release，同一份源码）：
 *
 *   entry-bin-release-lite-unsigned.hap   2293964 B
 *     └─ 只有一个条目：entry-release-unsigned.bin（2293792 B），stored 不压缩
 *
 *   entry-release-lite-unsigned.hap       2304041 B
 *     └─ 92 个条目，全部 stored（method=0），无目录条目
 *        条目名就是 source/lite 下的相对路径
 *        但 config.json 是 1935 B 的**紧凑单行版**，不是 source/lite 里那个 3422 B 的缩进版
 *
 * 这两种 hap 谁会进 .app：PackageApp.getHapPathFiles() 会过滤掉「文件名含 -bin- 且
 * deviceType 含 liteWearable」的，所以 .bin 形态进不了 .app，只有文件树形态进得去。
 *
 * 图片素材择一：Lite 运行时对图片格式的支持随 API 级别变化 ——
 *   API < 10  只加载 BGRA 位图（.bin），.png 是给预览器/工具看的副本
 *   API >= 10 可直接读 .png，删除 .bin 不影响显示
 * 但「不影响显示」不等于「不影响安装」：resources.index 里登记的资源在安装期
 * 仍会按 .bin 校验，实测只留 .png 的包会安装失败。所以默认统一删 .png 留 .bin，
 * 与所有实测可装包一致；`--strip-images bin` 仍可手动指定，但会给出警告。
 * 只过滤 zip 条目：磁盘上的中间产物、工程源码里的图片、以及 .bin 容器都保持原样，
 * 这样 .bin 容器的字节基准不被改动，也能随时用 --strip-images none 对照。
 */

export const name = "packageReleaseHap";
export const produces = "hap/release/entry-bin-release-lite-unsigned.hap + entry-release-lite-unsigned.hap";

export function run(taskContext) {
  if (!taskContext.paths.unsignedBin && !taskContext.paths.signedBin) todo(name, "缺少 .bin，必须先跑 generateReleaseJsBin");

  const binPath = taskContext.paths.signedBin ?? taskContext.paths.unsignedBin;
  const outDir = path.join(taskContext.work, "hap", "release");
  fs.mkdirSync(outDir, { recursive: true });

  // ── 形态一：单 .bin ────────────────────────────────────────────────
  const binHap = path.join(outDir, "entry-bin-release-lite-unsigned.hap");
  fs.writeFileSync(binHap, packHap(fs.readFileSync(binPath), path.basename(binPath)));
  taskContext.paths.hap = binHap;

  // ── 形态二：文件树 ────────────────────────────────────────────────
  // isNeedPackage() 在 release 下为 true；调用方可以传 taskContext.needPackage = false 显式关掉
  if (taskContext.needPackage !== false) {
    if (!taskContext.paths.binSource) todo(name, "缺少 binSource 目录，必须先跑 generateReleaseBinSource");
    if (!taskContext.config) todo(name, "缺少 taskContext.config");

    const treeHap = path.join(outDir, "entry-release-lite-unsigned.hap");
    fs.writeFileSync(treeHap, packTreeHap(taskContext));
    taskContext.paths.treeHap = treeHap;
  }

  return outDir;
}

/**
 * 决定 treeHap 里要剔除哪一类图片，返回要删掉的扩展名（不含点），null = 都保留。
 *
 *   auto（默认）→ 统一删 .png 留 .bin；腕上钓鱼 / wanlian / dice10 三个真机可装包
 *                的容器里一个 .png 都没有，只有 .bin，所以按 .bin 为准
 *   png         → 强制删 .png 留 .bin（同 auto）
 *   bin         → 强制删 .bin 留 .png；API 10+ 设备可直读 PNG，API<10 会缺图
 *   none        → 两种都保留，包体最大
 *
 * 注意 `.png.bin` 双后缀：删 .png 时它因为以 .bin 结尾会被保留，这是期望行为。
 */
export function resolveStripPolicy(taskContext) {
  const p = taskContext.stripImages ?? "auto";
  if (p === "none") return null;
  if (p === "png" || p === "bin") return p;
  if (p === "auto") return "png";
  throw new Error(`未知的 --strip-images 策略：${p}`);
}

/**
 * 应用图标不参与图片择一，png 与 bin 一律都留。
 *
 * 依据 腕上钓鱼官方可装包：media 里 icon.png(4428) + icon.bin(51992) +
 * icon_small.png(2834) + icon_small.bin(25608)，双份齐全。实测把 icon.png 删掉、
 * 只剩 icon.bin 的包装表直接报「40.配置文件格式错误」——图标是安装期校验项，
 * 不能按普通素材处理。
 */
const APP_ICON_RE = /\/base\/media\/icon(_small)?\.(png|bin)$/i;

function isAppIcon(entry) {
  const full = ((entry.relPath || "").replace(/^\//, "") + "/" + entry.fileName).replace(/^\//, "");
  return APP_ICON_RE.test(full.startsWith("/") ? full : "/" + full);
}

/**
 * 把 source/lite 整个目录打成 hap
 *
 * 唯一的加工点：config.json 换成紧凑单行版。里面其它文件原样塞进去。
 * 图片择一在这里过滤条目，不删磁盘文件；应用图标是例外，永远双份保留。
 */
function packTreeHap(taskContext) {
  const { config, paths } = taskContext;
  const strip = resolveStripPolicy(taskContext);
  const all = sortEntries(collect(paths.binSource));
  const kept = strip
    ? all.filter((e) => !e.fileName.toLowerCase().endsWith("." + strip) || isAppIcon(e))
    : all;
  const keptIcons = strip ? all.filter((e) => isAppIcon(e)).length : 0;

  if (strip) {
    log.info(
      `strip-images=${taskContext.stripImages ?? "auto"} → 剔除 .${strip} ` +
        `${all.length - kept.length} 个条目，treeHap 保留 ${kept.length} 个` +
        (keptIcons ? `（其中 ${keptIcons} 个应用图标不参与择一）` : "")
    );
  }

  const entries = kept.map((e) => {
    const full = ((e.relPath || "").replace(/^\//, "") + "/" + e.fileName).replace(/^\//, "");

    let content = e.content;
    // config.json 在 hap 里是紧凑格式（实测 1935 B vs 缩进版 3422 B）
    if (full === "config.json") {
      content = Buffer.from(stringifyConfigMinified(config));
    } else if (/^assets\/js\/[^/]+\/manifest\.json$/.test(full)) {
      // manifest.json 在 hap 里同样是紧凑格式（实测 1051 B vs 缩进版 1316 B）
      content = Buffer.from(stringifyConfigMinified(JSON.parse(e.content.toString("utf8"))));
    }

    return { name: full, content };
  });

  // 全部 stored，不压缩（实测 Gradle 产物 92 个条目 method 全是 0）
  return writeZip(entries, { compress: false });
}
