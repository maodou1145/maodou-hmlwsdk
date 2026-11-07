/** 15 个任务共用的小工具 */

/**
 * 贯穿所有任务的 taskContext 形状（由 bin/hmlwsdk.js 创建，任务只读不建）
 *
 *   projectDir          工程根目录，例如 /path/to/apps/_empty/_empty
 *   moduleDir           模块目录（resolveProject 探测，不写死 entry）
 *   moduleName          模块名（工程级 build-profile.json5 的 modules[].name）
 *   layout              "gradle"（API 5~7）| "hvigor"（API 8~12）
 *   components          [{ name, dirName, buildName, pages }]，hvigor 的 name 带前导点
 *   work                中间产物目录，所有任务往这里写（绝对路径）
 *   srcConfig           源码 config.json 解析出来的对象
 *   apiLevel            目标 API 级别，驱动 ace-loader 兼容补丁与图片素材择一
 *   stripImages         "auto"(默认) | "png" | "bin" | "none"，只作用于 treeHap 条目
 *   compileSdkVersion   → config.app.apiVersion.target
 *   compatibleSdkVersion → config.app.apiVersion.compatible
 *   config              加工过程中的 config 对象，逐任务往后传
 *   paths               各任务产出文件的路径，键名见各任务的 produces
 */
export function createTaskContext(fields) {
  return {
    paths: {},
    ...fields
  };
}

/**
 * 没实现的地方统一抛这个，报错信息里必须写清要产出什么
 * @param {string} name 任务名
 * @param {string} what 该产出什么
 */
export function todo(name, what) {
  throw new Error(`[TODO] ${name} 还没实现 —— ${what}`);
}
