import fs from "fs";
import path from "path";

import { todo } from "./createTaskContext.js";

/**
 * generateReleaseJsManifest —— 给 webpack 准备组件清单
 *
 * 产出 js/release/jsManifest/<组件>/manifest.json，这个文件是
 * compileReleaseJsWithNode 的输入（aceManifestPath）。
 *
 * 实测内容（apps/_empty/_empty，4 空格缩进、末尾无换行）：
 *
 *   {
 *       "appID": "com.github.kqakqakqa.hmlitewearable._empty",
 *       "appName": "$string:appName",
 *       "versionName": "0.1.0",
 *       "versionCode": 1,
 *       "minPlatformVersion": 3,
 *       "pages": ["pages/index/index"],
 *       "deviceType": ["liteWearable"]
 *   }
 *
 * 注意 appName 保留 "$string:..." 原样，webpack 侧才去解析资源引用。
 *
 * API 8+（hvigor）工程的差异：
 *   - module.js[].name 带前导点（".MainAbility"），磁盘目录是 js/MainAbility
 *   - resources/base/element/string.json 里**没有 appName**，只有 MainAbility_label
 *     （实测 Explore-In-HMOS/sportwatch-tile-guess）
 *   所以非 default 组件取对应 ability 的 label，而不是拼 `<name>_appName`，
 *   否则 webpack 解析不到资源名。default 组件沿用老工程的 "$string:appName"。
 *
 * 组件目录名统一用 resolveProject 给出的 buildName，保证 manifest 输出路径和
 * compileReleaseJsWithNode 读取路径、assets/js/ 产物路径三者一致。
 *
 * 变体无关：debug 和 release 的 manifest.json 字段结构完全一样。
 */

export const name = "generateReleaseJsManifest";
export const produces = "js/release/jsManifest/<组件>/manifest.json";

/** 老调用方没传 components 时兜底，保持旧行为 */
function componentsOf(taskContext) {
  if (taskContext.components?.length) return taskContext.components;
  return (taskContext.config?.module?.js ?? []).map((c) => ({
    name: c.name,
    dirName: c.name,
    buildName: String(c.name).replace(/^\./, ""),
    pages: c.pages ?? []
  }));
}

export function run(taskContext) {
  const c = taskContext.config;
  if (!c) todo(name, "缺少 taskContext.config，必须先跑 mergeReleaseProfile");

  const comps = componentsOf(taskContext);
  if (!comps.length) todo(name, "config.json 里没有 module.js，取不到组件名和 pages");

  const abilities = c.module?.abilities ?? [];
  let firstOut = null;

  // 每个组件都要有自己的一份 manifest —— compileReleaseJsWithNode 是逐组件跑 webpack 的
  for (const comp of comps) {
    const outDir = path.join(taskContext.work, "js", "release", "jsManifest", comp.buildName);
    const out = path.join(outDir, "manifest.json");

    const bare = String(comp.name).replace(/^\./, "");
    const ability = abilities.find(
      (a) => a?.srcPath === bare || String(a?.name ?? "").replace(/^\./, "") === bare
    );

    const manifest = {
      appID: c.app.bundleName,
      appName:
        comp.name === "default"
          ? "$string:appName"
          : ability?.label ?? `$string:${comp.buildName}_appName`,
      versionName: c.app.version.name,
      versionCode: c.app.version.code,
      minPlatformVersion: c.app.apiVersion.compatible,
      pages: comp.pages,
      deviceType: c.module.deviceType
    };

    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(out, JSON.stringify(manifest, null, 4));
    if (!firstOut) firstOut = out;
  }

  taskContext.paths.jsManifest = firstOut;
  return firstOut;
}
