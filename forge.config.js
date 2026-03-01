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
    appBundleId: 'org.ethswarm.nook',
    asar: true,
    ignore: [
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
    ],
    osxSign: {
      identity: 'Developer ID Application: Swarm Association (9J9SPHU9RP)',
      hardenedRuntime: true,
      'gatekeeper-assess': false,
      entitlements: 'assets/entitlements.plist',
      'entitlements-inherit': 'assets/entitlements.plist',
    },
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
        },
      },
    },
    {
      name: '@electron-forge/maker-rpm',
      config: {
        options: {
          icon: `${iconPath}.png`,
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

function notarizeMaybe() {
  if (process.platform !== 'darwin') {
    return
  }

  if (!process.env.CI) {
    console.log(`Not in CI, skipping notarization`)
    return
  }

  if (!process.env.APPLE_ID || !process.env.APPLE_ID_PASSWORD) {
    console.warn('Should be notarizing, but environment variables APPLE_ID or APPLE_ID_PASSWORD are missing!')
    return
  }

  config.packagerConfig.osxNotarize = {
    tool: 'notarytool',
    appBundleId: 'org.ethswarm.nook',
    appleId: process.env.APPLE_ID,
    appleIdPassword: process.env.APPLE_ID_PASSWORD,
    ascProvider: '9J9SPHU9RP',
    teamId: '9J9SPHU9RP',
  }
}

notarizeMaybe()

module.exports = config
