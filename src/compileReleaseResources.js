import path from "path";

import { compileResources } from "./compileResources.js";
import { todo } from "./createTaskContext.js";

/**
 * compileReleaseResources —— 编译资源，产出 resources.index / R.txt / resources 目录
 *
 * 以前这一步是 spawn restool.exe，现在整个资源编译由本 SDK 用 JS 实现
 * （见 src/compileResources.js）。vendor/java-build-tools/restool.exe 已删除。
 *
 * 实测对照（新实现 vs Gradle 当时用 restool 1.022 跑出来的产物，逐文件 SHA256）：
 *
 *   工程            resources.index    R.txt    resources/ 目录
 *   _empty          字节一致           一致     6 个文件全一致
 *   devdemo         字节一致           一致     7 个文件全一致
 *   atri-mdm        字节一致           一致     一致（3 个 rawfile 例外，见下）
 *   openCrab        仅版本串 1 字节     一致     47 个文件全一致
 *   腕上词典        仅版本串 1 字节     一致     7 个文件全一致
 *
 * 两处已知差异，都不是功能问题：
 *   1. openCrab / 腕上词典的 Gradle 产物是 api7 的 restool 1.028 生成的，index 头部
 *      版本串写的是 "Restool 1.028"，我们统一写 1.022，所以只差第 12 个字节。
 *   2. atri-mdm 的 rawfile/momentplay_res/moments 下有 3 个 .dat 与构建产物不同 ——
 *      源文件在 2026-10-30 被改过，而 Gradle 产物是 2026-08-20 的，属于产物过期，
 *      不是复制逻辑的问题（同一目录下另外 4 个文件字节一致）。
 *
 * 变体无关：release 与 debug 的产物只有输出目录名不同。
 */

export const name = "compileReleaseResources";
export const produces = "res/release/normal/lite/resources.index + R.txt + resources/";

export function run(taskContext) {
  if (!taskContext.paths.processProfile) todo(name, "缺少 processProfile 产出的 config.json");

  const outDir = path.join(taskContext.work, "res", "release", "normal", "lite");

  const result = compileResources({
    // 模块根目录 src/main。资源在它下面的 resources/，config.json 也在这一层。
    moduleRoot: path.join(taskContext.moduleDir, "src", "main"),
    configPath: taskContext.paths.processProfile,
    moduleName: taskContext.moduleName ?? "entry",
    outDir,
    // 压缩图片（原来是 restool 的 -z）。不开的话 png 是源码原样大小
    // （_empty 的 icon.png 6790 B），开了才是 Gradle 产物那样 6320 B。
    compressImage: true,
    force: true
  });

  taskContext.paths.resources = result.indexFile;
  taskContext.paths.rTxt = result.rTxtFile;
  return outDir;
}
