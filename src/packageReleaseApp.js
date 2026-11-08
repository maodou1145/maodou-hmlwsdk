import fs from "fs";
import path from "path";

import { writeZip, readZip } from "./readWriteZip.js";
import * as log from "./logger.js";
import { todo } from "./createTaskContext.js";

/**
 * packageReleaseApp —— 把各模块的 hap 合成一个 .app
 *
 * 实测产物（devdemo release，同一份源码）：
 *   build/outputs/app/release/
 *     devdemo-release-unsigned.app   188260 B
 *     pack.info                        1142 B   ← 同时打进 .app
 *     appInfo.json                      203 B   ← 中间文件，不进 .app
 *
 * .app 内部只有两个条目，都是 deflate 压缩（method=8）：
 *   entry-release-lite.hap   2304041 B   ← 注意去掉了 "-unsigned"
 *   pack.info                   1142 B
 *
 * 过滤规则（PackageApp.getHapPathFiles）：
 *   非 .hap 的跳过；文件名含 "-bin-" 且 deviceType 含 liteWearable 的也跳过。
 *   所以 .bin 形态的 hap 进不了 .app，只有文件树形态进得去。
 *   实测印证：.app 里那份 hap 的字节数与 entry-release-lite-unsigned.hap 完全相同。
 */

export const name = "packageReleaseApp";
export const produces = "app/release/<工程名>-release-unsigned.app + pack.info + appInfo.json";

export function run(taskContext) {
  if (!taskContext.paths.treeHap) {
    todo(name, "缺少文件树形态的 hap —— .app 只收文件树形态，.bin 形态会被过滤掉。必须先跑 packageReleaseHap");
  }
  if (!taskContext.config) todo(name, "缺少 taskContext.config");

  const outDir = path.join(taskContext.work, "app", "release");
  fs.mkdirSync(outDir, { recursive: true });

  const hapName = path.basename(taskContext.paths.treeHap).replace("-unsigned", "");
  const moduleName = hapName.replace(/\.hap$/, "");

  // pack.info：summary（来自 config）+ packages（来自 hap 文件名）
  const packInfoText = JSON.stringify(buildPackInfo(taskContext.config, moduleName, taskContext), null, 4);

  // API 8+ 的可装包在 signed.bin 容器里带 pack.info。签名脚本只把内层 hap 的条目
  // 转进容器，而 pack.info 原本与 hap 平级放在 .app 外层，会被丢掉，所以这里
  // 把它一并塞进 treeHap。Gradle 工程的容器不带 pack.info，保持原样。
  if (taskContext.layout === "hvigor") {
    const entries = readZip(fs.readFileSync(taskContext.paths.treeHap));
    if (!entries.some((e) => e.name === "pack.info")) {
      entries.push({ name: "pack.info", content: Buffer.from(packInfoText) });
      fs.writeFileSync(taskContext.paths.treeHap, writeZip(entries, { compress: false }));
      log.info(`pack.info injected into treeHap (${entries.length} entries)`);
    }
  }
  const hapBuf = fs.readFileSync(taskContext.paths.treeHap);
  fs.writeFileSync(path.join(outDir, "pack.info"), packInfoText);

  // appInfo.json：只记录每个包的名字和大小，是中间文件，不进 .app
  const appInfoText = JSON.stringify(
    {
      packages: [
        {
          moduleType: taskContext.config.module?.distro?.moduleType ?? "entry",
          moduleName: taskContext.config.module?.distro?.moduleName ?? "entry",
          packageName: moduleName,
          packageSize: String(hapBuf.length)
        }
      ]
    },
    null,
    4
  );
  fs.writeFileSync(path.join(outDir, "appInfo.json"), appInfoText);

  // .app 本体：两个条目，都 deflate 压缩
  const appBuf = writeZip(
    [
      { name: hapName, content: hapBuf },
      { name: "pack.info", content: Buffer.from(packInfoText) }
    ],
    { compress: true }
  );

  const projectName = taskContext.config.app.bundleName.split(".").pop();
  const appPath = path.join(outDir, `${projectName}-release-unsigned.app`);
  fs.writeFileSync(appPath, appBuf);

  taskContext.paths.app = appPath;
  taskContext.paths.packInfo = path.join(outDir, "pack.info");
  return appPath;
}

/**
 * 从 config 拼出 pack.info
 *
 * 字段顺序照抄实测产物：deviceType → abilities → distro → apiVersion。
 * abilities 只保留 name 和 label，icon / type / homeAbility / iconId / labelId 都丢掉。
 */
function buildPackInfo(config, moduleName, taskContext) {
  const m = config.module ?? {};
  const distro = m.distro ?? {};
  const hvigor = taskContext?.layout === "hvigor";
  // 真包 pack.info 带 mainAbility；从 abilities / js 组件名取，取不到就不写
  const mainAbility = m.abilities?.[0]?.name ?? m.js?.[0]?.name;

  return {
    summary: {
      app: {
        bundleName: config.app.bundleName,
        version: config.app.version
      },
      modules: [
        {
          deviceType: m.deviceType ?? ["liteWearable"],
          abilities: (m.abilities ?? []).map((ab) => ({ name: ab.name, label: ab.label })),
          // 重新构造，不能直接引用 config 里的对象 —— 键序必须和 Gradle 一致：
          //   distro     moduleType → deliveryWithInstall → moduleName
          //   apiVersion compatible → releaseType → target
          distro: {
            moduleType: distro.moduleType ?? "entry",
            deliveryWithInstall: distro.deliveryWithInstall ?? true,
            moduleName: distro.moduleName ?? "entry"
          },
          // API 8+ 真包的 modules[].apiVersion 是空对象，版本信息只写在 config.json 里
          apiVersion: hvigor
            ? {}
            : {
                compatible: config.app.apiVersion.compatible,
                releaseType: config.app.apiVersion.releaseType,
                target: config.app.apiVersion.target
              },
          ...(hvigor && mainAbility ? { mainAbility } : {})
        }
      ]
    },
    packages: [
      {
        deviceType: m.deviceType ?? ["liteWearable"],
        moduleType: distro.moduleType ?? "entry",
        deliveryWithInstall: distro.deliveryWithInstall ?? true,
        name: moduleName
      }
    ]
  };
}
