import fs from "fs";
import path from "path";

import { decodePngPixels } from "./compressPng.js";

/**
 * PNG → Lite Wearable 图片 `.bin`（纯 JS，零原生依赖）
 *
 * 格式（实测产物，并与 ace-loader/lib/lite/lite-image2bin.js 的实现对齐）：
 *   uint32LE  256                 固定魔数
 *   uint32LE  width | height<<16  尺寸
 *   byte[]    BGRA × width×height 真机只认这个顺序，A 原样保留
 *
 * 为什么要自己写：ace-loader 的图片转换是 `require("sharp")`，sharp 是带
 * prebuilt binary 的原生模块，Termux / 浏览器 / 大部分手机环境装不上；而
 * `lite-image-coverter-plugin.js` 还可能 exec 外部 pngquant。这是「纯 Node
 * 构建器」在手机端剩下的最后一块原生依赖。
 *
 * 本模块复用 compressPng.js 的 PNG chunk 解析 + 反滤波（底层只用 pako），
 * 再把 8bit 非隔行的 gray / gray+alpha / RGB / RGBA 统一成 RGBA，
 * 因此不引入任何新依赖，浏览器里也能跑。
 *
 * 能力边界（不猜、不静默跳过）：
 *   - 只支持 8bit 非隔行 PNG。16bit / 隔行 / 调色板 / JPG / SVG / ICO 明确报错。
 *   - SVG 的 `--topng` 需要光栅化引擎，纯 JS 做不了；调用方应事先把 SVG 转成 PNG
 *     （hap-sign-utils/image-to-bin.html 就是干这个的）。
 */

const IMG_MAGIC = 256;

/** 把 decodePngPixels 的裸像素按 colorType 展开成 RGBA */
export function toRgba(decoded) {
  const { width, height, bpp, colorType, pixels } = decoded;
  const rgba = Buffer.allocUnsafe(width * height * 4);

  for (let i = 0, o = 0; i < width * height; i++, o += 4) {
    const p = i * bpp;
    switch (colorType) {
      case 0: // gray
        rgba[o] = rgba[o + 1] = rgba[o + 2] = pixels[p];
        rgba[o + 3] = 255;
        break;
      case 4: // gray + alpha
        rgba[o] = rgba[o + 1] = rgba[o + 2] = pixels[p];
        rgba[o + 3] = pixels[p + 1];
        break;
      case 2: // RGB
        rgba[o] = pixels[p];
        rgba[o + 1] = pixels[p + 1];
        rgba[o + 2] = pixels[p + 2];
        rgba[o + 3] = 255;
        break;
      case 6: // RGBA
        rgba[o] = pixels[p];
        rgba[o + 1] = pixels[p + 1];
        rgba[o + 2] = pixels[p + 2];
        rgba[o + 3] = pixels[p + 3];
        break;
      default:
        throw new Error(`不支持的 PNG colorType ${colorType}`);
    }
  }
  return rgba;
}

/** RGBA → BGRA .bin */
export function rgbaToBin(rgba, width, height) {
  const expected = width * height * 4;
  if (rgba.length !== expected) {
    throw new Error(`RGBA 长度 ${rgba.length} 与 ${width}x${height} 不符（应为 ${expected}）`);
  }
  const out = Buffer.allocUnsafe(8 + expected);
  out.writeUInt32LE(IMG_MAGIC, 0);
  out.writeUInt32LE((width | (height << 16)) >>> 0, 4);
  for (let i = 0, o = 8; i < expected; i += 4, o += 4) {
    out[o] = rgba[i + 2];
    out[o + 1] = rgba[i + 1];
    out[o + 2] = rgba[i];
    out[o + 3] = rgba[i + 3];
  }
  return out;
}

/** PNG 字节 → .bin 字节 */
export function pngToBin(input) {
  const decoded = decodePngPixels(input);
  if (!decoded) {
    throw new Error("不支持的 PNG（只认 8bit、非隔行、非调色板），请先用 image-to-bin.html 转成标准 PNG");
  }
  return rgbaToBin(toRgba(decoded), decoded.width, decoded.height);
}

/** 校验一个图片 .bin，自检器用 */
export function inspectBin(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 8) {
    return { ok: false, reason: "文件太短，读不出 8 字节头" };
  }
  const magic = buf.readUInt32LE(0);
  const packed = buf.readUInt32LE(4);
  const width = packed & 0xffff;
  const height = (packed >>> 16) & 0xffff;
  const expected = 8 + width * height * 4;
  const ok = magic === IMG_MAGIC && width > 0 && height > 0 && buf.length === expected;
  return { ok, magic, width, height, bytes: buf.length, expected };
}

/**
 * 复刻 ace-loader 的 `lite-image-coverter-plugin.js` 文件名标记：
 *   "foo --nobin.png"      → 输出 foo.png，不产 .bin
 *   "foo --topng.svg"      → 想输出 foo.png（纯 JS 不支持光栅化，归到 unsupported）
 *   "foo --pngquant 80.png"→ 忽略质量参数，不压缩
 */
export function parseImageName(fileName) {
  const ext = path.extname(fileName);
  const tokens = path.basename(fileName, ext).split(" ");
  const clean = [];
  let toPng = false;
  let generateBin = true;
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] === "--topng") toPng = true;
    else if (tokens[i] === "--nobin") generateBin = false;
    else if (tokens[i] === "--pngquant") i++; // 跳过质量值
    else clean.push(tokens[i]);
  }
  return {
    outputName: clean.join(" ").trim(),
    outputExt: toPng ? ".png" : ext,
    toPng,
    generateBin
  };
}

/**
 * 遍历目录，把里面所有 PNG 转成同名 .bin（与 ace-loader 插件同样的落地方式）。
 *
 * @param {string} dir
 * @param {object} [opts]
 * @param {(info:{file:string,reason:string})=>void} [opts.onUnsupported]
 *        SVG / JPG / ICO 等不支持的文件交给调用方决定（记录 / 回退 sharp / 抛错）
 * @returns {{converted:string[], skipped:string[], unsupported:string[]}}
 */
export function convertPngsInDir(dir, opts = {}) {
  const result = { converted: [], skipped: [], unsupported: [] };
  if (!fs.existsSync(dir)) return result;

  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      const sub = convertPngsInDir(full, opts);
      result.converted.push(...sub.converted);
      result.skipped.push(...sub.skipped);
      result.unsupported.push(...sub.unsupported);
      continue;
    }

    const ext = path.extname(ent.name).toLowerCase();
    if (ext !== ".png") {
      if ([".svg", ".jpg", ".jpeg", ".bmp", ".ico", ".webp"].includes(ext)) {
        result.unsupported.push(full);
        opts.onUnsupported?.({ file: full, reason: `纯 JS 图片转换不支持 ${ext}` });
      }
      continue;
    }

    const meta = parseImageName(ent.name);
    if (!meta.outputName) throw new Error(`图片名清理后为空：${full}`);
    const outBase = path.join(dir, meta.outputName);

    // 文件名带标记时先归一，产物名必须和 ace-loader 一致
    if (outBase + meta.outputExt !== full) fs.renameSync(full, outBase + meta.outputExt);

    if (!meta.generateBin) {
      result.skipped.push(outBase + meta.outputExt);
      continue;
    }

    const bin = pngToBin(fs.readFileSync(outBase + meta.outputExt));
    fs.writeFileSync(outBase + ".bin", bin);
    result.converted.push(outBase + ".bin");
  }

  return result;
}
