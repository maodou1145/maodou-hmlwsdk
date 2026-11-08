import fs from "fs";
import path from "path";

import { scanResourceFiles, listCopyOnlyFiles } from "./scanResourceFiles.js";
import { parseElementJson, composeStrings } from "./parseElementJson.js";
import { writeResourceIndex } from "./writeResourceIndex.js";
import { writeResourceTable } from "./writeResourceTable.js";
import { copyResourceFiles } from "./copyResourceFiles.js";
import { fillResourceIds } from "./parseResourceTable.js";
import { stringifyConfig } from "./processConfig.js";
import { ensureAppIcons } from "./ensureAppIcons.js";

/**
 * 编译模块资源 —— 替代 restool.exe
 *
 * 对外的约定和原来调 restool 时保持一致，`compileReleaseResources` 只改一个调用点。
 *
 * 产出（都在 outDir 下）：
 *   resources.index                      资源索引，见 writeResourceIndex.js
 *   R.txt                                资源 id 文本表，见 writeResourceTable.js
 *   config.json                          回填了 iconId/labelId/descriptionId 的配置
 *   resources/<限定>/media/…             图片（可压缩）+ 4 个空 .key
 *   resources/<限定>/profile/…           profile json 原样复制
 *   resources/rawfile/…                  rawfile 整棵复制
 *
 * 不产出 ResourceTable.java —— 那是给 Java 编译链用的，liteWearable 走 JS，
 * Gradle 的 lite 产物目录里也没有这个文件。
 *
 * ## id 分配
 *
 * 从 0x01000000 起，按「限定目录 → 资源簇 → (resType, 名称)」的顺序发号。
 * 为什么是这个顺序：restool 给每个 (限定目录, 资源簇) 组合建一个 compiler，
 * compiler 内部把资源按 (resType, 名称) 排进 map，编译完再统一发号。所以
 * element 里的资源先拿号、media 和 profile 后拿。
 *
 * 实测（probe 工程，element + media + profile 各有一点资源）：
 *   integer aa_int    0x1000000      ← element 内部按 resType 升序（integer=8 最前）
 *   integer zz_int    0x1000001
 *   string  aaa_first 0x1000002      ← string=9
 *   …
 *   float   zz_float  0x100000e      ← float=18
 *   media   icon      0x100000f      ← media 簇，只按名字排
 *   profile probe_profile 0x1000011  ← profile 簇最后
 *
 * 同一个资源名出现在多个限定目录（base / dark / zh_CN）时**共用一个 id**，
 * 在 index 里是每个限定目录各一条记录 —— 实测 probe2 的 appName 三条记录同 id
 * 0x1000000。
 */

/** app 资源的 id 起点。restool 的 IdWorker::Init 默认值就是它 */
const RES_ID_START = 0x01000000;

/**
 * @param {object} opts
 * @param {string} opts.moduleRoot 模块根目录（src/main）
 * @param {string} opts.configPath 加工过的 config.json
 * @param {string} opts.outDir 输出目录，不存在会自动建
 * @param {string} [opts.moduleName] 模块名，也就是 index 里资源路径的第一段，默认 entry
 * @param {boolean} [opts.compressImage] 是否压缩图片（原来的 -z），默认 true
 * @param {boolean} [opts.force] 输出目录下已有 resources 时是否覆盖，默认 true
 * @returns {{indexFile:string, rTxtFile:string, configFile:string, stats:object}}
 */
export function compileResources(opts) {
  const outDir = opts.outDir;
  const moduleName = opts.moduleName ?? "entry";
  fs.mkdirSync(outDir, { recursive: true });

  const outResources = path.join(outDir, "resources");
  if (fs.existsSync(outResources) && opts.force !== false) {
    fs.rmSync(outResources, { recursive: true, force: true });
  }

  const scanned = scanResourceFiles(opts.moduleRoot);

  // Hvigor 布局需要 icon(114x114) + icon_small(80x80) 两个应用图标，
  // 缺一个会在安装期报「40.配置文件格式错误」。只往扫描结果里注入生成文件，
  // 不改工程源码；生成物落在 outDir/.generated。
  const icons = opts.ensureIcons ? ensureAppIcons(scanned, outDir) : null;

  // ── 第一遍：收集资源项并按 restool 的顺序发 id ──
  const idTable = new Map(); // "resType:name" → { id, resType, typeName, name }
  const byLimitKey = new Map();
  let nextId = RES_ID_START;

  for (const config of scanned) {
    const bucket = [];
    byLimitKey.set(config.limitKey, bucket);

    for (const cluster of config.clusters) {
      const items = collectClusterItems(config, cluster, moduleName);
      items.sort(byResTypeThenName);
      assertNoDuplicate(config.limitKey, cluster.cluster, items);

      for (const item of items) {
        const key = item.resType + ":" + item.name;
        if (!idTable.has(key)) {
          idTable.set(key, { id: nextId++, resType: item.resType, typeName: item.typeName, name: item.name });
        }
        item.id = idTable.get(key).id;
        bucket.push(item);
      }
    }
  }

  // ── 第二遍：写 resources.index ──
  const indexConfigs = scanned.map((config) => ({
    keyParams: config.keyParams,
    // 组内按 id 升序，和 restool 的 map<int64_t, ...> 遍历顺序一致
    items: byLimitKey.get(config.limitKey).sort((a, b) => a.id - b.id)
  }));

  const indexFile = path.join(outDir, "resources.index");
  fs.writeFileSync(indexFile, writeResourceIndex(indexConfigs));

  // ── R.txt：同 id 的多份记录只写一行（跨限定目录视为同一个资源） ──
  const rTxtFile = path.join(outDir, "R.txt");
  fs.writeFileSync(rTxtFile, writeResourceTable([...idTable.values()]), "utf8");

  // ── 文件型资源落盘 ──
  const stats = copyResourceFiles({
    outDir,
    configs: scanned,
    copyOnly: listCopyOnlyFiles(opts.moduleRoot),
    compressImage: opts.compressImage !== false
  });

  // ── config.json：回填引用到的资源 id ──
  const configFile = path.join(outDir, "config.json");
  writeConfigJson(opts.configPath, configFile, idTable);

  return { indexFile, rTxtFile, configFile, stats, icons };
}

