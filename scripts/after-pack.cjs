/**
 * electron-builder afterPack hook: strips extended attributes from the assembled app before it
 * is signed.
 *
 * Files copied out of the repository (which lives in iCloud Drive) can carry iCloud's
 * com.apple.fileprovider… and FinderInfo attributes into the bundle, and codesign refuses to sign
 * anything that has them. The bundle itself is built outside iCloud (see directories.output), so
 * once cleared they stay cleared.
 */
const { execFileSync } = require('node:child_process');
const { join } = require('node:path');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const app = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  execFileSync('/usr/bin/xattr', ['-cr', app]);
};
