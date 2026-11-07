import path from "path";

import { DEPENDS, findTask } from "./registerTasks.js";
import * as log from "./logger.js";

/**
 * 按需构建 —— 给一个入口任务名，只跑它依赖的那些，不是把 15 个从头扫一遍
 *
 * 跟 Gradle 的行为一致：`gradlew packageReleaseApp` 不会带出资源编译那条链，
 * 因为它不在依赖图里。
 *
 * 依赖数据在 src/registerTasks.js 的 DEPENDS 表里，出处是报告的 kids 字段。
 */

/**
 * 解析出执行顺序（拓扑排序，前置任务在前）
 * @param {string} target 入口任务名，例如 signReleaseApp
 * @returns {string[]}
 */
export function resolveOrder(target) {
  if (!DEPENDS[target]) {
    throw new Error(`没有这个任务：${target}\n可用的入口有：${Object.keys(DEPENDS).join(", ")}`);
  }

  const order = [];
  const done = new Set();
  const stack = new Set();

  function visit(name) {
    if (done.has(name)) return;
    if (stack.has(name)) throw new Error(`依赖成环了：${name}`);
    if (!DEPENDS[name]) throw new Error(`依赖表里缺这个任务：${name}`);

    stack.add(name);
    for (const dep of DEPENDS[name]) visit(dep);
    stack.delete(name);

    done.add(name);
    order.push(name);
  }

  visit(target);
  return order;
}

/**
 * 只算不跑，看某个入口会执行哪些任务
 * @returns {string[]}
 */
export function plan(target) {
  return resolveOrder(target);
}

/**
 * 真跑
 *
 * async：compileReleaseJsWithNode 要 await wasm 版的 jerry-snapshot 生成 .bc，
 * 所以任务函数允许返回 Promise，这里统一 await。同步任务照旧直接返回，不受影响。
 *
 * @param {object} taskContext 见 src/createTaskContext.js 的 createTaskContext
 * @param {string} target 入口任务名
 * @param {(line:string)=>void} [log] 进度回调，默认打控制台
 * @returns {{ok:boolean, results:Array, failedAt?:string}}
 */
export async function runBuild(taskContext, target, onDone = () => {}) {
  const order = resolveOrder(target);
  const results = [];
  const started = Date.now();

  log.info(`Build target: ${target} · ${order.length} tasks · work=${taskContext.work}`);

  for (const [i, name] of order.entries()) {
    const task = findTask(name);
    if (!task) {
      log.error(`依赖表里登记了 ${name}，但 registerTasks.js 里没有对应模块`);
      return { ok: false, results, failedAt: name };
    }

    log.taskStart(name, i + 1, order.length, task.produces);
    const before = { ...taskContext.paths };
    const t0 = Date.now();

    try {
      await task.run(taskContext);
      const ms = Date.now() - t0;
      results.push({ name, ok: true, ms });

      // 任务往 taskContext.paths 里登记了什么，就把它列出来（路径 + 体积），
      // 不用每个任务自己写日志，新增任务也自动有详情。
      for (const [key, value] of Object.entries(taskContext.paths)) {
        if (!value || value === before[key]) continue;
        log.detail(
          `  + ${key}: ${path.relative(taskContext.work, value)} (${log.describeArtifact(value)})`
        );
      }
      log.taskDone(name, ms);
    } catch (e) {
      const ms = Date.now() - t0;
      const full = String(e.message ?? e);
      results.push({ name, ok: false, ms, error: full });
      log.error(`Task :${name} FAILED after ${log.formatMs(ms)}`);
      // webpack / 子进程的报错是多行的，只打第一行等于把真正的原因吞掉
      for (const line of full.split("\n")) {
        if (line.trim()) log.error(`  ${line}`);
      }
      log.result(false, `BUILD FAILED in ${log.formatMs(Date.now() - started)}`);
      log.info(`${results.length}/${order.length} tasks · failed at :${name}`);
      onDone({ ok: false, failedAt: name, results });
      return { ok: false, results, failedAt: name };
    }
  }

  const total = Date.now() - started;
  log.result(true, `BUILD SUCCESSFUL in ${log.formatMs(total)}`);
  log.info(`${results.length} tasks executed · 0 failed`);
  onDone({ ok: true, results });
  return { ok: true, results };
}
