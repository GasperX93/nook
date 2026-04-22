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
    protocols: [
      {
        name: 'Nook Contact',
        schemes: ['nook'],
      },
    ],
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
    // TODO: Re-enable when Apple Developer certificate is available
    // osxSign: {
    //   identity: 'Developer ID Application: Swarm Association (9J9SPHU9RP)',
    //   hardenedRuntime: true,
    //   'gatekeeper-assess': false,
    //   entitlements: 'assets/entitlements.plist',
    //   'entitlements-inherit': 'assets/entitlements.plist',
    // },
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
