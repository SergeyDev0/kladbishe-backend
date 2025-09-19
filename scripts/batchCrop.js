// Batch-crop all images from ./img and save to ./uploads using the same
// bottom-crop logic as the /crop endpoint (remove ~12% from bottom).
// Usage: node scripts/batchCrop.js

const fs = require('node:fs/promises');
const fssync = require('node:fs');
const path = require('node:path');
const sharp = require('sharp');

const SRC_DIR = path.resolve(process.cwd(), 'img');
const OUT_DIR = path.resolve(process.cwd(), 'uploads');
const SUPPORTED = new Set(['.jpg', '.jpeg', '.png', '.webp', '.tiff', '.gif']);

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

async function isFile(p) {
  try {
    const st = await fs.stat(p);
    return st.isFile();
  } catch {
    return false;
  }
}

async function cropBottomBannerBuffer(imageBuffer) {
  const metadata = await sharp(imageBuffer).metadata();
  const format = metadata.format || 'jpeg';
  const width = metadata.width;
  const height = metadata.height;

  if (!width || !height || width <= 0 || height <= 0) {
    throw new Error(`Invalid image dimensions: width=${width}, height=${height}`);
  }

  // Convert to JPEG buffer for consistent processing; we'll save in original format later
  let processedBuffer = imageBuffer;
  if (format !== 'jpeg') {
    processedBuffer = await sharp(imageBuffer).jpeg().toBuffer();
  }

  // Crop bottom 12%
  const cropHeight = Math.floor(height * 0.12);
  const finalHeight = height - cropHeight;
  if (finalHeight <= 0) {
    throw new Error('Computed final height <= 0');
  }

  const croppedBuffer = await sharp(processedBuffer)
    .extract({ left: 0, top: 0, width, height: finalHeight })
    .toBuffer();

  return { croppedBuffer, format };
}

async function saveInOriginalFormat(buffer, outPath) {
  const ext = path.extname(outPath).toLowerCase();
  const img = sharp(buffer);
  if (ext === '.png') return img.png().toFile(outPath);
  if (ext === '.webp') return img.webp().toFile(outPath);
  if (ext === '.tiff') return img.tiff().toFile(outPath);
  if (ext === '.gif') return img.gif().toFile(outPath);
  return img.jpeg().toFile(outPath);
}

async function processOne(filePath) {
  const base = path.basename(filePath);
  const ext = path.extname(base).toLowerCase();
  if (!SUPPORTED.has(ext)) {
    console.log(`Skip (unsupported): ${base}`);
    return;
  }

  try {
    const buf = await fs.readFile(filePath);
    const { croppedBuffer } = await cropBottomBannerBuffer(buf);
    const nameNoExt = path.basename(base, ext);
    const outName = `${nameNoExt}${ext}`;
    const outPath = path.join(OUT_DIR, outName);
    await saveInOriginalFormat(croppedBuffer, outPath);
    console.log(`Cropped → ${outPath}`);
  } catch (err) {
    console.error(`Fail: ${base}: ${err.message}`);
  }
}

async function main() {
  if (!fssync.existsSync(SRC_DIR)) {
    console.error(`Source directory not found: ${SRC_DIR}`);
    process.exit(1);
  }
  await ensureDir(OUT_DIR);
  const entries = await fs.readdir(SRC_DIR);
  // Process sequentially to avoid memory spikes; change to Promise.all for parallel
  for (const entry of entries) {
    const full = path.join(SRC_DIR, entry);
    if (await isFile(full)) {
      await processOne(full);
    }
  }
  console.log('Done.');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});



