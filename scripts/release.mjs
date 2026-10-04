// 发布新版本到 GitHub Releases；已安装的客户端会自动检测并按块差量更新
// 用法：npm run release -- [patch|minor|major|<版本号>|current]（默认 patch；current 表示不改版本号）
// 发布说明取 docs/releases/v<版本>.md；需要 gh 已登录（gh auth login）
import { execSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'

const bump = process.argv[2] ?? 'patch'
const run = (cmd, env) => execSync(cmd, { stdio: 'inherit', env: { ...process.env, ...env } })

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
for (const f of files) if (!existsSync(f)) throw new Error(`缺少 ${f}`)
const notes = existsSync(`docs/releases/v${version}.md`) ? `--notes-file docs/releases/v${version}.md` : `--notes "${build.productName} ${version}"`
run(`gh release create v${version} ${files.map((f) => `"${f}"`).join(' ')} --repo ${owner}/${repo} --title "${build.productName} ${version}" ${notes}`)
console.log(`已发布 https://github.com/${owner}/${repo}/releases/tag/v${version}`)
