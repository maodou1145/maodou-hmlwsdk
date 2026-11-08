import fs from "fs";
import path from "path";

import JSON5 from "json5";
import { parseBuildGradle } from "./parseBuildGradle.js";

/**
 * 工程布局探测 —— 让同一条构建链同时吃两种 Lite Wearable 工程。
 *
 *   Gradle（DevEco 3.x，API 5~7）
 *     <root>/build.gradle + <root>/entry/build.gradle
 *     SDK 版本是数字：compileSdkVersion 6 / compatibleSdkVersion 3
 *     JS 组件目录固定 src/main/js/default
 *     config.json 无 app.apiVersion，由构建注入
 *
 *   Hvigor（DevEco 4.x+，API 8~12，含 API 10）
 *     <root>/build-profile.json5（工程级）+ <root>/entry/build-profile.json5（模块级）
 *     SDK 版本是字符串：app.products[].compatibleSdkVersion = "4.0.0(10)"
 *     config.json 同样无 app.apiVersion
 *     module.js[].name 带前导点（".MainAbility"），磁盘目录是 js/MainAbility
 *     abilities[] 多了 srcLanguage / srcPath
 *
 * 实测依据：
 *   - 本仓库 hmlitewearable_devdemo（Gradle / API 6）
 *   - GitHub Explore-In-HMOS/sportwatch-tile-guess（Hvigor / "5.0.0(12)"）的
 *     build-profile.json5、entry/build-profile.json5、entry/src/main/config.json
 *
 * 没拿真实 API 10 构建产物逐字节核对过的推断点，都在下面标了「待核对」，
 * 并且提供 CLI 覆盖开关，别把猜测写死。
 */

export const LAYOUT_GRADLE = "gradle";
export const LAYOUT_HVIGOR = "hvigor";

function readJson5(file) {
  try {
    return JSON5.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    throw new Error(`解析 ${file} 失败：${e.message}`);
  }
}

/** "4.0.0(10)" → 10，"10" / 10 → 10；没有 API 级别的写法直接报错，不猜 */
export function apiLevelFrom(value) {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  const s = String(value ?? "").trim();
  const bracket = s.match(/\((\d+)\)\s*$/);
  if (bracket) return Number(bracket[1]);
  if (/^\d+$/.test(s)) return Number(s);
  throw new Error(`无法从 SDK 版本 "${s}" 里提取 API 级别（期望 "4.0.0(10)" 或 10）`);
}

/**
 * SDK 版本串 → HarmonyOS config.app.apiVersion 的编码整数。
 *
 * 真机可装包的实测值：`4.0.0(10)` → 40000010、`5.1.0(18)` → 50100018，
 * 规则是 major*1e7 + minor*1e5 + patch*1e3 + apiLevel。
 * 早期 Gradle 工程只有裸数字（6/7），那种写法保持原样，不做编码。
 */
export function sdkVersionCode(raw) {
  const s = String(raw ?? "").trim();
  const m = s.match(/^(\d+)\.(\d+)\.(\d+)\s*\((\d+)\)\s*$/);
  if (!m) return apiLevelFrom(s);
  const major = Number(m[1]);
  const minor = Number(m[2]);
  const patch = Number(m[3]);
  const api = Number(m[4]);
  return major * 10000000 + minor * 100000 + patch * 1000 + api;
}

/** "4.0.0(10)" → "4.0.0.10"，真包 compileSdkVersion 字段是点分版本串 */
function sdkVersionString(raw) {
  return String(raw ?? "").trim().replace(/\((\d+)\)/, ".$1");
}

/**
 * 解析工程级 build-profile.json5 的 SDK 版本。
 * 优先级：products[].compatibleSdkVersion → app.compatibleSdkVersion → app.compileSdkVersion。
 */
function versionsFromHvigor(profilePath) {
  const p = readJson5(profilePath);
  const products = p?.app?.products ?? [];
  const raw =
    products.map((x) => x?.compatibleSdkVersion).find((v) => v !== undefined && v !== null) ??
    p?.app?.compatibleSdkVersion ??
    p?.app?.compileSdkVersion;

  if (raw === undefined) {
    throw new Error(`${profilePath} 里既没有 app.products[].compatibleSdkVersion，也没有 app.compatibleSdkVersion`);
  }

  const apiLevel = apiLevelFrom(raw);

  // hvigor 不再区分 compile / compatible：compatibleSdkVersion 同时决定 target 与最低兼容。
  // 老 Gradle 工程两个数可以不同，所以这里仍然分开存，允许调用方各自覆盖。
  return {
    compileSdkVersion: apiLevel,
    compatibleSdkVersion: apiLevel,
    sdkVersionRaw: String(raw),
    apiLevel,
    apiVersionCode: sdkVersionCode(raw),
    compileSdkVersionStr: sdkVersionString(raw),
    // 显式记录了 targetSdkVersion 时以它为准
    ...(p?.app?.targetSdkVersion !== undefined
      ? { compileSdkVersion: apiLevelFrom(p.app.targetSdkVersion) }
      : {})
  };
}

