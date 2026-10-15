/**
 * Deploy gate for the staged Fuigo engine (scripts/deploy-webui.sh step 5).
 *
 *   node scripts/fuigo/verify-staged.cjs <staged dir> <runtime> [authority.json]
 *
 * The staged binary must hash to the receipt in bundle.json (the server refuses
 * to spawn it otherwise) AND, independently of the receipt, to the pin's
 * binarySha256 for <runtime>; the receipt must name the pinned version and the
 * expected runtime; and `fuigo --version` must report the pinned version. Any
 * mismatch exits non-zero. Only unsigned (non-darwin) runtimes are accepted:
 * darwin staging re-signs the binary, so its staged hash differs from the pin.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

function verifyStagedFuigo(dir, runtime, authority) {
  if (runtime.startsWith('darwin-'))
    throw new Error('darwin staged binaries are re-signed; this check is linux/win only');
  const pin = authority.platforms?.[runtime];
  if (!pin) throw new Error(`no pin for runtime ${runtime}`);
  const receipt = JSON.parse(fs.readFileSync(path.join(dir, 'bundle.json'), 'utf8'));
  if (receipt.runtime !== runtime) throw new Error(`bundle.json runtime ${receipt.runtime} != ${runtime}`);
  if (typeof receipt.binary !== 'string' || path.basename(receipt.binary) !== receipt.binary)
    throw new Error('bundle.json binary must be a bare file name');
  const file = path.join(dir, receipt.binary);
  if (fs.lstatSync(file).isSymbolicLink()) throw new Error('staged Fuigo binary is a symlink; the server refuses it');
  const sha = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  if (sha !== receipt.stagedSha256) throw new Error(`staged sha256 ${sha} != bundle.json ${receipt.stagedSha256}`);
  if (sha !== pin.binarySha256)
    throw new Error(`staged sha256 ${sha} != pin ${runtime} binarySha256 ${pin.binarySha256}`);
  if (receipt.version !== authority.version || receipt.binarySha256 !== pin.binarySha256)
    throw new Error(`bundle.json ${receipt.version} does not match the pin ${authority.version}`);
  const res = spawnSync(file, ['--version'], { encoding: 'utf8', timeout: 30_000 });
  if (res.error) throw new Error(`fuigo --version failed: ${res.error.message}`);
  if (res.status !== 0) throw new Error(`fuigo --version exited ${res.status}`);
  const reported = /^fuigo\s+v?(\S+)/m.exec(res.stdout.trim())?.[1];
  if (reported !== authority.version)
    throw new Error(`fuigo --version reports ${JSON.stringify(res.stdout.trim())}, pin is ${authority.version}`);
  return { version: reported, runtime, sha256: sha };
}

module.exports = { verifyStagedFuigo };

if (require.main === module) {
  try {
    const [dir, runtime, authorityPath = path.join(__dirname, 'authority.json')] = process.argv.slice(2);
    if (!dir || !runtime) throw new Error('usage: verify-staged.cjs <staged dir> <runtime> [authority.json]');
    const authority = JSON.parse(fs.readFileSync(authorityPath, 'utf8'));
    const ok = verifyStagedFuigo(dir, runtime, authority);
    console.log(`fuigo ${ok.version} ${ok.runtime} sha256 ${ok.sha256} OK (pin + receipt + --version)`);
  } catch (error) {
    console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
