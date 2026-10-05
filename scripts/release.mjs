// 发布新版本到 GitHub Releases；已安装的客户端会自动检测更新（桌面按块差量下载，安卓在应用内下载安装）
// 用法：npm run release -- [patch|minor|major|<版本号>|current]（默认 patch；current 表示不改版本号）
// 发布说明取 docs/releases/v<版本>.md；需要 gh 已登录（gh auth login）
// 安卓版需要 JDK + Android SDK（JAVA_HOME、android/local.properties）和正式签名（android/keystore.properties）；
// 设 LAVA_SKIP_ANDROID=1 只发布桌面版
import { execSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename } from 'node:path'

const bump = process.argv[2] ?? 'patch'
const run = (cmd, env, cwd) => execSync(cmd, { stdio: 'inherit', env: { ...process.env, ...env }, cwd })
const android = process.env.LAVA_SKIP_ANDROID !== '1'

if (android && !existsSync('android/keystore.properties')) throw new Error('缺少 android/keystore.properties（安卓正式签名）；只发桌面版请设 LAVA_SKIP_ANDROID=1')
if (bump !== 'current') run(`npm version ${bump} --no-git-tag-version`)
const { version, build } = JSON.parse(readFileSync('package.json', 'utf8'))
const { owner, repo } = build.publish[0]

run('npm run models')
run('npx electron-vite build')
run('npx electron-builder --win --x64 --publish never', {
  ELECTRON_MIRROR: process.env.ELECTRON_MIRROR ?? 'https://npmmirror.com/mirrors/electron/',
  ELECTRON_BUILDER_BINARIES_MIRROR: process.env.ELECTRON_BUILDER_BINARIES_MIRROR ?? 'https://npmmirror.com/mirrors/electron-builder-binaries/'
})

// 安装包、差量更新用的 blockmap、以及 electron-updater 读取的 latest.yml
const exe = `dist/${build.productName}-Setup-${version}.exe`
const files = [exe, `${exe}.blockmap`, 'dist/latest.yml']

// 安卓：签名的 arm64 安装包 + 应用内更新读取的 latest-android.json（版本号、下载地址、大小、SHA-256、更新说明）
if (android) {
  run(process.platform === 'win32' ? '.\\gradlew.bat assembleRelease' : './gradlew assembleRelease', {}, 'android')
  const apk = `dist/${build.productName}-Android-${version}.apk`
  copyFileSync('android/app/build/outputs/apk/release/app-arm64-v8a-release.apk', apk)
  const [major, minor, patch] = version.split('.').map((v) => parseInt(v, 10))
  const notesFile = `docs/releases/v${version}.md`
  writeFileSync(
    'dist/latest-android.json',
    JSON.stringify(
      {
        version,
        versionCode: major * 10000 + minor * 100 + patch,
        url: `https://github.com/${owner}/${repo}/releases/download/v${version}/${basename(apk)}`,
        size: statSync(apk).size,
        sha256: createHash('sha256').update(readFileSync(apk)).digest('hex'),
        notes: existsSync(notesFile) ? readFileSync(notesFile, 'utf8').slice(0, 3000) : '',
        date: new Date().toISOString()
      },
      null,
      2
    )
  )
  files.push(apk, 'dist/latest-android.json')
}

for (const f of files) if (!existsSync(f)) throw new Error(`缺少 ${f}`)
const notes = existsSync(`docs/releases/v${version}.md`) ? `--notes-file docs/releases/v${version}.md` : `--notes "${build.productName} ${version}"`
run(`gh release create v${version} ${files.map((f) => `"${f}"`).join(' ')} --repo ${owner}/${repo} --title "${build.productName} ${version}" ${notes}`)
console.log(`已发布 https://github.com/${owner}/${repo}/releases/tag/v${version}`)
