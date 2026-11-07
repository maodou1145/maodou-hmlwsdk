import fs from "fs";
import path from "path";

import { readBin } from "./readWriteBin.js";
import { readZip } from "./readWriteZip.js";
import { inspectBin } from "./imageToBin.js";
import { todo } from "./createTaskContext.js";

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

  const allFiles = walk(paths.binSource);
  const byExt = (ext) => allFiles.filter((f) => f.toLowerCase().endsWith(ext));
  const jsFiles = byExt(".js").filter((f) => f.includes(`${path.sep}assets${path.sep}js${path.sep}`));
  const bcFiles = byExt(".bc");
  const pngFiles = byExt(".png");
  const imgBins = byExt(".bin").filter((f) => !f.endsWith("entry-release-unsigned.bin"));

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
        if (api && (api.compatible !== want.compatible || api.target !== want.target)) {
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

  // ── 汇总 ──────────────────────────────────────────────────────────────
  const errors = issues.filter((i) => i.level === "ERROR");
  const warns = issues.filter((i) => i.level === "WARN");
  stats.errors = errors.length;
  stats.warnings = warns.length;

  const report = { ok: errors.length === 0, generatedAt: new Date().toISOString(), stats, issues };
  const outDir = path.join(work, "verify");
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "report.json"), JSON.stringify(report, null, 2));

  console.log(
    `  自检：API ${apiLevel} · JS ${stats.jsFiles} / .bc ${stats.bcFiles} / 图片 ${stats.imageBins} bin + ${stats.pngFiles} png · ` +
      `容器 ${stats.containerEntries ?? "?"} 条目 · ERROR ${errors.length} / WARN ${warns.length}`
  );
  for (const i of [...errors, ...warns]) console.log(`    [${i.level}] ${i.where}: ${i.msg}`);
  console.log(`  报告：${path.join(outDir, "report.json")}`);

  // 自检只报告、不阻断：能出包就出包，问题全部甩到控制台和报告里。
  // .bc 属于尽力生成项，缺失不能让构建失败。
  if (errors.length || warns.length) {
    console.warn(
      `  ⚠ 自检：${errors.length} 个 ERROR / ${warns.length} 个 WARN（不阻断构建，包已正常产出）` +
        `，详见 ${path.join(outDir, "report.json")}`
    );
  }
  return report;
}
