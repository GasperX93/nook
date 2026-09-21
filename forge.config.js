const path = require('path')
const fs = require('fs')

// Taken over from https://github.com/electron/fiddle/blob/main/forge.config.js

if (process.env['WINDOWS_CODESIGN_FILE']) {
  const certPath = path.join(__dirname, 'win-certificate.pfx')
  const certExists = fs.existsSync(certPath)

  if (certExists) {
    process.env['WINDOWS_CODESIGN_FILE'] = certPath
  }
}

const iconPath = path.resolve(__dirname, 'assets', 'icon')

const config = {
  packagerConfig: {
    icon: iconPath,
    executableName: 'nook',
    name: 'Nook',
    // Inherited from the swarm-desktop fork but MUST NOT change: it is the
    // installed app's macOS identity — changing it breaks auto-update pairing
    // and Gatekeeper/notarization continuity for existing installs (#76).
    appBundleId: 'si.nook.app',
    protocols: [
      {
        name: 'Nook Contact',
        schemes: ['nook'],
      },
    ],
    // UI assets are unpacked (real files next to app.asar) so the dashboard
    // keeps serving even if Electron's in-process asar cache is poisoned by a
    // transient fs error mid-run (see #80). Electron resolves reads through
    // the app.asar path transparently either way. NOTE: verify on next
    // `npm run make` that /dashboard serves from the packaged app.
    asar: { unpack: '**/dist/ui/**' },
    ignore: [
      // Build output / release artifacts — must never be packaged into the app.
      // forge does NOT read .gitignore, so these need listing here even though
      // they're git-ignored. Without this, DMG/ZIP artifacts staged in build/
      // (or a stale out/) get swallowed into app.asar and 3x the artifact size.
      /^\/build/,
      /^\/out/,
      // Frontend build tools — never needed at runtime (saves ~180 MB)
      /^\/ui\/node_modules/,
      /^\/ui\/src/,
      /^\/ui\/tsconfig/,
      /^\/ui\/vite\.config/,
      /^\/ui\/postcss\.config/,
      /^\/ui\/tailwind\.config/,
      /^\/ui\/index\.html/,
      /^\/ui\/public/,
      // TypeScript source files
      /^\/src/,
      // Dev / CI / editor config
      /^\/\.github/,
      /^\/\.claude/,
      /^\/\.eslintrc/,
      /^\/\.eslintignore/,
      /^\/\.prettierrc/,
      /^\/\.huskyrc/,
      /^\/\.editorconfig/,
      /^\/\.depcheckrc/,
      /^\/\.gitignore/,
      /^\/\.gitattributes/,
      /^\/\.release-please/,
      /^\/commitlint/,
      /^\/jest\.config/,
      /^\/tsconfig/,
      /^\/devkit\.mjs/,
      /^\/CLAUDE\.md/,
      /^\/CHANGELOG\.md/,
      /^\/CODE_OF_CONDUCT\.md/,
      /^\/CODEOWNERS/,
      /^\/nook-vs-swarm-desktop\.md/,
      /^\/installer-size-analysis\.md/,
      // TypeScript definitions (not needed at runtime)
      /^\/node_modules\/@types/,
      // Dev tools — build, test, lint, format (saves ~367 MB)
      /^\/node_modules\/@babel/,
      /^\/node_modules\/@bcoe/,
      /^\/node_modules\/@cspotcode/,
      /^\/node_modules\/@electron\//,
      /^\/node_modules\/@electron-forge/,
      /^\/node_modules\/@eslint/,
      /^\/node_modules\/@eslint-community/,
      /^\/node_modules\/@gar/,
      /^\/node_modules\/@humanwhocodes/,
      /^\/node_modules\/@inquirer/,
      /^\/node_modules\/@istanbuljs/,
      /^\/node_modules\/@jest/,
      /^\/node_modules\/@jridgewell/,
      /^\/node_modules\/@kayahr/,
      /^\/node_modules\/@listr2/,
      /^\/node_modules\/@malept/,
      /^\/node_modules\/@nodelib/,
      /^\/node_modules\/@npmcli/,
      /^\/node_modules\/@octokit/,
      /^\/node_modules\/@sinclair/,
      /^\/node_modules\/@sindresorhus/,
      /^\/node_modules\/@sinonjs/,
      /^\/node_modules\/@tootallnate/,
      /^\/node_modules\/@tsconfig/,
      /^\/node_modules\/@ungap/,
      /^\/node_modules\/@vscode/,
      /^\/node_modules\/@vue/,
      /^\/node_modules\/@webassemblyjs/,
      /^\/node_modules\/@xmldom/,
      /^\/node_modules\/@xtuc/,
      /^\/node_modules\/concurrently/,
      /^\/node_modules\/cross-env/,
      /^\/node_modules\/cpy/,
      /^\/node_modules\/depcheck/,
      /^\/node_modules\/eslint/,
      /^\/node_modules\/jest/,
      /^\/node_modules\/prettier/,
      /^\/node_modules\/rimraf/,
      /^\/node_modules\/ts-node/,
      /^\/node_modules\/typescript/,
      /^\/node_modules\/undici-types/,
    ],
  },
  electronInstallerDebian: {
    bin: 'Nook',
  },
  makers: [
    {
      name: '@electron-forge/maker-squirrel',
      config: {
        name: 'nook',
        iconUrl: iconPath + '.ico',
        setupIcon: iconPath + '.ico',
        loadingGif: path.resolve(__dirname, 'assets', 'windows-install.gif'),
        certificateFile: process.env['WINDOWS_CODESIGN_FILE'],
        certificatePassword: process.env['WINDOWS_CODESIGN_PASSWORD'],
      },
    },
    {
      name: '@electron-forge/maker-dmg',
      config: {
        icon: `${iconPath}.icns`,
        format: 'ULFO',
      },
    },
    {
      name: '@electron-forge/maker-deb',
      config: {
        options: {
          icon: `${iconPath}.png`,
          mimeType: ['x-scheme-handler/nook'],
        },
      },
    },
    {
      name: '@electron-forge/maker-rpm',
      config: {
        options: {
          icon: `${iconPath}.png`,
          mimeType: ['x-scheme-handler/nook'],
        },
      },
    },
    {
      name: '@electron-forge/maker-zip',
      platforms: ['darwin', 'win32'],
      config: {},
    },
  ],
  publishers: [
    {
      name: '@electron-forge/publisher-github',
      config: {
        repository: {
          owner: 'GasperX93',
          name: 'nook',
        },
        prerelease: true,
        draft: false,
      },
    },
  ],
}

