import fs from "fs";
import path from "path";
import { spawnSync } from "child_process";
import { createHash } from "crypto";
import { fileURLToPath } from "url";

import * as log from "./logger.js";

/**
 * reviewRelease —— 把外部 skill 自带的评审脚本接进构建链
 *
 * 只做三件事：找到脚本 → 跑它 → 把发现的问题降级成 WARN 打出来。
 * 刻意不做的事：
 *   - 不抛异常（脚本缺失、退出码非 0、输出格式变化都只是警告）
 *   - 不参与退出码（结果写在 <work>/review/report.json，verifyRelease 的 report
 *     里没有它，所以 --strict 也不会因评审而失败）
 *   - 不把评审结果当「确定缺陷」，只报「警告 / 提示」，改不改由人判断
 *   - 同一份脚本只跑一次（两个 skill 共用一份 cli.js 时去重）
 *
 * 脚本来源（按顺序找，第一个命中的生效）：
 *   1. 环境变量 HMLWSDK_SKILLS（用 path.delimiter 分隔的多个 skill 根目录）
 *   2. <SDK>/reviewers            （把 skill 的评审脚本拷进来即可随仓库分发）
 *   3. <SDK>/../skills            （与 SDK 并排的 skills 目录）
 *   4. /skills                    （本机安装的 skill）
 */

export const name = "reviewRelease";
export const produces = "review/report.json";

// 已知 skill 的评审脚本登记表
//   node → 用 process.execPath 跑 .js
//   ps1  → 找 pwsh / powershell 跑 .ps1（本机没有就跳过并警告）
//   auto → 在 rel 目录下自动找 *review*/*audit*/*check* 的 .js 或 .ps1
const REGISTRY = [
  { id: "huawei-lite-watch-development", kind: "ps1", rel: "scripts/audit_lite_watch_project.ps1" },
  { id: "hmlwsim", kind: "auto", rel: "scripts" },
  { id: "hmlwskill", kind: "node", rel: "scripts/project-reviewer/cli.js" },
  { id: "litewearable-api10-dev", kind: "node", rel: "scripts/project-reviewer/cli.js" }
];

const SDK_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LEVEL_RE = /\[(RELEASE BLOCKER|ERROR|WARN|INFO|PASS)\]/i;
const MAX_SHOWN = 8;

function skillRoots() {
  const roots = [];
  const env = process.env.HMLWSDK_SKILLS;
  if (env) roots.push(...env.split(path.delimiter).filter(Boolean));
  roots.push(path.join(SDK_ROOT, "reviewers"));
  roots.push(path.join(SDK_ROOT, "..", "skills"));
  roots.push("/skills");
  return [...new Set(roots)].filter((r) => fs.existsSync(r));
}

/** 探测可用脚本；wanted 非空时只保留点名的 id */
function discover(wanted) {
  const roots = skillRoots();
  const out = [];
  for (const spec of REGISTRY) {
    if (wanted.length && !wanted.includes(spec.id)) continue;
    for (const root of roots) {
      const skillDir = path.join(root, spec.id);
      if (!fs.existsSync(skillDir)) continue;
      let hit = null;
      if (spec.kind === "auto") {
        const dir = path.join(skillDir, spec.rel);
        if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) {
          const f = fs.readdirSync(dir).find((x) => /(review|audit|check).*\.(js|ps1)$/i.test(x));
          if (f) hit = { script: path.join(dir, f), kind: f.toLowerCase().endsWith(".ps1") ? "ps1" : "node" };
        }
      } else {
        const script = path.join(skillDir, spec.rel);
        if (fs.existsSync(script)) hit = { script, kind: spec.kind };
      }
      if (hit) {
        out.push({ id: spec.id, skillDir, ...hit });
        break; // 同一个 skill 只用最先命中的那份
      }
    }
  }
  return out;
}

function scriptDigest(file) {
  try {
    return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  } catch {
    return null;
  }
}

let psCache;
function whichPowerShell() {
  if (psCache !== undefined) return psCache;
  psCache = null;
  for (const bin of ["pwsh", "powershell"]) {
    const r = spawnSync(bin, ["-v"], { encoding: "utf8" });
    if (!r.error) {
      psCache = bin;
      break;
    }
  }
  return psCache;
}

/** 跑一个评审脚本；任何异常都收敛成返回值，绝不外抛 */
function runOne(rev, opts) {
  const args = [
    "-ProjectPath", opts.projectDir,
    "-TargetHeapKB", String(opts.heapKB),
    "-TargetApi", String(opts.apiLevel)
  ];
  if (opts.builtJs) args.push("-BuiltJsPath", opts.builtJs);

  let res;
  if (rev.kind === "node") {
    res = spawnSync(process.execPath, [rev.script, ...args], { encoding: "utf8", cwd: opts.projectDir });
  } else {
    const ps = whichPowerShell();
    if (!ps) return { id: rev.id, skipped: "本机没有 pwsh / powershell，跳过 .ps1 评审" };
    res = spawnSync(ps, ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", rev.script, ...args], {
      encoding: "utf8",
      cwd: opts.projectDir
    });
  }

  const text = `${res.stdout ?? ""}\n${res.stderr ?? ""}`;
  const findings = [];
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(LEVEL_RE);
    if (!m) continue;
    const level = m[1].toUpperCase();
    if (level === "PASS") continue; // PASS 不用报
    findings.push({ level, text: line.trim().replace(LEVEL_RE, "").trim() });
  }
  return { id: rev.id, script: path.relative(SDK_ROOT, rev.script), exit: res.status, findings };
}

