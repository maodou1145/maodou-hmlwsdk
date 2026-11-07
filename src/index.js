/**
 * hmlwsdk —— 用纯 JS 替代 Gradle 的 liteWearable 出包链
 *
 * 已经用真实产物验证过的部分：
 *
 *   模块              验证方式                                      结果
 *   ─────────────────────────────────────────────────────────────────────
 *   bin 读写          4 个真实 .bin 解析后重建，比对 SHA256            字节级一致
 *   zip 读写          hap 打包后与 Gradle 产物对比                    条目内容一致
 *   config 加工       源码 → merge → process → 回填资源号            三阶段内容一致
 *   资源编译          纯 JS 重写，对比 restool 1.022 的产物            index / R.txt /
 *                                                                    png 全部字节一致
 *   JS 编译           node + ace-loader 独立跑通                      COMPILE RESULT:SUCCESS
 *   .bin 签名         与 gradle 产物逐段对比                          proBlock/signBlock/
 *                                                                    econtent 头完全一致
 *   .app 签名         产出的包交给 hapsigntoolv2 的 verify             Verify success
 *
 * 资源编译（resources.index / R.txt / 图片压缩）已经不再调 restool.exe，
 * 实现在 compileResources.js，格式来源见各模块注释。
 *
 * 图片转 .bin 不由本 SDK 负责 —— ace-loader 的 lite-image2bin.js 在 webpack 阶段
 * 顺手就做了，本 SDK 只负责删掉它留下的 xxx.png.bin 双后缀副本。
 */

export { resolveTools, resolveNode } from "./findTools.js";

export {
  readBin,
  writeBin,
  isSignedBin,
  stripSignature,
  SIGN_HEAD_ASCII
} from "./readWriteBin.js";

export { packHap } from "./packHap.js";

export { readZip, writeZip, crc32 } from "./readWriteZip.js";

export { mergeProfile, processProfile, stringifyConfig } from "./processConfig.js";

export { parseRTable, fillResourceIds } from "./parseResourceTable.js";

export { compileResources } from "./compileResources.js";

export { compressPng, isSupportedPng } from "./compressPng.js";

export { compileJs } from "./runWebpack.js";

export { prepareSigning, signBin, signZip, parseP7b, loadPrivateKey, slicedSha256 } from "./sign/index.js";

// 工程布局探测（Gradle / Hvigor，含 API 10 的 "4.0.0(10)" 版本串）
export {
  resolveProject,
  resolveComponents,
  apiLevelFrom,
  LAYOUT_GRADLE,
  LAYOUT_HVIGOR
} from "./resolveProject.js";

// ace-loader 按 API 级别的兼容补丁
export { ensureCssCompat, restoreCssCompat } from "./aceLoaderCompat.js";