/**
 * 把 idTable 摊成 parseRTable 那种「类型 → 名字 → id」的嵌套表
 * 这样 config.json 的回填可以和 R.txt 那条路共用 fillResourceIds
 */
function toResourceTable(idTable) {
  const rtable = {};
  for (const item of idTable.values()) {
    (rtable[item.typeName] ??= {})[item.name] = item.id;
  }
  return rtable;
}

/**
 * 收集一个 (限定目录, 资源簇) 下的资源项
 * 每条都带 resType / typeName / name / data，data 就是写进 index 的那串字节
 */
function collectClusterItems(config, cluster, moduleName) {
  if (cluster.cluster === "element") {
    return cluster.files.flatMap((filePath) => {
      const items = parseElementJson(filePath);
      // element 里的资源名由 json 决定，配置组信息要补上
      return items.map((item) => ({ ...item, limitKey: config.limitKey }));
    });
  }

  // media / profile：一个文件一个资源，名字去掉扩展名，路径写进 index
  return cluster.files.map((filePath) => {
    const filename = path.basename(filePath);
    const name = stripExtension(filename);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      throw new Error(
        `${cluster.cluster} 下的文件名 "${filename}" 去掉扩展名后不是合法资源名` +
          `（只允许字母数字下划线，不能数字开头）`
      );
    }
    // 记录里存的是「模块名/资源簇/文件名」这样的相对路径，设备端按它去找资源
    const pathText = `${moduleName}/resources/${config.limitKey}/${cluster.cluster}/${filename}`;
    return {
      resType: cluster.dirType,
      typeName: cluster.cluster,
      name,
      data: composeStrings([pathText, name], true),
      limitKey: config.limitKey
    };
  });
}

function stripExtension(filename) {
  const i = filename.lastIndexOf(".");
  return i <= 0 ? filename : filename.slice(0, i);
}

/** id 分配顺序里「类型在前、名字在后」，都用字节序比较，跟 C++ 的 std::string 一致 */
function byResTypeThenName(a, b) {
  if (a.resType !== b.resType) return a.resType - b.resType;
  if (a.name < b.name) return -1;
  if (a.name > b.name) return 1;
  return 0;
}

function assertNoDuplicate(limitKey, clusterName, items) {
  const seen = new Set();
  for (const item of items) {
    const key = item.resType + ":" + item.name;
    if (seen.has(key)) {
      throw new Error(`${limitKey}/${clusterName} 里的资源 "${item.name}" 重复定义（同一限定目录下同名同类型只能有一份）`);
    }
    seen.add(key);
  }
}

/**
 * 写出回填过资源 id 的 config.json
 *
 * restool 只加字段不改原值（probe 工程的产物里 icon 还是 "$media:icon"，
 * 旁边多出一个 iconId），这套白名单和遍历逻辑在 parseResourceTable.js 里，
 * 和打 .bin 时用的是同一份，避免两处规则漂移。
 *
 * 序列化用 processConfig 的 stringifyConfig。**排版和 Gradle 那份不一样**
 * （restool 用 cJSON 输出，_empty 是 1137 B；这份是 925 B），JSON 内容一致。
 * 这个文件其实没人读 —— 打 .bin 时 generateReleaseBinSource 会重新写一份到
 * js/release/source/lite/config.json。写它只是为了让 res 输出目录的结构和
 * Gradle 对得上，缺一个文件容易让人以为漏了步骤。
 */
function writeConfigJson(configPath, outFile, idTable) {
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  fillResourceIds(config, toResourceTable(idTable));
  fs.writeFileSync(outFile, stringifyConfig(config), "utf8");
}