function persist(reportFile, report) {
  try {
    fs.mkdirSync(path.dirname(reportFile), { recursive: true });
    fs.writeFileSync(reportFile, JSON.stringify(report, null, 2));
  } catch (e) {
    log.warn(`评审报告写入失败（不影响构建）：${e.message}`);
  }
}

export function run(taskContext) {
  const mode = taskContext.review ?? "auto";
  const reportFile = path.join(taskContext.work, "review", "report.json");
  taskContext.paths.reviewReport = reportFile;

  if (mode === "off") {
    log.info("评审已关闭（--review off）");
    persist(reportFile, { ok: true, enabled: false, reviewers: [] });
    return;
  }

  const wanted = mode === "auto" ? [] : String(mode).split(",").map((s) => s.trim()).filter(Boolean);

  let discovered = [];
  try {
    discovered = discover(wanted);
  } catch (e) {
    log.warn(`评审脚本探测失败（不影响构建）：${e.message}`);
  }

  const roots = skillRoots();
  if (!discovered.length) {
    log.warn(
      `没找到可用的评审脚本（skill 根：${roots.join(" · ") || "无"}），跳过评审；` +
        `可用 --review <id,id> 点名，或设 HMLWSDK_SKILLS 指向 skill 目录`
    );
    persist(reportFile, { ok: true, enabled: true, reviewers: [] });
    return;
  }

  const missing = REGISTRY.map((s) => s.id).filter(
    (id) => (!wanted.length || wanted.includes(id)) && !discovered.some((r) => r.id === id)
  );

  // 同一份脚本只跑一次：hmlwskill 与 litewearable-api10-dev 共用一份 cli.js
  const seen = new Map();
  const reviewers = [];
  for (const r of discovered) {
    const d = scriptDigest(r.script);
    if (d && seen.has(d)) {
      log.info(`评审脚本与 ${seen.get(d)} 相同，跳过重复：${r.id}`);
      continue;
    }
    if (d) seen.set(d, r.id);
    reviewers.push(r);
  }

  log.info(`评审脚本 ${reviewers.length} 个：${reviewers.map((r) => r.id).join(" · ")}`);
  if (missing.length) log.info(`未找到评审脚本（跳过）：${missing.join(" · ")}`);

  const opts = {
    projectDir: taskContext.projectDir,
    apiLevel: taskContext.apiLevel,
    heapKB: taskContext.reviewHeapKB ?? 256,
    builtJs: taskContext.paths.jsBuild
  };

  const results = [];
  const sigOf = new Map(); // 结论签名 → 已跑过的 skill id，用于合并完全相同的输出
  let problems = 0;
  let notes = 0;

  reviewers.forEach((rev, i) => {
    // 进度：第几个 / 共几个
    log.info(`评审 ${i + 1}/${reviewers.length} · ${rev.id} …`);
    const t0 = Date.now();

    let r;
    try {
      r = runOne(rev, opts);
    } catch (e) {
      r = { id: rev.id, error: String(e.message ?? e) };
    }
    results.push(r);

    if (r.skipped) {
      log.warn(`  跳过 ${rev.id}：${r.skipped}`);
      return;
    }
    if (r.error) {
      log.warn(`  ${rev.id} 运行失败（不影响构建）：${r.error}`);
      return;
    }

    const findings = r.findings ?? [];

    // 不同 skill 常复用同一份脚本（只有换行符/注释差异），结论完全一样：
    // 用「结论签名」去重，避免同一批警告刷两遍。
    const sig = createHash("sha256")
      .update(findings.map((f) => `${f.level}|${f.text}`).sort().join("\n"))
      .digest("hex");
    if (sigOf.has(sig)) {
      r.duplicateOf = sigOf.get(sig);
      log.info(`  ${rev.id}: 结论与 ${r.duplicateOf} 相同（${findings.length} 项），已合并`);
      return;
    }
    sigOf.set(sig, rev.id);

    const bad = findings.filter((f) => f.level !== "INFO");
    const ok = findings.filter((f) => f.level === "INFO");
    problems += bad.length;
    notes += ok.length;

    log.info(
      `  ${rev.id}: 警告 ${bad.length} · 提示 ${ok.length} · 退出码 ${r.exit} · ${log.formatMs(Date.now() - t0)}`
    );
    for (const f of bad.slice(0, MAX_SHOWN)) log.warn(`  [${rev.id}·${f.level}] ${f.text}`);
    if (bad.length > MAX_SHOWN) log.warn(`  [${rev.id}] …另有 ${bad.length - MAX_SHOWN} 项警告，见 report.json`);
    // INFO 是「看到了但没问题」，只在 --verbose 展开，避免刷屏
    for (const f of ok.slice(0, MAX_SHOWN)) log.debug(`  [${rev.id}·INFO] ${f.text}`);
  });

  persist(reportFile, {
    ok: true,
    enabled: true,
    heapKB: opts.heapKB,
    apiLevel: opts.apiLevel,
    problems,
    notes,
    reviewers: results
  });
  log.info(`评审完成 · ${results.length} 个脚本 · ${problems} 项警告 / ${notes} 项提示 · 不阻断构建`);
}
