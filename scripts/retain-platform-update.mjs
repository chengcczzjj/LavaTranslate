// A Windows-only release must preserve the latest available Mac/Android feeds.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { load, dump } from 'js-yaml'

export function pinMacManifest(source, repository, tag) {
  const manifest = load(source)
  if (!manifest || typeof manifest.version !== 'string' || !Array.isArray(manifest.files) || !manifest.files.length) throw Error('Invalid retained Mac update manifest')
  const prefix = `https://github.com/${repository}/releases/download/`
  const absolute = (value) => {
    if (typeof value !== 'string') throw Error('Invalid Mac update asset URL')
    if (value.startsWith(prefix)) return value
    if (!value || /[/\\?#:]/.test(value)) throw Error('Unexpected Mac update asset path')
    return `${prefix}${encodeURIComponent(tag)}/${encodeURIComponent(value)}`
  }
  for (const file of manifest.files) file.url = absolute(file.url)
  if (manifest.path) manifest.path = absolute(manifest.path)
  return dump(manifest)
}

export function retainPlatformUpdate(repository, name) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository) || !['latest-mac.yml', 'latest-android.json'].includes(name)) throw Error('Invalid update feed request')
  const release = JSON.parse(execFileSync('gh', ['api', `repos/${repository}/releases/latest`], { encoding: 'utf8' }))
  if (!release.assets.some(asset => asset.name === name)) return null
  const directory = mkdtempSync(join(tmpdir(), 'lava-retained-update-'))
  try {
    execFileSync('gh', ['release', 'download', release.tag_name, '--repo', repository, '--pattern', name, '--dir', directory], { stdio: 'inherit' })
    const source = readFileSync(join(directory, name), 'utf8')
    const output = resolve('dist', name)
    writeFileSync(output, name === 'latest-mac.yml' ? pinMacManifest(source, repository, release.tag_name) : source)
    return output
  } finally {
    // This exact temporary directory was created above solely for this operation.
    if (resolve(directory).startsWith(resolve(tmpdir()) + '\\') || resolve(directory).startsWith(resolve(tmpdir()) + '/')) rmSync(directory, { recursive: true, force: true })
  }
}
