// Squirrel.Mac installs an update only if the new app satisfies the running app's designated requirement. An ad-hoc
// signature defaults to `cdhash H"..."`, which differs every build, so no update could ever pass.
const { execFileSync } = require('node:child_process');
const { join } = require('node:path');

exports.default = async function afterSign({ electronPlatformName, appOutDir, packager }) {
  if (electronPlatformName !== 'darwin') return;
  const app = join(appOutDir, `${packager.appInfo.productFilename}.app`);
  execFileSync(
    'codesign',
    ['--force', '--sign', '-', '--preserve-metadata=entitlements,flags', '--requirements', `=designated => identifier "${packager.appInfo.id}"`, app],
    { stdio: 'inherit' },
  );
};