// macOS signing + notarization (issue #9). Both are gated on the Developer ID
// certificate being present in the keychain, so dev builds on machines
// without it stay unsigned and fast. Notarization additionally needs the
// one-time `xcrun notarytool store-credentials nook-notary …` setup; skip it
// for a quick signed-only build with NOOK_SKIP_NOTARIZE=1.
const SIGNING_IDENTITY = 'Developer ID Application: Gasper Zupan (6BYBR6VWCP)'

function signAndNotarizeMaybe() {
  if (process.platform !== 'darwin') {
    return
  }

  let hasCert = false
  try {
    const out = require('child_process').execSync('security find-identity -v -p codesigning', { encoding: 'utf-8' })
    hasCert = out.includes(SIGNING_IDENTITY)
  } catch {
    // security not available — treat as no cert
  }

  if (!hasCert) {
    console.log('No Developer ID certificate in keychain — building unsigned')
    return
  }

  config.packagerConfig.osxSign = {
    identity: SIGNING_IDENTITY,
    optionsForFile: () => ({
      hardenedRuntime: true,
      entitlements: 'assets/entitlements.plist',
    }),
  }

  if (process.env.NOOK_SKIP_NOTARIZE) {
    console.log('NOOK_SKIP_NOTARIZE set — signing only')
    return
  }

  config.packagerConfig.osxNotarize = {
    tool: 'notarytool',
    keychainProfile: 'nook-notary',
  }
}

signAndNotarizeMaybe()

module.exports = config
