#!/usr/bin/env node
// Sinh asset art qua Gemini (Google AI API).
//
//   npm run asset -- "<prompt>" <out.png> [tùy chọn]
//
// Tùy chọn:
//   --ratio 1:1|16:9|9:16|4:3|3:4|...   tỉ lệ khung (mặc định 1:1)
//   --transparent                         xin nền magenta rồi xóa nền -> ảnh trong suốt (cần sharp)
//   --size 512                            cạnh dài tối đa khi xuất WebP (mặc định giữ nguyên)
//   --quality 82                          chất lượng WebP
//   --no-style                            không ghép tools/art-style.md vào prompt
//   --model <id>                          ghi đè model (mặc định GEMINI_IMAGE_MODEL hoặc gemini-2.5-flash-image)
//   --ref <ảnh>                           gửi kèm ảnh ref (png/jpg/webp) để Gemini bám style; lặp lại được
//   --dry                                 chỉ in prompt cuối, không gọi API
//
// Key: GEMINI_API_KEY trong .env.local của game hoặc thư mục cha (vd. Game NOC/.env.local),
// cuối cùng là ~/.config/gamekit-gemini/.env.local (dùng chung cho game ở bất kỳ đâu trên máy).
// Có sharp -> src/assets/<tên>.webp vào game, PNG gốc cất ở tools/art-src/ (không bị nhúng vào build).
// Không có sharp -> chỉ lưu PNG ở đường dẫn đã cho.
// Tên file = khóa dùng trong game: art('apple') <- src/assets/apple.webp.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = process.cwd();
const GLOBAL_ENV = path.join(os.homedir(), '.config/gamekit-gemini/.env.local');
const RAW_DIR = path.join(ROOT, 'tools/art-src');
const STYLE_FILE = path.join(ROOT, 'tools/art-style.md');
const MANIFEST = path.join(ROOT, 'src/assets/manifest.json');

function parseArgs(argv) {
  const opts = { ratio: '1:1', transparent: false, style: true, quality: 82, dry: false, refs: [] };
  const pos = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--transparent') opts.transparent = true;
    else if (a === '--no-style') opts.style = false;
    else if (a === '--dry') opts.dry = true;
    else if (a === '--ratio') opts.ratio = argv[++i];
    else if (a === '--size') opts.size = Number(argv[++i]);
    else if (a === '--quality') opts.quality = Number(argv[++i]);
    else if (a === '--model') opts.model = argv[++i];
    else if (a === '--ref') opts.refs.push(argv[++i]);
    else pos.push(a);
  }
  [opts.prompt, opts.out] = pos;
  return opts;
}

function die(msg) {
  console.error(`✖ ${msg}`);
  process.exit(1);
}

function buildPrompt({ prompt, style, transparent, refs }) {
  const parts = [];
  if (style && fs.existsSync(STYLE_FILE)) parts.push(fs.readFileSync(STYLE_FILE, 'utf8').trim());
  if (refs.length) {
    parts.push(
      `The ${refs.length > 1 ? `${refs.length} attached images are` : 'attached image is'} the art reference. ` +
        'Match its rendering style, materials, colour palette, lighting, outline weight and camera angle as closely as possible; ' +
        'do not copy its layout or any text unless the asset description asks for it.'
    );
  }
  parts.push(`Asset: ${prompt}`);
  if (transparent) {
    parts.push(
      'Place the subject alone, centered, on a solid flat pure magenta (#FF00FF) background. ' +
        'No shadow on the background, no gradient, no other magenta anywhere in the subject.'
    );
  }
  return parts.join('\n\n');
}

const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };

function refPart(file) {
  const abs = path.resolve(ROOT, file);
  if (!fs.existsSync(abs)) die(`Không thấy ảnh ref: ${file}`);
  const mimeType = MIME[path.extname(abs).toLowerCase()];
  if (!mimeType) die(`Ảnh ref phải là png/jpg/webp: ${file}`);
  return { inlineData: { mimeType, data: fs.readFileSync(abs).toString('base64') } };
}

