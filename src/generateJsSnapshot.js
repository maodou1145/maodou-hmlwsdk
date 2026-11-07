import fs from "fs";
import path from "path";

/**
 * 把一个目录下所有 .js 编成同名 .bc（真机 JRRY v24 字节码）
 *
 * 为什么由本 SDK 自己干，而不是让 ace-loader 的 SnapshotPlugin 干：
 *   那个 plugin 的实现是 exec('"<ace-loader>/bin/jerry-snapshot.exe" generate -o ...')，
 *   exe 只有 Windows 版、属于 HarmonyOS SDK。这里换成 jerry-parser-wasm 在进程内生成，
 *   产物与那个 exe 逐字节一致（devdemo 22 个真实 bundle 实测）。
 *   ace-loader 侧的 SnapshotPlugin 已经用 --isPreview=true 关掉了，见 src/runWebpack.js。
 *
 * ★ best-effort（毛豆 2026-11-07）：能生成就生成，生成不了就跳过 + 甩一段警告，
 *   绝不让 .bc 失败拖垮整个构建。真机在 API 10+ 本来就能直接读 JS 源码，
 *   .bc 是加速项不是必需项。WASM 模块整体不可用（比如手机端缺失 / 架构不支持）
 *   时同样降级，只是把全部文件列进警告。
 *
 * 覆盖范围跟 SnapshotPlugin 对齐：它遍历 webpack assets 里所有 .js 生成 .bc，
 * 这里遍历构建目录下所有 .js —— webpack 的 assets 都会落盘，两者等价。
 *
 * 每个文件都要新建 wasm 实例：同一实例连续 callMain 会让 jerry 内部堆不清零，
 * 后续快照的字面量表字节会漂移（实测 22 个文件只有前 2 个正确）。细节见
 * src/jerry-parser-wasm/snapshotJs.js 的文件头注释。
 */

const IS_JS = /\.js$/i;

function collectJsFiles(dir, found = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) collectJsFiles(abs, found);
    else if (IS_JS.test(entry.name)) found.push(abs);
  }
  return found;
}

function warnSkipped(skipped, totalFiles) {
  if (!skipped.length) return;
  console.warn(
    `\n[bc] ⚠ 警告：${skipped.length}/${totalFiles} 个 JS 没能生成 .bc，已跳过，构建继续。\n` +
      `[bc]    设备仍可读 JS 源码；但 API < 10 的设备可能受影响，建议按下面原因修掉：\n` +
      skipped.map((s) => `[bc]      - ${path.basename(s.file)}：${s.reason}`).join("\n") +
      "\n"
  );
}

/**
 * @param {string} dir 构建产物目录（webpack 的 buildDir）
 * @returns {Promise<{count:number,totalFiles:number,totalBytes:number,files:string[],skipped:Array}>}
 */
export async function generateJsSnapshot(dir) {
  // 排序只为输出稳定，跟产物内容无关
  const files = collectJsFiles(dir).sort();
  const written = [];
  const skipped = [];
  let totalBytes = 0;

  if (!files.length) return { count: 0, totalFiles: 0, totalBytes: 0, files: [], skipped };

  // 动态 import：WASM 模块整体加载不了时也能降级，而不是让构建链在 import 阶段就崩
  let snapshotJs = null;
  let moduleError = null;
  try {
    ({ snapshotJs } = await import("./jerry-parser-wasm/snapshotJs.js"));
  } catch (e) {
    moduleError = String(e.message ?? e).split("\n")[0];
  }

  if (moduleError) {
    for (const file of files) skipped.push({ file, reason: `WASM 快照模块不可用：${moduleError}` });
    warnSkipped(skipped, files.length);
    return { count: 0, totalFiles: files.length, totalBytes: 0, files: [], skipped };
  }

  for (const file of files) {
    try {
      // snapshotJs 内部已经做过 JRRY v24 校验，拿到的一定是设备认的快照
      const bc = await snapshotJs(fs.readFileSync(file, "utf8"));
      fs.writeFileSync(file.replace(IS_JS, ".bc"), bc);
      totalBytes += bc.length;
      written.push(file);
    } catch (e) {
      skipped.push({ file, reason: String(e.message ?? e).split("\n")[0] });
    }
  }

  warnSkipped(skipped, files.length);
  return { count: written.length, totalFiles: files.length, totalBytes, files: written, skipped };
}
