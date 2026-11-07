import fs from "fs";
import path from "path";

/**
 * ace-loader 的按 API 级别兼容补丁（幂等、可回退、只影响 API 8+）
 *
 * 背景：src/ace-loader 是 api6 时代的 lite loader，CSS 校验器写死了
 *   SELECTOR_MATCHER=/^[\.#]?[A-Za-z0-9_\-:]+$/
 * 任何通用选择器 `*` 都会被当成 ERROR，导致
 *   COMPILE RESULT:FAIL {"ERROR":1}
 * 而 API 8+（hvigor）工程里 `* { box-sizing: border-box; }` 是常见写法，
 * 真机 Lite 引擎同样不支持这条规则，但构建不该因此中断。
 *
 * 做法：API >= 8 时把 `*` 加进允许集合。校验通过后，该规则里的
 * box-sizing 本来就会被 validator 判为「非标准属性」丢掉，最终只留下一个空
 * 样式对象，不会改变有效样式，也不影响 API 6 工程的字节一致性。
 *
 * 为什么不改用户源码 / 不复制源码目录：源码是只读输入，复制目录会让
 * manifest.pages、资源相对路径全部跟着变，风险比放宽一个正则大得多。
 *
 * 补丁写在 ace-loader 自己的目录里（它本来就是本 SDK 专用的改造副本），
 * 首次应用前留一份 .orig 备份，重复运行不会叠加。
 */

const STYLER = path.join("lib", "styler", "index.js");
const ORIGINAL = "SELECTOR_MATCHER=/^[\\.#]?[A-Za-z0-9_\\-:]+$/";
const RELAXED = "SELECTOR_MATCHER=/^[\\.#]?[A-Za-z0-9_\\-:]+$|^\\*$/";

/** 备份放到 hmlwsdk/tmp/（已 gitignore），别在 ace-loader 子模块里留 untracked 文件 */
function backupPath(aceLoaderDir) {
  const sdkRoot = path.resolve(aceLoaderDir, "..", "..");
  return path.join(sdkRoot, "tmp", "ace-loader-styler.orig.js");
}

/**
 * @param {string} aceLoaderDir ace-loader 根目录
 * @param {object} [opts]
 * @param {number} [opts.apiLevel] 目标 API 级别，< 8 时不动
 * @param {(line:string)=>void} [opts.log]
 * @returns {boolean} 是否处于/已应用宽松模式
 */
export function ensureCssCompat(aceLoaderDir, opts = {}) {
  const apiLevel = Number(opts.apiLevel ?? 0);
  const log = opts.log ?? (() => {});
  const file = path.join(aceLoaderDir, STYLER);

  // 补丁是持久写在文件上的，低版本工程必须还原，否则一次 API 10 构建之后
  // 所有 API 6 工程都会悄悄用上宽松校验。
  if (!(apiLevel >= 8)) {
    if (fs.existsSync(backupPath(aceLoaderDir))) {
      restoreCssCompat(aceLoaderDir);
      log("[compat] API < 8：已还原 ace-loader 的原始 CSS 校验器");
    }
    return false;
  }

  if (!fs.existsSync(file)) {
    throw new Error(`找不到 ace-loader 的 CSS 校验器：${file}`);
  }

  let src = fs.readFileSync(file, "utf8");

  if (src.includes(RELAXED)) return true; // 已打过，幂等
  if (!src.includes(ORIGINAL)) {
    throw new Error(
      `${file} 里的 SELECTOR_MATCHER 不是预期的 api6 写法，兼容补丁拒绝盲改。` +
        `请检查 ace-loader 版本，或用 --api-level 6 跳过放宽。`
    );
  }

  const backup = backupPath(aceLoaderDir);
  if (!fs.existsSync(backup)) {
    fs.mkdirSync(path.dirname(backup), { recursive: true });
    fs.writeFileSync(backup, src);
  }

  src = src.replace(ORIGINAL, RELAXED);
  fs.writeFileSync(file, src);
  log(`[compat] API ${apiLevel}：已放宽 ace-loader 的 CSS 通用选择器校验（备份 tmp/${path.basename(backup)}）`);
  return true;
}

/** 撤销补丁，回到 api6 原始校验（用于回归对比） */
export function restoreCssCompat(aceLoaderDir) {
  const file = path.join(aceLoaderDir, STYLER);
  const backup = backupPath(aceLoaderDir);
  if (!fs.existsSync(backup)) return false;
  fs.writeFileSync(file, fs.readFileSync(backup));
  return true;
}