async function callGemini({ key, model, text, ratio, refs }) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify({
      contents: [{ parts: [...refs.map(refPart), { text }] }],
      generationConfig: { responseModalities: ['IMAGE'], imageConfig: { aspectRatio: ratio } },
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${body?.error?.message ?? res.statusText}`);
  const parts = body?.candidates?.[0]?.content?.parts ?? [];
  const img = parts.find((p) => p.inlineData?.data);
  if (!img) {
    const why = body?.candidates?.[0]?.finishReason ?? body?.promptFeedback?.blockReason ?? 'không rõ';
    throw new Error(`Gemini không trả ảnh (lý do: ${why})`);
  }
  return Buffer.from(img.inlineData.data, 'base64');
}

async function loadSharp() {
  try {
    return (await import('sharp')).default;
  } catch {
    return null;
  }
}

// Xóa nền: Gemini không tô đúng #FF00FF, nên lấy màu nền thật (trung vị các pixel viền),
// rồi loang từ viền vào những pixel gần màu đó -> nền trong vật thể không bị xóa nhầm.
// Viền chuyển mềm và khử ám hồng ở rìa.
async function removeKeyBackground(sharp, buf) {
  const { data, info } = await sharp(buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width: w, height: h } = info;
  const border = [];
  for (let x = 0; x < w; x++) border.push(x, (h - 1) * w + x);
  for (let y = 1; y < h - 1; y++) border.push(y * w, y * w + w - 1);
  const median = (c) => border.map((p) => data[p * 4 + c]).sort((a, b) => a - b)[border.length >> 1];
  const [kr, kg, kb] = [median(0), median(1), median(2)];

  const hard = 40, soft = 100;
  const dist = (p) => Math.hypot(data[p * 4] - kr, data[p * 4 + 1] - kg, data[p * 4 + 2] - kb);
  const seen = new Uint8Array(w * h);
  const stack = border.filter((p) => dist(p) < soft);
  for (const p of stack) seen[p] = 1;
  while (stack.length) {
    const p = stack.pop();
    const d = dist(p);
    const i = p * 4;
    if (d < hard) data[i + 3] = 0;
    else {
      const t = (d - hard) / (soft - hard);
      data[i + 3] = Math.round(data[i + 3] * t);
      const spill = Math.max(0, Math.min(data[i], data[i + 2]) - data[i + 1]) * (1 - t);
      data[i] -= spill;
      data[i + 2] -= spill;
      continue; // pixel rìa: không loang tiếp vào trong vật thể
    }
    const x = p % w;
    for (const q of [p - w, p + w, x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1]) {
      if (q >= 0 && q < w * h && !seen[q] && dist(q) < soft) {
        seen[q] = 1;
        stack.push(q);
      }
    }
  }
  return sharp(data, { raw: info }).png().toBuffer();
}

function recordManifest(entry) {
  let list = [];
  if (fs.existsSync(MANIFEST)) {
    try {
      list = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
    } catch {
      die(`${path.relative(ROOT, MANIFEST)} không phải JSON hợp lệ`);
    }
  }
  list = list.filter((e) => e.file !== entry.file);
  list.push(entry);
  fs.mkdirSync(path.dirname(MANIFEST), { recursive: true });
  fs.writeFileSync(MANIFEST, JSON.stringify(list, null, 2) + '\n');
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.prompt || !opts.out) die('Cách dùng: npm run asset -- "<prompt>" <out.png> [--ratio 16:9] [--transparent]');

  const text = buildPrompt(opts);
  if (opts.dry) {
    if (opts.refs.length) console.log(`[ref: ${opts.refs.join(', ')}]\n`);
    console.log(text);
    return;
  }

  // .env.local của game trước, rồi các thư mục cha (vd. Game NOC/.env.local dùng chung, ngoài git).
  for (let dir = ROOT; ; dir = path.dirname(dir)) {
    const env = path.join(dir, '.env.local');
    if (fs.existsSync(env)) process.loadEnvFile(env);
    if (process.env.GEMINI_API_KEY || dir === path.dirname(dir)) break;
  }
  if (!process.env.GEMINI_API_KEY && fs.existsSync(GLOBAL_ENV)) process.loadEnvFile(GLOBAL_ENV);
  const key = process.env.GEMINI_API_KEY;
  if (!key) die('Thiếu GEMINI_API_KEY trong .env.local -> dùng fallback (Claude tự vẽ SVG/Canvas).');
  const model = opts.model ?? process.env.GEMINI_IMAGE_MODEL ?? 'gemini-2.5-flash-image';

  console.log(`→ Gọi ${model} (${opts.ratio}${opts.transparent ? ', trong suốt' : ''}${opts.refs.length ? `, ${opts.refs.length} ảnh ref` : ''})…`);
  let png = await callGemini({ key, model, text, ratio: opts.ratio, refs: opts.refs });

  const sharp = await loadSharp();
  if (sharp) png = await sharp(png).png().toBuffer();
  if (opts.transparent) {
    if (sharp) png = await removeKeyBackground(sharp, png);
    else console.warn('⚠ Chưa cài sharp: không xóa được nền (npm i -D sharp).');
  }

  const target = path.resolve(ROOT, opts.out.replace(/\.(png|webp|jpe?g)$/i, ''));
  const write = (file, buf) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, buf);
  };

  let file;
  if (sharp) {
    const raw = path.join(RAW_DIR, path.basename(target) + '.png');
    write(raw, png);
    file = target + '.webp';
    let img = sharp(png);
    if (opts.size) img = img.resize(opts.size, opts.size, { fit: 'inside', withoutEnlargement: true });
    write(file, await img.webp({ quality: opts.quality, alphaQuality: 90 }).toBuffer());
    const kb = (n) => (fs.statSync(n).size / 1024).toFixed(0) + 'KB';
    console.log(`✔ ${path.relative(ROOT, file)} (${kb(raw)} → ${kb(file)}; gốc: ${path.relative(ROOT, raw)})`);
  } else {
    file = target + '.png';
    write(file, png);
    console.log(`✔ ${path.relative(ROOT, file)}`);
    console.warn('⚠ Chưa cài sharp: chưa nén WebP (npm i -D sharp).');
  }

  recordManifest({
    file: path.relative(ROOT, file),
    prompt: opts.prompt,
    model,
    ratio: opts.ratio,
    transparent: opts.transparent,
    style: opts.style,
    refs: opts.refs,
    date: new Date().toISOString().slice(0, 10),
  });
}

main().catch((e) => die(e.message));
