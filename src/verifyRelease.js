import fs from "fs";
import path from "path";

import { readBin } from "./readWriteBin.js";
import { readZip } from "./readWriteZip.js";
import { inspectBin } from "./imageToBin.js";
import { todo } from "./createTaskContext.js";
import * as log from "./logger.js";

/**
 * 轻量校验 .bc 头（不 import WASM 模块，保证自检器在 WASM 不可用时也能跑）
 * 设备只认魔数 JRRY + version 24。
 */
function checkBcHeader(buf) {
  if (!buf || buf.length < 8) return ".bc 太短，读不出头";
  if (buf.readUInt32BE(0) !== 0x4a525259) return "缺 JRRY 魔数";
  const v = buf.readUInt32LE(4);
  if (v !== 24) return `版本 v${v}，设备只认 v24`;
  return null;
}

/**
 * verifyRelease —— 出包后的结构化自检
 *
 * 作为独立入口任务：verifyRelease → signReleaseApp → ... 整条链，跑完自动校验。
 *   node bin/hmlwsdk.js verifyRelease <工程目录>
 *
 * Lite Wearable 运行时的三条已知行为：
 *
 *   1. 设备固定加载 pages/index/index 作为首页，config.json 里配置的首页不生效。
 *      pages 缺少这一项会导致真机黑屏，判 ERROR。
 *
 *   2. JS 48KB 不是硬性限制，只对 API < 10 的运行有影响；
 *      因此这里只统计体积，不判错。
 *
 *   3. API 10+ 可直接读 PNG，删除图片 .bin 不影响显示；
 *      所以图片 .bin 在 API 10+ 可选（存在时校验格式头）。
 *
 *   .bc 采用 best-effort 策略：构建链尽力生成（见 generateJsSnapshot.js），
 *   自检对缺失 / 空文件 / 魔数异常一律只报 WARN，不阻断构建。
 *
 * 其余检查：.bin 私有容器可解析且包名一致、.app 只含 hap + pack.info、
 * config.json 与 pack.info 的 apiVersion 一致、存在的文件格式头正确。
 */

export const name = "verifyRelease";
export const produces = "verify/report.json";

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

function collectIssues() {
  const issues = [];
  return {
    issues,
    error: (where, msg) => issues.push({ level: "ERROR", where, msg }),
    warn: (where, msg) => issues.push({ level: "WARN", where, msg }),
    info: (where, msg) => issues.push({ level: "INFO", where, msg })
  };
}

