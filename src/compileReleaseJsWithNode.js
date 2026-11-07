import fs from "fs";
import path from "path";

import { compileJs } from "./runWebpack.js";
import { generateJsSnapshot } from "./generateJsSnapshot.js";
import { todo } from "./createTaskContext.js";

/**
 * compileReleaseJsWithNode —— node + webpack 编译
 *
 * 关键点：aceModuleRoot 必须是**组件目录**，不是模块根目录。
 *
 * 依据 ace-loader/webpack.lite.config.js 第 119 行：
 *   process.env.projectPath = env.aceModuleRoot || ... || process.cwd()
 * 然后 main.product.js 的 loadEntryObj 里检查 path.resolve(projectPath, 'app.js')
 * 存不存在，不存在就报 ERROR: missing app.js。
 *
 * 所以 Gradle 是「每个组件单独编一次」，aceModuleRoot 传的是
 * <模块>/src/main/js/<组件名>。传 src/main 会直接报 missing app.js。
 *
 * 产物仍写到模块级的 buildDir（webpack 自己按组件名展开成
 * assets/js/<组件名>/），实测产物结构与 devdemo 的
 * js/release/source/lite/assets/js/default/ 对得上。
 *
 * release 与 debug 的差别：webpack 换 mode production，代码被压缩
 * 实测（devdemo 两变体对比）：app.js 6187 → 1604，app.bc 2564 → 1812。
 */

export const name = "compileReleaseJsWithNode";
export const produces = "js/release/source/lite/assets/js/<组件>/*.js|*.bc";

export async function run(taskContext) {
  if (!taskContext.paths.jsManifest) todo(name, "缺少 jsManifest，必须先跑 generateReleaseJsManifest");
  if (!taskContext.config) todo(name, "缺少 taskContext.config，必须先跑 mergeReleaseProfile");

  // components 由 resolveProject 探测（含 hvigor 工程带前导点的组件名）。
  // 老调用方没传时按 config.module.js 兜底，行为与改造前一致。
  const components = taskContext.components?.length
    ? taskContext.components
    : (taskContext.config.module?.js ?? []).map((c) => ({
        name: c.name,
        dirName: c.name,
        buildName: String(c.name).replace(/^\./, ""),
        pages: c.pages ?? []
      }));
  if (!components.length) todo(name, "config.json 里没有 module.js，取不到组件名");

  const sourceRoot = path.join(taskContext.work, "js", "release", "source", "lite");

  for (const comp of components) {
    // 组件源码目录：hvigor 工程是 js/MainAbility，而 config 里写的是 ".MainAbility"
    const moduleRoot = path.join(taskContext.moduleDir, "src", "main", "js", comp.dirName);
    if (!fs.existsSync(path.join(moduleRoot, "app.js"))) {
      throw new Error(`${name}: ${moduleRoot} 下没有 app.js，确认组件 ${comp.name} 的源码目录对不对`);
    }

    // 每个组件有自己的一份 manifest，目录名与产物 assets/js/<buildName> 保持一致
    const manifestPath = path.join(taskContext.work, "js", "release", "jsManifest", comp.buildName, "manifest.json");
    if (!fs.existsSync(manifestPath)) {
      todo(name, `组件 ${comp.name} 的 manifest.json 不存在：${manifestPath}`);
    }
    const buildDir = path.join(sourceRoot, "assets", "js", comp.buildName);

    // resources 下的 png 也要转成 .bin，靠 img2bin 的 iconPath 环境变量。
    // compileReleaseResources 没跑过时这个目录不存在，就不传（不是所有调用方都需要它）。
    const resPngDir = taskContext.paths.resources ? path.join(path.dirname(taskContext.paths.resources), "resources") : null;

    const r = compileJs({
      moduleRoot,
      buildDir,
      manifestPath,
      iconPath: resPngDir && fs.existsSync(resPngDir) ? resPngDir : undefined,
      // 缓存必须放在产物目录外面。默认的 <buildDir>/../cache 会落在
      // assets/js/cache/ 下，被打进 .bin 变成多余条目（实测多出 2 个 .pack.gz）。
      cacheDir: path.join(taskContext.work, "js", "release", "cache"),
      buildMode: "release",
      deviceType: "liteWearable",
      apiLevel: taskContext.apiLevel,
      hapMode: true
    });

    if (!r.ok) {
      throw new Error(
        `${name} 失败：组件 ${comp.name}（webpack 返回 ${r.code}）\n` +
          (r.stderr ?? "").slice(-2000) +
          "\n" +
          (r.stdout ?? "").slice(-2000)
      );
    }

    // 清掉 webpack 的中间文件 —— Gradle 的 92 个产物里没有这些。
    // 实测 devdemo 会多出 image_convert_result.txt、preview_css.json、_releaseMap/。
    for (const junk of ["image_convert_result.txt", "preview_css.json"]) {
      fs.rmSync(path.join(buildDir, junk), { force: true });
    }
    fs.rmSync(path.join(buildDir, "_releaseMap"), { recursive: true, force: true });

    // webpack 只出 .js，真机要的 .bc 在这里补。
    // ace-loader 的 SnapshotPlugin（exec Windows 专属 exe 的那个）已经被
    // --isPreview=true 关掉，换成进程内的 jerry-parser-wasm。
    // 实测（devdemo debug 22 个文件）397 ms，平均 18 ms/个，比每次 exec 起进程还快。
    const snapped = await generateJsSnapshot(buildDir);
    if (!snapped.count) {
      throw new Error(`${name}: ${buildDir} 下没有生成任何 .js，webpack 产物不对`);
    }
  }

  taskContext.paths.jsBuild = sourceRoot;
  return sourceRoot;
}
