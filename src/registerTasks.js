/**
 * 15 个任务按依赖顺序登记 —— 这个顺序就是 build.js 的执行顺序
 *
 * 顺序依据：doc/gradle-build-report.html 的 01 节（按依赖深度从小到大）。
 * 已移除 7 个空方法任务，它们 run() 里没有一条指令，不在链上。
 * 另外移除 3 个 status = "not planned" 的纯占位（zipSources / validateUploadState /
 * signReleaseHap），它们的 run() 是空的或直接 return null，永远不执行。
 *
 * 只做 release 变体。debug 构建已放弃：debug 只出 1 个 .bin 形态的包，
 * 且不压缩，发布用不上。验证基准是 apps/devdemo/devdemo 的 release 产物。
 */

import * as mergeReleaseResources from "./mergeReleaseResources.js";
import * as mergeReleaseProfile from "./mergeReleaseProfile.js";
import * as generateReleaseJsManifest from "./generateReleaseJsManifest.js";
import * as compileReleaseJsWithNode from "./compileReleaseJsWithNode.js";
import * as processReleaseProfile from "./processReleaseProfile.js";
import * as compileReleaseResources from "./compileReleaseResources.js";
import * as generateReleaseBinSource from "./generateReleaseBinSource.js";
import * as processReleaseJavaRes from "./processReleaseJavaRes.js";
import * as processReleaseLibsFile from "./processReleaseLibsFile.js";
import * as generateReleaseJsBin from "./generateReleaseJsBin.js";
import * as signReleaseJsBin from "./signReleaseJsBin.js";
import * as packageReleaseHap from "./packageReleaseHap.js";

import * as validateReleaseDistroFilterTask from "./validateReleaseDistroFilterTask.js";
import * as packageReleaseApp from "./packageReleaseApp.js";
import * as signReleaseApp from "./signReleaseApp.js";
import * as verifyRelease from "./verifyRelease.js";
import * as reviewRelease from "./reviewRelease.js";

export const TASKS = [
  // release 链，12 步
  mergeReleaseResources,
  mergeReleaseProfile,
  generateReleaseJsManifest,
  compileReleaseJsWithNode,
  processReleaseProfile,
  compileReleaseResources,
  generateReleaseBinSource,
  processReleaseJavaRes,
  processReleaseLibsFile,
  generateReleaseJsBin,
  signReleaseJsBin,
  packageReleaseHap,
  reviewRelease, // 外部 skill 评审：只报警告，不阻断构建、不参与退出码

  // App 链，3 步
  validateReleaseDistroFilterTask,
  packageReleaseApp,
  signReleaseApp,

  // 出包自检（独立入口：verifyRelease 会带出上面整条链）
  verifyRelease
];

/**
 * 依赖表 —— 从 doc/gradle-build-report.html 每个卡片的 kids 字段抄来的
 *
 * 构建是「按需」的：跑某个入口任务时，只跑它依赖的任务，不是把这个数组从头到尾
 * 扫一遍。比如 packageReleaseApp 不会带出 mergeReleaseResources 那条资源链。
 *
 * 报告里 packageReleaseHap 的 kids 列了 6 个，其中有几个是冗余的（generateReleaseBinSource
 * 和 compileReleaseResources 已经通过 signReleaseJsBin → generateReleaseJsBin → ... 覆盖）。
 * 这里原样保留，拓扑排序会自己去重。
 */
export const DEPENDS = {
  mergeReleaseResources: [],
  mergeReleaseProfile: ["mergeReleaseResources"],
  generateReleaseJsManifest: ["mergeReleaseProfile"],
  compileReleaseJsWithNode: ["generateReleaseJsManifest"],
  processReleaseProfile: ["mergeReleaseProfile"],
  compileReleaseResources: ["processReleaseProfile"],
  generateReleaseBinSource: ["compileReleaseResources", "compileReleaseJsWithNode"],
  processReleaseJavaRes: [],
  processReleaseLibsFile: [],
  generateReleaseJsBin: ["generateReleaseBinSource"],
  signReleaseJsBin: ["generateReleaseJsBin"],
  packageReleaseHap: [
    "processReleaseJavaRes",
    "processReleaseLibsFile",
    "generateReleaseBinSource",
    "signReleaseJsBin",
    "compileReleaseResources",
    "compileReleaseJsWithNode"
  ],

  validateReleaseDistroFilterTask: [],
  reviewRelease: ["generateReleaseBinSource"],
  packageReleaseApp: ["validateReleaseDistroFilterTask", "packageReleaseHap", "reviewRelease"],
  signReleaseApp: ["packageReleaseApp"],
  verifyRelease: ["signReleaseApp", "reviewRelease"]
};

export function findTask(name) {
  return TASKS.find((t) => t.name === name) ?? null;
}
