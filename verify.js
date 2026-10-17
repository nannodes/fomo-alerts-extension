#!/usr/bin/env node
// © 2026 FOMO Alerts. All rights reserved.
// Checks that FOMO Alerts in the Chrome Web Store is exactly the code in this repository.
// It downloads the extension from Google's own servers (the same file Chrome installs) and compares every file.
//
//   node verify.js            compare the store's current version with ./extension
//   node verify.js <folder>   compare it with another folder (for example an older version)
//
// Needs Node.js 18 or newer, nothing else.
'use strict';
const zlib = require('zlib');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ID = 'ioakhcjlledhimdgkppifpffapgjlkmm'; // FOMO Alerts in the Chrome Web Store
const CRX_URL = `https://clients2.google.com/service/update2/crx?response=redirect&prodversion=150.0&acceptformat=crx2,crx3&x=id%3D${ID}%26uc`;
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

// A .crx file is a header with Google's signatures, then a normal zip
function zipOf(crx) {
  if (crx.toString('latin1', 0, 4) !== 'Cr24') throw new Error('The download is not a Chrome extension file');
  const version = crx.readUInt32LE(4);
  if (version === 3) return crx.subarray(12 + crx.readUInt32LE(8));
  if (version === 2) return crx.subarray(16 + crx.readUInt32LE(8) + crx.readUInt32LE(12));
  throw new Error('Unknown .crx version ' + version);
}

// the files in a zip: name -> contents
function unzip(zip) {
  let end = zip.length - 22;
  while (end >= 0 && zip.readUInt32LE(end) !== 0x06054b50) end--;
  if (end < 0) throw new Error('No zip inside the .crx file');
  const files = new Map();
  let p = zip.readUInt32LE(end + 16);
  for (let i = zip.readUInt16LE(end + 10); i > 0; i--) {
    if (zip.readUInt32LE(p) !== 0x02014b50) throw new Error('Broken zip');
    const method = zip.readUInt16LE(p + 10);
    const size = zip.readUInt32LE(p + 20);
    const nameLen = zip.readUInt16LE(p + 28);
    const local = zip.readUInt32LE(p + 42);
    const name = zip.toString('utf8', p + 46, p + 46 + nameLen);
    p += 46 + nameLen + zip.readUInt16LE(p + 30) + zip.readUInt16LE(p + 32);
    if (name.endsWith('/')) continue;
    const at = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    const data = zip.subarray(at, at + size);
    if (method !== 0 && method !== 8) throw new Error(`Unknown compression for ${name}`);
    files.set(name, method === 8 ? zlib.inflateRawSync(data) : data);
  }
  return files;
}

// the files in a folder: "dir/name" -> contents
function folder(dir, base = dir, out = new Map()) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const f = path.join(dir, e.name);
    if (e.isDirectory()) folder(f, base, out);
    else out.set(path.relative(base, f).split(path.sep).join('/'), fs.readFileSync(f));
  }
  return out;
}

(async () => {
  const dir = path.resolve(process.argv[2] || path.join(__dirname, 'extension'));
  if (!fs.existsSync(path.join(dir, 'manifest.json'))) throw new Error(`No extension in ${dir}`);
  console.log('Downloading FOMO Alerts from the Chrome Web Store (Google\'s servers)...');
  const res = await fetch(CRX_URL, { redirect: 'follow' });
  if (!res.ok) throw new Error(`Download failed: HTTP ${res.status}`);
  const crx = Buffer.from(await res.arrayBuffer());
  const store = unzip(zipOf(crx));
  const mine = folder(dir);

  // The store adds its own signature files (_metadata/), and may add "update_url" or "key" to the manifest
  for (const name of [...store.keys()]) if (name.startsWith('_metadata/')) store.delete(name);
  const storeManifest = JSON.parse(store.get('manifest.json'));
  const added = ['update_url', 'key'].filter((k) => k in storeManifest);
  for (const k of added) delete storeManifest[k];
  const myManifest = JSON.parse(mine.get('manifest.json'));
  console.log(`\nChrome Web Store:  version ${storeManifest.version}, ${store.size} files (${crx.length} bytes, sha256 ${sha(crx).slice(0, 16)}…)`);
  console.log(`This folder:       version ${myManifest.version}, ${mine.size} files (${dir})\n`);

  const problems = [];
  for (const [name, data] of store) {
    if (!mine.has(name)) problems.push(`only in the store: ${name}`);
    else if (name === 'manifest.json') {
      if (JSON.stringify(storeManifest) !== JSON.stringify(myManifest)) problems.push('manifest.json is different');
    } else if (sha(data) !== sha(mine.get(name))) problems.push(`different: ${name}`);
  }
  for (const name of mine.keys()) if (!store.has(name)) problems.push(`only in this folder: ${name}`);

  if (!problems.length) {
    console.log(`✓ Every file is exactly the same: the Chrome Web Store version is this code.`);
    if (added.length) console.log(`  (The store adds only its own signatures and "${added.join('", "')}" in the manifest.)`);
    return;
  }
  for (const p of problems) console.log('✗ ' + p);
  if (storeManifest.version !== myManifest.version) {
    console.log(`\nThe store has version ${storeManifest.version}. Compare it with that version's code: git checkout v${storeManifest.version}`);
    console.log('(A new version can take a few days to appear in the store after Google reviews it.)');
  }
  process.exitCode = 1;
})().catch((e) => {
  console.error('Could not check: ' + e.message);
  process.exitCode = 2;
});