export function run(taskContext) {
  const { config, paths, apiLevel, work } = taskContext;
  if (!config) todo(name, "缺少 taskContext.config");
  if (!paths.binSource) todo(name, "缺少 binSource 目录");

  // .bc 全版本硬要求；只有图片 .bin 在 API 10+ 是可选的
  const needImageBin = apiLevel < 10;
  const { issues, error, warn, info } = collectIssues();
  const stats = { apiLevel, bcRequired: "best-effort", imageBinRequired: needImageBin };

  // ── 1. 首页必须是 pages/index/index（硬规则，config 配置无效） ──────────
  const jsModules = config.module?.js ?? [];
  for (const comp of jsModules) {
    const pages = comp.pages ?? [];
    const idx = pages.indexOf("pages/index/index");
    if (idx === -1) {
      error(
        `module.js[${comp.name}].pages`,
        "缺少 pages/index/index —— 设备固定加载这个首页，config.json 里配任何首页都无效，真机会黑屏"
      );
    } else if (idx !== 0) {
      warn(`module.js[${comp.name}].pages`, `pages/index/index 在第 ${idx + 1} 项，建议放首位`);
    }
  }

  // Hvigor 包缺这几个 module 字段时，安装期会报错误码 40（配置文件格式错误）
  if (taskContext.layout === "hvigor") {
    for (const key of ["mainAbility", "package", "distroFilter"]) {
      if (config.module?.[key] === undefined) {
        warn("config.json", `缺 module.${key}，安装可能出现「40.配置文件格式错误」`);
      }
    }
  }

  const allFiles = walk(paths.binSource);
  const byExt = (ext) => allFiles.filter((f) => f.toLowerCase().endsWith(ext));
  const jsFiles = byExt(".js").filter((f) => f.includes(`${path.sep}assets${path.sep}js${path.sep}`));
  const bcFiles = byExt(".bc");
  const pngFiles = byExt(".png");
  const imgBins = byExt(".bin").filter((f) => !f.endsWith("entry-release-unsigned.bin"));

  // ── 1b. config 里登记的页面，产物里必须真的存在 ───────────────────────
  // 构建期 resolveProject 已经拦「源码里没有」的页面；这里再查一遍「打包后有没有落地」，
  // 因为漏掉这一步就会产出幽灵页面：manifest.json 声明了该页，包里却没有它的文件，
  // 构建全绿、真机跳过去白屏。
  const pageOwners = (taskContext.components?.length
    ? taskContext.components.map((c) => ({ buildName: c.buildName, pages: c.pages ?? [] }))
    : jsModules.map((c) => ({ buildName: String(c.name).replace(/^\./, ""), pages: c.pages ?? [] }))
  );
  for (const { buildName, pages } of pageOwners) {
    for (const page of pages) {
      const base = path.join(paths.binSource, "assets", "js", buildName, ...String(page).split("/"));
      if (!fs.existsSync(base + ".js")) {
        // Hvigor（API 8+）按原版行为判 ERROR；老 Gradle 链路不校验页面存在性
        // （官方 devdemo 带 3 个这种登记，真机照常能跑），只告警
        const hit = taskContext.layout === "hvigor" ? error : warn;
        hit(
          "pages",
          `"${page}" 在产物里没有 .js（幽灵页面：manifest 声明了它，包里却没有，真机跳过去白屏）` +
            (taskContext.layout === "hvigor" ? "" : " —— Gradle 布局只告警")
        );
      } else if (!fs.existsSync(base + ".bc")) {
        warn("pages", `"${page}" 没有 .bc，走 JS 源码解释执行`);
      }
    }
  }

  // ── 2. .bc 快照：best-effort，一律只警告、不阻断构建 ───────────────────
  stats.jsFiles = jsFiles.length;
  stats.bcFiles = bcFiles.length;
  const missingBc = jsFiles.filter((f) => !fs.existsSync(f.replace(/\.js$/i, ".bc")));
  stats.bcMissing = missingBc.length;
  stats.bcInvalid = 0;
  if (missingBc.length) {
    warn(
      "assets/js/**",
      `${missingBc.length}/${jsFiles.length} 个 JS 没有 .bc，已跳过（设备仍可读 JS 源码）：` +
        missingBc.slice(0, 5).map((f) => path.basename(f)).join(", ") +
        (missingBc.length > 5 ? ` …另 ${missingBc.length - 5} 个` : "")
    );
  }
  const orphanBc = bcFiles.filter((f) => !fs.existsSync(f.replace(/\.bc$/i, ".js")));
  if (orphanBc.length) warn("assets/js/**", `${orphanBc.length} 个 .bc 没有对应 .js`);
  stats.bcTotalBytes = 0;
  for (const bc of bcFiles) {
    const buf = fs.readFileSync(bc);
    stats.bcTotalBytes += buf.length;
    const reason = checkBcHeader(buf);
    if (reason) {
      stats.bcInvalid++;
      warn(path.relative(paths.binSource, bc), `${reason}（这个 .bc 不生效，构建继续）`);
    }
  }

  // ── 3. 图片 .bin：API 10+ 可读 png，API < 10 必需 ─────────────────────
  stats.pngFiles = pngFiles.length;
  stats.imageBins = imgBins.length;
  const missingImgBin = pngFiles.filter((f) => !fs.existsSync(f.replace(/\.png$/i, ".bin")));
  if (needImageBin && missingImgBin.length) {
    error("assets/**", `API ${apiLevel} 只读图片 .bin，缺 ${missingImgBin.length} 个，例如 ${path.basename(missingImgBin[0])}`);
  } else if (!needImageBin) {
    info("assets/**", `API ${apiLevel} 可直接读 png：现有 ${imgBins.length} 个 .bin，缺 ${missingImgBin.length} 个不影响显示`);
  }
  for (const bin of imgBins) {
    const r = inspectBin(fs.readFileSync(bin));
    if (!r.ok) error(path.relative(paths.binSource, bin), `图片 .bin 格式异常：${JSON.stringify(r)}`);
  }
  stats.imageBinSizes = [...new Set(imgBins.map((f) => { const r = inspectBin(fs.readFileSync(f)); return `${r.width}x${r.height}`; }))];

  // ── 4. JS 体积只统计不判错（48KB 非硬性需求） ─────────────────────────
  const big = jsFiles
    .map((f) => ({ f, n: fs.statSync(f).size }))
    .filter((x) => x.n > 48 * 1024)
    .sort((a, b) => b.n - a.n);
  stats.largestJsBytes = big[0]?.n ?? Math.max(0, ...jsFiles.map((f) => fs.statSync(f).size));
  stats.jsOver48KB = big.length;
  if (big.length) {
    info("assets/js/**", `${big.length} 个 JS 超过 48KB（最大 ${big[0].n} B）——非硬性限制，仅影响 API<10 设备`);
  }

  // ── 5. .bin 私有容器 ──────────────────────────────────────────────────
  const binPath = paths.signedBin ?? paths.unsignedBin;
  if (binPath && fs.existsSync(binPath)) {
    try {
      const parsed = readBin(fs.readFileSync(binPath));
      stats.containerEntries = parsed.entries.length;
      stats.containerMagic = "0x" + parsed.magic.toString(16);
      if (parsed.magic !== 0xbe) error(path.basename(binPath), `容器 magic 是 0x${parsed.magic.toString(16)}，应为 0xbe`);
      if (parsed.bundleName !== config.app.bundleName) {
        error(path.basename(binPath), `bundleName 不一致：${parsed.bundleName} vs ${config.app.bundleName}`);
      }
      if (!parsed.entries.length) error(path.basename(binPath), "容器里一个条目都没有");
    } catch (e) {
      error(path.basename(binPath), `解析失败：${e.message}`);
    }
  } else {
    error("bin/release", "没有 .bin 容器产物");
  }

  // ── 6. .app 与 pack.info ──────────────────────────────────────────────
  if (paths.app && fs.existsSync(paths.app)) {
    try {
      const entries = readZip(fs.readFileSync(paths.app));
      stats.appEntries = entries.map((e) => e.name);
      const names = entries.map((e) => e.name).sort();
      if (names.length !== 2 || !names.includes("pack.info") || !names.some((n) => n.endsWith(".hap"))) {
        error(path.basename(paths.app), `.app 条目应为 hap + pack.info，实际 ${JSON.stringify(names)}`);
      }
      const pack = entries.find((e) => e.name === "pack.info");
      if (pack) {
        const api = JSON.parse(pack.content.toString("utf8")).summary?.modules?.[0]?.apiVersion;
        const want = config.app.apiVersion;
        // Hvigor 工程的 pack.info.modules[].apiVersion 是空对象（真包实测），不参与比对
        if (api && Object.keys(api).length && (api.compatible !== want.compatible || api.target !== want.target)) {
          error("pack.info", `apiVersion ${JSON.stringify(api)} 与 config.json 的 ${JSON.stringify(want)} 不一致`);
        }
        stats.packInfoApiVersion = api;
      }
    } catch (e) {
      error(path.basename(paths.app), `解析失败：${e.message}`);
    }
  } else {
    error("app/release", "没有 .app 产物（verifyRelease 要挂在 signReleaseApp 之后）");
  }

  // ── 7. treeHap 图片素材择一是否生效 ───────────────────────────────────
  if (paths.treeHap && fs.existsSync(paths.treeHap)) {
    const ents = readZip(fs.readFileSync(paths.treeHap));
    const names = ents.map((e) => e.name);
    const png = names.filter((n) => n.toLowerCase().endsWith(".png")).length;
    const bin = names.filter((n) => n.endsWith(".bin")).length;
    stats.treeHapImages = { png, bin, policy: taskContext.stripImages ?? "auto" };
    if (png > 0 && bin === 0) {
      const msg = `treeHap 里只有 .png、没有任何图片 .bin（strip-images=${stats.treeHapImages.policy}）`;
      if (apiLevel < 10) error("treeHap", `${msg} —— API ${apiLevel} 设备只读 .bin，图会全丢`);
      else info("treeHap", `${msg} —— API 10+ 可直读 png，能显示`);
    }
    info(
      "treeHap",
      png > 0 && bin > 0
        ? `图片素材双份保留（.png ${png} / .bin ${bin}）`
        : `图片素材已择一（.png ${png} / .bin ${bin}）`
    );

    // 应用图标：校验「实际打进 hap 的条目」，不是磁盘上的中间产物。
    // 磁盘齐全但打包时被 strip 掉，装表照样报 40——这层必须查 hap 本体。
    // 只对 Hvigor 包要求双份：Gradle（API<10）设备只读 .bin，图标 png 允许被择一删掉。
    if (taskContext.layout === "hvigor") {
      for (const stem of ["icon", "icon_small"]) {
        const hasPng = names.some((n) => new RegExp(`/base/media/${stem}\\.png$`).test(n));
        const hasBin = names.some((n) => new RegExp(`/base/media/${stem}\\.(png\\.)?bin$`).test(n));
        if (!hasPng || !hasBin) {
          error(
            "treeHap",
            `${stem} 在 hap 里 png=${hasPng} bin=${hasBin} —— 官方 GM 包是双份，缺一个装表报「40.配置文件格式错误」`
          );
        }
      }
    }
    const idx = ents.find((e) => /resources\.index$/.test(e.name));
    if (!idx) {
      error("treeHap", "hap 里没有 resources.index");
    } else {
      const t = idx.content.toString("latin1");
      for (const stem of ["icon", "icon_small"]) {
        if (!new RegExp(`${stem}\\.png`, "i").test(t)) {
          error("treeHap", `hap 内的 resources.index 没登记 ${stem}.png`);
        }
      }
    }
  }

  // Hvigor 应用图标：资源表登记 + 两种尺寸，缺任何一个都装不上（错误码 40）
  // 注意：这里查的是磁盘上的 binSource，不受 --strip-images 影响（那个只挑 treeHap 条目）
  if (taskContext.layout === "hvigor") {
    const media = allFiles.filter((f) => f.replace(/\\/g, "/").includes("base/media"));
    for (const [stem, [w, h]] of Object.entries({ icon: [114, 114], icon_small: [80, 80] })) {
      const png = media.find((p) => path.basename(p).toLowerCase() === stem + ".png");
      const bin = media.find((p) => path.basename(p).toLowerCase() === stem + ".bin");
      if (!png && !bin) {
        error("app icons", `缺 ${stem}.png / ${stem}.bin —— 安装会报「40.配置文件格式错误」`);
        continue;
      }
      if (png) {
        const b = fs.readFileSync(png);
        const isPng = b.length > 24 && b.readUInt32BE(0) === 0x89504e47;
        const pw = isPng ? b.readUInt32BE(16) : 0;
        const ph = isPng ? b.readUInt32BE(20) : 0;
        if (!isPng) error("app icons", `${stem}.png 不是合法 PNG`);
        else if (pw !== w || ph !== h) error("app icons", `${stem}.png 应为 ${w}x${h}，实际 ${pw}x${ph}`);
      }
      if (bin) {
        const r = inspectBin(fs.readFileSync(bin));
        if (!r.ok || r.width !== w || r.height !== h) {
          error("app icons", `${stem}.bin 应为 ${w}x${h}，实际 ${r.width}x${r.height}`);
        }
      }
    }
    const ri = allFiles.find((f) => f.endsWith("resources.index"));
    if (!ri) {
      error("resources.index", "产物里没有 resources.index");
    } else {
      const text = fs.readFileSync(ri).toString("latin1");
      for (const name of ["icon", "icon_small"]) {
        if (!new RegExp(`${name}\\.png`, "i").test(text)) {
          error("resources.index", `没有登记 ${name}.png，安装会报「40.配置文件格式错误」`);
        }
      }
    }
  }

  // ── 汇总 ──────────────────────────────────────────────────────────────
  const errors = issues.filter((i) => i.level === "ERROR");
  const warns = issues.filter((i) => i.level === "WARN");
  stats.errors = errors.length;
  stats.warnings = warns.length;

  const report = { ok: errors.length === 0, generatedAt: new Date().toISOString(), stats, issues };
  const outDir = path.join(work, "verify");
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "report.json"), JSON.stringify(report, null, 2));

  log.info(
    `Verify API ${apiLevel} · JS ${stats.jsFiles} / .bc ${stats.bcFiles} / ` +
      `treeHap images png=${stats.treeHapImages?.png ?? "?"} bin=${stats.treeHapImages?.bin ?? "?"} · ` +
      `container ${stats.containerEntries ?? "?"} entries · ERROR ${errors.length} / WARN ${warns.length}`
  );
  for (const i of [...errors, ...warns]) {
    const line = `  [${i.level}] ${i.where}: ${i.msg}`;
    if (i.level === "ERROR") log.error(line);
    else log.warn(line);
  }
  log.detail(`  report: ${path.join(outDir, "report.json")}`);

  // 自检结论：任务层不抛异常（能出包就出包），但 CLI 按报告里的 ERROR 以退出码 1 结束，
  // 避免「真机黑屏的包」在 CI 里被判成功。.bc 属尽力生成项，只算 WARN，不会改变退出码。
  const reportFile = path.join(outDir, "report.json");
  if (errors.length) {
    log.error(
      `Verify found ${errors.length} ERROR / ${warns.length} WARN — 产物已生成，但 CLI 退出码为非 0，` +
        `see ${reportFile}`
    );
  } else if (warns.length) {
    log.warn(`Verify found 0 ERROR / ${warns.length} WARN — 不影响出包，see ${reportFile}`);
  }
  return report;
}
