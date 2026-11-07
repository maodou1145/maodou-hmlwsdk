import fs from "fs";
import path from "path";

/**
 * 统一构建日志 —— 输出格式对齐 hvigor：
 *
 *   >maodouwsdk INFO  <msg>
 *   >maodouwsdk WARN  <msg>
 *   >maodouwsdk ERROR <msg>
 *   >maodouwsdk DEBUG <msg>      仅 --verbose
 *   >maodouwsdk       > Task :name [3/16]
 *   >maodouwsdk         Done :name in 120 ms
 *
 * 所有 SDK 自己的输出都走这里；子进程（webpack）的原始行也逐行转发并分级，
 * 避免构建过程中间一片空白、只在失败时才看到原因。
 */

export const PREFIX = ">maodouwsdk";
const LEVEL_WIDTH = 5;
const INDENT = " ".repeat(LEVEL_WIDTH);

let verbose = false;
let quiet = false;
let startedAt = 0;

export function configure(opts = {}) {
  verbose = Boolean(opts.verbose);
  quiet = Boolean(opts.quiet);
  startedAt = Date.now();
}

export function isVerbose() {
  return verbose;
}

export function elapsed() {
  return Date.now() - startedAt;
}

export function formatMs(ms) {
  if (ms < 1000) return `${ms} ms`;
  return `${Math.floor(ms / 1000)} s ${ms % 1000} ms`;
}

function emit(level, msg) {
  if (quiet && level !== "WARN" && level !== "ERROR") return;
  console.log(`${PREFIX} ${level.padEnd(LEVEL_WIDTH)} ${msg}`);
}

export function info(msg) {
  emit("INFO", msg);
}
export function warn(msg) {
  emit("WARN", msg);
}
export function error(msg) {
  emit("ERROR", msg);
}
export function debug(msg) {
  if (verbose) emit("DEBUG", msg);
}
/** 构建结果行：即使 --quiet 也输出，避免成功时看起来像没执行 */
export function result(ok, msg) {
  console.log(`${PREFIX} ${ok ? "INFO " : "ERROR"} ${msg}`);
}
/** 无级别前缀的续行，用于任务详情、产物清单 */
export function detail(msg) {
  if (!quiet) console.log(`${PREFIX} ${INDENT} ${msg}`);
}

export function taskStart(name, index, total, produces) {
  if (!quiet) console.log(`${PREFIX} ${INDENT} > Task :${name} [${index}/${total}]`);
  if (produces) debug(`produces: ${produces}`);
}

export function taskDone(name, ms) {
  detail(`  Done :${name} in ${formatMs(ms)}`);
}

/**
 * 逐行转发子进程输出，按内容分级。
 * COMPILE RESULT / ERROR 始终可见；loader 逐文件日志、NOTE、img2bin 只在 --verbose 展开。
 */
export function childOutput(text) {
  if (!text || quiet) return;
  let last = null;
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (!line.trim()) continue;
    const cleaned = line.replace(/\u001b\[[0-9;]*m/g, "").trim();
    if (/COMPILE RESULT:/.test(line)) {
      info(cleaned);
      last = "INFO";
    } else if (/\bERROR\b/.test(line)) {
      error(cleaned);
      last = "ERROR";
    } else if (/\bWARNING\b/.test(line)) {
      warn(cleaned);
      last = "WARN";
    } else if (/^\s+/.test(raw) && (last === "WARN" || last === "ERROR")) {
      // 缩进续行是上一条告警的正文（如「`box-sizing` is not ...」），
      // 跟着同级别输出，否则默认模式下只看到标题看不到原因。
      (last === "ERROR" ? error : warn)(cleaned);
    } else {
      debug(cleaned);
    }
  }
}

/** 描述一个产物路径：文件给字节数，目录给文件数与总字节 */
export function describeArtifact(p) {
  try {
    if (!fs.existsSync(p)) return "missing";
    const st = fs.statSync(p);
    if (st.isFile()) return `${st.size.toLocaleString()} B`;
    let count = 0;
    let bytes = 0;
    (function walk(dir) {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const f = path.join(dir, e.name);
        if (e.isDirectory()) walk(f);
        else {
          count++;
          bytes += fs.statSync(f).size;
        }
      }
    })(p);
    return `${count} files / ${bytes.toLocaleString()} B`;
  } catch {
    return "?";
  }
}
