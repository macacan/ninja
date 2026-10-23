import sharp from 'sharp';
import fs from 'fs';
import path from 'path';

const inputPath = 'C:/Users/Martin/.gemini/antigravity-ide/brain/22e09069-f2de-40c6-bcbb-d37b2d36256c/.user_uploaded/media_1792760238328.jpg';

// Helper to create standard multi-size Windows ICO with embedded PNGs
function createIco(images) {
  // images: array of { width, height, buffer }
  const headerSize = 6;
  const dirEntrySize = 16;
  const dirSize = dirEntrySize * images.length;
  let offset = headerSize + dirSize;

  const header = Buffer.alloc(headerSize);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // ICO type
  header.writeUInt16LE(images.length, 4);

  const dirEntries = [];
  const buffers = [];

  for (const img of images) {
    const entry = Buffer.alloc(dirEntrySize);
    entry.writeUInt8(img.width >= 256 ? 0 : img.width, 0);
    entry.writeUInt8(img.height >= 256 ? 0 : img.height, 1);
    entry.writeUInt8(0, 2); // color palette count (0 for 32bpp)
    entry.writeUInt8(0, 3); // reserved
    entry.writeUInt16LE(1, 4); // color planes
    entry.writeUInt16LE(32, 6); // bits per pixel
    entry.writeUInt32LE(img.buffer.length, 8); // image size in bytes
    entry.writeUInt32LE(offset, 12); // image offset in file

    dirEntries.push(entry);
    buffers.push(img.buffer);
    offset += img.buffer.length;
  }

  return Buffer.concat([header, ...dirEntries, ...buffers]);
}

async function generateAssets() {
  console.log('Generating badge master...');
  const size = 612;
  const radius = size / 2;
  // Circular mask
  const circleMask = Buffer.from(
    `<svg width="${size}" height="${size}"><circle cx="${radius}" cy="${radius}" r="${radius}" fill="white"/></svg>`
  );

  // 1. Master circular badge with transparency outside circle
  const badgeMaster = await sharp(inputPath)
    .extract({ left: 206, top: 205, width: size, height: size })
    .composite([{ input: circleMask, blend: 'dest-in' }])
    .png()
    .toBuffer();

  console.log('Master badge created, size:', badgeMaster.length);

  // 2. Generate 512x512 logo (img/logo-512.png)
  const logo512 = await sharp(badgeMaster)
    .resize(512, 512, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();
  fs.writeFileSync('c:/Users/Martin/Desktop/ninjaloot/img/logo-512.png', logo512);
  console.log('Saved img/logo-512.png');

  // 3. Generate 192x192 icon (img/icon-192.png)
  const icon192 = await sharp(badgeMaster)
    .resize(192, 192, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();
  fs.writeFileSync('c:/Users/Martin/Desktop/ninjaloot/img/icon-192.png', icon192);
  console.log('Saved img/icon-192.png');

  // 4. Generate 48x48 favicon (img/favicon-48.png)
  const favicon48 = await sharp(badgeMaster)
    .resize(48, 48, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();
  fs.writeFileSync('c:/Users/Martin/Desktop/ninjaloot/img/favicon-48.png', favicon48);
  console.log('Saved img/favicon-48.png');

  // 5. Generate apple-touch-icon (180x180) - Solid dark background #131722 so iOS doesn't render black
  const appleTouchInner = await sharp(badgeMaster)
    .resize(164, 164, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();
  const appleTouchIcon = await sharp({
    create: {
      width: 180,
      height: 180,
      channels: 4,
      background: { r: 19, g: 23, b: 34, alpha: 1 } // #131722 matching dark ninja theme
    }
  })
    .composite([{ input: appleTouchInner, gravity: 'center' }])
    .png()
    .toBuffer();
  fs.writeFileSync('c:/Users/Martin/Desktop/ninjaloot/img/apple-touch-icon.png', appleTouchIcon);
  console.log('Saved img/apple-touch-icon.png');

  // 6. Generate maskable icon (512x512) for PWA - safe zone is inner 80% (410px) with dark background #131722
  const maskableInner = await sharp(badgeMaster)
    .resize(410, 410, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();
  const maskableIcon = await sharp({
    create: {
      width: 512,
      height: 512,
      channels: 4,
      background: { r: 19, g: 23, b: 34, alpha: 1 }
    }
  })
    .composite([{ input: maskableInner, gravity: 'center' }])
    .png()
    .toBuffer();
  fs.writeFileSync('c:/Users/Martin/Desktop/ninjaloot/img/icon-512-maskable.png', maskableIcon);
  console.log('Saved img/icon-512-maskable.png');

  // 7. Generate favicon.ico (16, 32, 48)
  const ico16 = await sharp(badgeMaster).resize(16, 16).png().toBuffer();
  const ico32 = await sharp(badgeMaster).resize(32, 32).png().toBuffer();
  const icoData = createIco([
    { width: 16, height: 16, buffer: ico16 },
    { width: 32, height: 32, buffer: ico32 },
    { width: 48, height: 48, buffer: favicon48 }
  ]);
  fs.writeFileSync('c:/Users/Martin/Desktop/ninjaloot/favicon.ico', icoData);
  console.log('Saved favicon.ico');

  // 8. Generate logo.svg with embedded high-res PNG
  const logo512Base64 = logo512.toString('base64');
  const svgContent = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  <image href="data:image/png;base64,${logo512Base64}" x="0" y="0" width="512" height="512"/>
</svg>
`;
  fs.writeFileSync('c:/Users/Martin/Desktop/ninjaloot/logo.svg', svgContent, 'utf8');
  console.log('Saved logo.svg');

  console.log('All logo and favicon assets successfully generated!');
}

generateAssets().catch(console.error);
