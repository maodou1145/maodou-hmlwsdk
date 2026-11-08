import pako from "pako";

import { crc32 } from "./readWriteZip.js";

/**
 * PNG 编码与图标缩放（纯 JS，零原生依赖）
 *
 * 应用图标只有一种合法形态：8bit、RGBA、非隔行、filter 全 0。
 * 构建期补图（ensureAppIcons）和成品包修复（checkPackage）共用这里，
 * 保证两边生成的字节完全一致。
 */

export const ICON = 114;
export const ICON_SMALL = 80;

function pngChunk(type, data) {
  const b = Buffer.alloc(12 + data.length);
  b.writeUInt32BE(data.length, 0);
  b.write(type, 4, "latin1");
  data.copy(b, 8);
  b.writeUInt32BE(crc32(Buffer.concat([b.subarray(4, 8), data])) >>> 0, 8 + data.length);
  return b;
}

/** RGBA → 最小 PNG */
export function encodePng(rgba, w, h) {
  const raw = Buffer.alloc(h * (1 + w * 4));
  for (let y = 0; y < h; y++) rgba.copy(raw, y * (1 + w * 4) + 1, y * w * 4, (y + 1) * w * 4);
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

/** 读 PNG 头（不解码像素），不是 PNG 返回 null */
export function readPngSize(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 33 || buf.readUInt32BE(0) !== 0x89504e47) return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), bitDepth: buf[24], colorType: buf[25], interlace: buf[28] };
}

/** 等比居中缩放，空白透明，不拉伸 */
export function fitCenter(src, sw, sh, dw, dh) {
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
      src.copy(out, ((y + oy) * dw + x + ox) * 4, (sy * sw + sx) * 4, (sy * sw + sx) * 4 + 4);
    }
  }
  return out;
}
