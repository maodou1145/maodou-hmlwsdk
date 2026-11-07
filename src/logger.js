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
  // 进度：已跑 / 总数 + 百分比，长链构建时一眼看出还剩多少
  const pct = total ? Math.round((index / total) * 100) : 0;
  if (!quiet) console.log(`${PREFIX} ${INDENT} > Task :${name} [${index}/${total} · ${pct}%]`);
  if (produces) debug(`produces: ${produces}`);
}

export function taskDone(name, ms) {
  detail(`  Done :${name} in ${formatMs(ms)}`);
}

/**
 * 逐行分类（流式）—— 子进程输出一行一行地来，这里给出分级与「缩进续行」处理。
 * 返回一个「喂一行」的函数，回调之间保留上一条的级别状态。
 * COMPILE RESULT / ERROR / WARNING 立刻可见，其余走 DEBUG。
 */
export function childLineStream() {
  let last = null;
  return (raw) => {
    const line = String(raw).trimEnd();
    if (!line.trim()) return;
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
    } else if (/^\s+/.test(line) && (last === "WARN" || last === "ERROR")) {
      // 缩进续行是上一条告警的正文（如「`box-sizing` is not ...」），
      // 跟着同级别输出，否则默认模式下只看到标题看不到原因。
      (last === "ERROR" ? error : warn)(cleaned);
    } else {
      debug(cleaned);
    }
  };
}

/** 逐行转发一段已经拿到的子进程输出（同步场景用） */
export function childOutput(text) {
  if (!text || quiet) return;
  const feed = childLineStream();
  for (const raw of String(text).split(/\r?\n/)) feed(raw);
}

/**
 * 长任务心跳 —— 让「十几秒不出声」的步骤也有实时进度。
 *
 * 每 intervalMs 打一行「运行中 · 已用 x s」。任务结束时调用返回的 stop()，
 * 否则定时器会一直挂着（已 unref，不阻止进程退出，但仍应显式停掉）。
 *
 * @param {string} label 显示用的标签，例如 `Task :compileReleaseJsWithNode`
 * @param {number} [intervalMs] 心跳间隔，默认 3000 ms
 * @returns {() => void} 停止函数
 */
export function startTicker(label, intervalMs = 3000) {
  if (quiet) return () => {};
  const t0 = Date.now();
  const timer = setInterval(() => {
    info(`… ${label} 运行中 · 已用 ${formatMs(Date.now() - t0)}`);
  }, intervalMs);
  if (timer.unref) timer.unref();
  return () => clearInterval(timer);
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
