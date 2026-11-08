import fs from "fs";
import path from "path";

import pako from "pako";
import { decodePngPixels } from "./compressPng.js";
import { toRgba } from "./imageToBin.js";
import { crc32 } from "./readWriteZip.js";
import * as log from "./logger.js";

/**
 * 补齐并校正 Lite Wearable 应用图标（Hvigor / API 8+ 布局）
 *
 * 真机可装包的 resources.index 同时登记 icon.png(114x114) 与
 * icon_small.png(80x80)，media 里也有对应的 BGRA .bin：
 *   icon.bin       114*114*4 + 8 = 51992 B
 *   icon_small.bin  80* 80*4 + 8 = 25608 B
 * 缺图、或尺寸不对，在应用调测助手安装时都会报「40.配置文件格式错误」。
 *
 * 这里在资源编译的扫描结果里替换/注入生成文件：
 *   - 不改工程源码，生成物落在 outDir/.generated（中间产物目录）
 *   - 作为 media.files 的一项，自动进 resources.index、被 copyResourceFiles
 *     复制到产物目录，再由 ace-loader 的 img2bin 转成对应 .bin
 *   - 尺寸不符时等比居中到目标尺寸，空白填透明，不拉伸
 */

export const ICON_SIZE = 114;
export const ICON_SMALL_SIZE = 80;

/** 等比居中缩放，空白透明，不拉伸 */
function fitCenter(src, sw, sh, dw, dh) {
  const out = Buffer.alloc(dw * dh * 4);
  const scale = Math.min(dw / sw, dh / sh);
  const nw = Math.max(1, Math.round(sw * scale));
  const nh = Math.max(1, Math.round(sh * scale));
  const ox = Math.floor((dw - nw) / 2);
  const oy = Math.floor((dh - nh) / 2);
  for (let y = 0; y < nh; y++) {
    for (let x = 0; x < nw; x++) {
      const sx = Math.min(sw - 1, Math.floor((x * sw) / nw));
      const sy = Math.min(sh - 1, Math.floor((y * sh) / nh));
      const s = (sy * sw + sx) * 4;
      const d = ((y + oy) * dw + x + ox) * 4;
      src.copy(out, d, s, s + 4);
    }
  }
  return out;
}

function pngChunk(type, data) {
  const b = Buffer.alloc(12 + data.length);
  b.writeUInt32BE(data.length, 0);
  b.write(type, 4, "latin1");
  data.copy(b, 8);
  b.writeUInt32BE(crc32(Buffer.concat([b.subarray(4, 8), data])) >>> 0, 8 + data.length);
  return b;
}

/** 8bit RGBA、非隔行、filter=0 的最小 PNG 编码 */
function encodePng(rgba, w, h) {
  const raw = Buffer.alloc(h * (1 + w * 4));
  for (let y = 0; y < h; y++) {
    rgba.copy(raw, y * (1 + w * 4) + 1, y * w * 4, (y + 1) * w * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", Buffer.from(pako.deflate(raw, { level: 9 }))),
    pngChunk("IEND", Buffer.alloc(0))
  ]);
}

function setGenerated(media, filename, genPath) {
  const i = media.files.findIndex((f) => path.basename(f).toLowerCase() === filename);
  if (i >= 0) media.files[i] = genPath;
  else media.files.push(genPath);
  media.files.sort();
}

function findPng(media, filename) {
  return media.files.find((f) => path.basename(f).toLowerCase() === filename) ?? null;
}

function readPng(file) {
  if (!file) return null;
  try {
    return decodePngPixels(fs.readFileSync(file));
  } catch {
    return null;
  }
}

/**
 * @param {Array} scanned scanResourceFiles() 的结果（原地修改 media.files）
 * @param {string} outDir 资源编译的输出目录
 * @returns {{generated:string[], iconSize?:string, smallSize?:string}}
 * @throws 缺 base/media、缺 icon.png、icon.png 解不开、或补完仍缺任一图标时抛错终止构建
 */
export function ensureAppIcons(scanned, outDir) {
  const result = { generated: [] };
  const base = scanned.find((c) => c.limitKey === "base");
  const media = base?.clusters.find((c) => c.cluster === "media");
  if (!media) {
    throw new Error(
      "[icon] 没有 base/media 资源簇 —— Lite Wearable 应用图标必须在 entry/src/main/resources/base/media/ 下"
    );
  }

  const iconFile = findPng(media, "icon.png");
  if (!iconFile) {
    throw new Error(
      "[icon] 缺 icon.png（114x114）—— 缺它会安装失败并报「40.配置文件格式错误」，构建终止"
    );
  }
  const icon = readPng(iconFile);
  if (!icon) {
    throw new Error(
      `[icon] icon.png 读不出像素：${iconFile}\n` +
        "      需 8bit、非隔行、非调色板的 PNG（否则没法校验尺寸，也没法生成 icon_small）"
    );
  }

  const genDir = path.join(outDir, ".generated");
  fs.mkdirSync(genDir, { recursive: true });

  result.iconSize = `${icon.width}x${icon.height}`;
  let iconRgba = toRgba(icon);

  // 主图标：尺寸不对就等比居中到 114x114
  if (icon.width !== ICON_SIZE || icon.height !== ICON_SIZE) {
    iconRgba = fitCenter(iconRgba, icon.width, icon.height, ICON_SIZE, ICON_SIZE);
    const p = path.join(genDir, "icon.png");
    fs.writeFileSync(p, encodePng(iconRgba, ICON_SIZE, ICON_SIZE));
    setGenerated(media, "icon.png", p);
    result.generated.push("icon.png(114x114)");
    log.warn(`icon.png 原为 ${result.iconSize}，已等比居中到 ${ICON_SIZE}x${ICON_SIZE}（安装错误码 40 要求）`);
  }

  // 小图标：缺失或尺寸不对，一律从主图标等比居中到 80x80
  const smallFile = findPng(media, "icon_small.png");
  const small = readPng(smallFile);
  result.smallSize = small ? `${small.width}x${small.height}` : "缺失";
  if (!small || small.width !== ICON_SMALL_SIZE || small.height !== ICON_SMALL_SIZE) {
    const fitted = fitCenter(iconRgba, ICON_SIZE, ICON_SIZE, ICON_SMALL_SIZE, ICON_SMALL_SIZE);
    const p = path.join(genDir, "icon_small.png");
    fs.writeFileSync(p, encodePng(fitted, ICON_SMALL_SIZE, ICON_SMALL_SIZE));
    setGenerated(media, "icon_small.png", p);
    result.generated.push("icon_small.png(80x80)");
  }

  if (result.generated.length) {
    log.info(`应用图标已补: ${result.generated.join(" + ")}，随 resources.index 登记`);
  }

  // ── 强制检测：补完还缺任何一个，直接抛错终止构建 ─────────────────────
  // 宁可不出包，也不要出一个装上就报「40.配置文件格式错误」的包。
  for (const [name, size] of [["icon.png", ICON_SIZE], ["icon_small.png", ICON_SMALL_SIZE]]) {
    if (!findPng(media, name)) {
      throw new Error(`[icon] ${name}（${size}x${size}）缺失或生成失败 —— 构建终止（安装会报错误码 40）`);
    }
  }
  return result;
}