/** 从工程级 build-profile.json5 的 modules[] 定位 entry 模块目录 */
function moduleFromHvigor(profilePath, root) {
  const p = readJson5(profilePath);
  const mods = p?.modules ?? [];
  const m = mods.find((x) => x?.name === "entry") ?? mods[0];
  const name = m?.name ?? "entry";
  const src = m?.srcPath ?? `./${name}`;
  return { moduleName: name, moduleDir: path.resolve(root, src) };
}

/**
 * 解析 module.js[] → 组件列表。
 *
 * hvigor 工程的 name 是 ".MainAbility"，而磁盘目录 / abilities[].srcPath 是
 * "MainAbility"（没有点）。这里同时给出：
 *   name      产物与 config.json 里用的名字（原样，不改设备端配置）
 *   dirName   源码目录名，按 srcPath → 去点 → 原名 的顺序探测
 *   buildName 打进 assets/js/<buildName>/ 的名字
 *
 * 待核对：真实 API 10 产物里 assets/js/ 下到底是 ".MainAbility" 还是
 * "MainAbility" 还是 "default"。默认取去点后的目录名（带点开头在 zip 里是隐藏
 * 条目，且 abilities[].srcPath 明确是无点的），可用 --js-out 覆盖。
 */
export function resolveComponents(moduleDir, config, jsOutOverride) {
  const jsModules = config?.module?.js ?? [];
  if (!jsModules.length) {
    throw new Error("config.json 里没有 module.js，取不到组件名和 pages");
  }

  const abilities = config?.module?.abilities ?? [];
  const jsRoot = path.join(moduleDir, "src", "main", "js");

  return jsModules.map((comp, i) => {
    const bare = String(comp.name).replace(/^\./, "");
    const ab = abilities.find(
      (a) => a?.srcPath === bare || String(a?.name ?? "").replace(/^\./, "") === bare
    );

    const candidates = [...new Set([ab?.srcPath, bare, comp.name].filter(Boolean))];
    const dirName = candidates.find((n) => fs.existsSync(path.join(jsRoot, n, "app.js")));

    if (!dirName) {
      throw new Error(
        `组件 "${comp.name}" 找不到源码目录：试过 ${candidates.map((n) => `js/${n}/app.js`).join(" / ")}，` +
          `检查 config.json 的 module.js[${i}].name 与 abilities[].srcPath`
      );
    }

    return {
      name: String(comp.name),
      dirName,
      buildName: jsOutOverride && jsModules.length === 1 ? jsOutOverride : bare,
      pages: comp.pages ?? []
    };
  });
}

/**
 * @param {string} root 工程根目录
 * @param {object} [opts]
 * @param {number} [opts.compatible] 覆盖 app.apiVersion.compatible
 * @param {number} [opts.target]     覆盖 app.apiVersion.target
 * @param {string} [opts.jsOut]      覆盖 assets/js/<名字>
 */
export function resolveProject(root, opts = {}) {
  const rootProfile = path.join(root, "build-profile.json5");
  const rootGradle = path.join(root, "build.gradle");
  const isHvigor = fs.existsSync(rootProfile);

  let layout, moduleName, moduleDir, versions;

  if (isHvigor) {
    layout = LAYOUT_HVIGOR;
    ({ moduleName, moduleDir } = moduleFromHvigor(rootProfile, root));
    versions = versionsFromHvigor(rootProfile);
  } else {
    if (!fs.existsSync(rootGradle)) {
      throw new Error(`${root} 下既没有 build-profile.json5 也没有 build.gradle，认不出工程类型`);
    }
    layout = LAYOUT_GRADLE;
    moduleName = "entry";
    moduleDir = path.join(root, moduleName);
    const g = parseBuildGradle(moduleDir);
    versions = {
      ...g,
      sdkVersionRaw: `${g.compileSdkVersion}/${g.compatibleSdkVersion}`,
      apiLevel: g.compileSdkVersion,
      // Gradle 工程的 apiVersion 就是裸数字，没有编码值，也不写 compileSdkVersion 字段
      apiVersionCode: null,
      compileSdkVersionStr: null
    };
  }

  if (opts.compatible !== undefined) versions.compatibleSdkVersion = Number(opts.compatible);
  if (opts.target !== undefined) versions.compileSdkVersion = Number(opts.target);

  const configPath = path.join(moduleDir, "src", "main", "config.json");
  if (!fs.existsSync(configPath)) {
    throw new Error(`找不到 ${configPath}（layout=${layout}, module=${moduleName}）`);
  }
  const srcConfig = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const components = resolveComponents(moduleDir, srcConfig, opts.jsOut);

  return {
    layout,
    moduleName,
    moduleDir,
    configPath,
    srcConfig,
    components,
    ...versions
  };
}
