import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const extensionRoot = dirname(fileURLToPath(import.meta.url))
const root = resolve(extensionRoot, '../..')
const outputRoot = join(extensionRoot, 'dist')
const legalFilename = /^(?:licen[cs]e|copying|notice)(?:[._-]|$)|third[._-]?party.*notices?/i
const metadataFilename = /^(?:readme|changelog)(?:\.|$)|^package\.nls(?:\.[^.]+)*\.json$/i
const excludedDirectories = new Set(['node_modules', '.git', '.github', 'test', 'tests'])

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function within(directory, path) {
  const difference = relative(directory, path)
  return !isAbsolute(difference) && difference !== '..' && !difference.startsWith(`..${sep}`)
}

function resolveWithin(directory, path) {
  const result = resolve(directory, path)
  if (!within(directory, result)) throw new Error(`Package path escapes its root: ${path}`)
  return result
}

function copyPayload(source, destination, sourceRoot, include = () => true) {
  const boundary = realpathSync(sourceRoot)
  function copy(path, target) {
    const resolved = realpathSync(path)
    const details = statSync(resolved)
    if (!include(relative(sourceRoot, path), details.isDirectory())) return
    if (!within(boundary, resolved)) throw new Error(`Package symlink escapes its root: ${path}`)
    if (details.isDirectory()) {
      mkdirSync(target, { recursive: true })
      for (const name of readdirSync(resolved).sort()) copy(join(path, name), join(target, name))
    } else if (details.isFile()) {
      mkdirSync(dirname(target), { recursive: true })
      copyFileSync(resolved, target)
      chmodSync(target, details.mode & 0o777)
    } else {
      throw new Error(`Unsupported package entry: ${path}`)
    }
  }
  copy(source, destination)
}

function runtimeFile(path, directory) {
  const segments = path.split(sep)
  if (segments.some((segment) => excludedDirectories.has(segment))) return false
  if (directory) return true
  return !/\.(?:map|pdb|ts|tsx)$|\.(?:test|spec)\.[cm]?js$|^testUtils\./i.test(basename(path))
}

function packageRoot(name, from) {
  const require = createRequire(join(from, 'package.json'))
  let directory = dirname(require.resolve(name))
  for (;;) {
    const manifestPath = join(directory, 'package.json')
    if (existsSync(manifestPath) && readJson(manifestPath).name === name) {
      return realpathSync(directory)
    }
    const parent = dirname(directory)
    if (parent === directory) throw new Error(`Cannot locate the installed package: ${name}`)
    directory = parent
  }
}

function currentPlatform() {
  if (!['darwin', 'linux', 'win32'].includes(process.platform)) {
    throw new Error(`Unsupported package platform: ${process.platform}`)
  }
  if (!['x64', 'arm64'].includes(process.arch)) {
    throw new Error(`Unsupported package architecture: ${process.arch}`)
  }
  const musl =
    process.platform === 'linux' && !process.report.getReport().header.glibcVersionRuntime
  return {
    vsix: `${musl ? 'alpine' : process.platform}-${process.arch}`,
  }
}

function copyBundle(sourceRoot, name, staging) {
  copyPayload(join(sourceRoot, 'dist', name), join(staging, 'dist', name), sourceRoot)
  for (const entry of readdirSync(join(sourceRoot, 'dist')).sort()) {
    if (entry.startsWith(name) && /\.(?:LEGAL|LICENSE)\.txt$/i.test(entry)) {
      copyPayload(join(sourceRoot, 'dist', entry), join(staging, 'dist', entry), sourceRoot)
    }
  }
}

function copyManifestAssets(manifest, staging) {
  function copyAsset(path) {
    if (typeof path !== 'string' || path.startsWith('$(') || /^[a-z]+:\/\//i.test(path)) return
    const source = resolveWithin(extensionRoot, path)
    copyPayload(source, join(staging, relative(extensionRoot, source)), extensionRoot)
  }
  function icons(value) {
    if (typeof value === 'string') copyAsset(value)
    else if (value && typeof value === 'object') {
      for (const path of Object.values(value)) copyAsset(path)
    }
  }
  function visit(value) {
    if (Array.isArray(value)) {
      for (const entry of value) visit(entry)
    } else if (value && typeof value === 'object') {
      for (const [key, entry] of Object.entries(value)) {
        if (key === 'icon') icons(entry)
        else if (key === 'path' && typeof entry === 'string') copyAsset(entry)
        else visit(entry)
      }
    }
  }
  icons(manifest.icon)
  visit(manifest.contributes)
}

function copyMetadata(manifest, staging) {
  for (const entry of readdirSync(extensionRoot, { withFileTypes: true })) {
    if (entry.isFile() && (metadataFilename.test(entry.name) || legalFilename.test(entry.name))) {
      copyPayload(join(extensionRoot, entry.name), join(staging, entry.name), extensionRoot)
    }
  }
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (
      entry.isFile() &&
      legalFilename.test(entry.name) &&
      !existsSync(join(staging, entry.name))
    ) {
      copyPayload(join(root, entry.name), join(staging, entry.name), root)
    }
  }
  for (const directory of [
    'media',
    'resources',
    'icons',
    'l10n',
    'syntaxes',
    'themes',
    'snippets',
  ]) {
    if (existsSync(join(extensionRoot, directory))) {
      copyPayload(
        join(extensionRoot, directory),
        join(staging, directory),
        extensionRoot,
        runtimeFile
      )
    }
  }
  if (existsSync(join(extensionRoot, '.vscodeignore'))) {
    copyPayload(join(extensionRoot, '.vscodeignore'), join(staging, '.vscodeignore'), extensionRoot)
  }
  copyManifestAssets(manifest, staging)
  const packagedManifest = {
    ...manifest,
    name: manifest.name === '@chorus/extension' ? 'chorus' : manifest.name,
  }
  for (const key of [
    'scripts',
    'dependencies',
    'devDependencies',
    'optionalDependencies',
    'peerDependencies',
    'packageManager',
    'files',
    'pnpm',
  ]) {
    Reflect.deleteProperty(packagedManifest, key)
  }
  packagedManifest.scripts = { 'vscode:uninstall': manifest.scripts['vscode:uninstall'] }
  writeFileSync(join(staging, 'package.json'), `${JSON.stringify(packagedManifest, null, 2)}\n`)
}

function build() {
  const args = ['--filter', '@chorus/extension...', '--filter', '!@chorus/engine', 'run', 'build']
  const pnpmScript = process.env.npm_execpath
  if (pnpmScript) {
    execFileSync(process.execPath, [pnpmScript, ...args], { cwd: root, stdio: 'inherit' })
  } else {
    execFileSync('pnpm', args, { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' })
  }
}

function packageVsix(staging, platform, output) {
  const source = packageRoot('@vscode/vsce', extensionRoot)
  const manifest = readJson(join(source, 'package.json'))
  const bin = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.vsce
  if (typeof bin !== 'string') throw new Error('@vscode/vsce does not declare a vsce executable')
  execFileSync(
    process.execPath,
    [
      resolveWithin(source, bin),
      'package',
      '--no-yarn',
      '--no-dependencies',
      '--allow-missing-repository',
      '--target',
      platform.vsix,
      '--out',
      output,
    ],
    { cwd: staging, stdio: 'inherit' }
  )
}

const args = process.argv.slice(2).filter((argument) => argument !== '--')
if (args.some((argument) => argument !== '--skip-build')) {
  throw new Error('Usage: node apps/extension/package.mjs [--skip-build]')
}
const manifest = readJson(join(extensionRoot, 'package.json'))
if (manifest.main !== './dist/extension.cjs') {
  throw new Error('Extension main must be ./dist/extension.cjs')
}
const platform = currentPlatform()
if (!args.includes('--skip-build')) build()
mkdirSync(outputRoot, { recursive: true })
const staging = mkdtempSync(join(outputRoot, `.vsix-${platform.vsix}-`))
const name = manifest.name === '@chorus/extension' ? 'chorus' : manifest.name
const output = join(outputRoot, `${name}-${manifest.version}-${platform.vsix}.vsix`)
try {
  copyBundle(extensionRoot, 'extension.cjs', staging)
  copyBundle(extensionRoot, 'continuous-row.js', staging)
  copyBundle(extensionRoot, 'uninstall.cjs', staging)
  copyPayload(
    join(outputRoot, 'webview'),
    join(staging, 'dist', 'webview'),
    extensionRoot,
    runtimeFile
  )
  copyMetadata(manifest, staging)
  packageVsix(staging, platform, output)
  process.stdout.write(`${output}\n`)
} finally {
  rmSync(staging, { recursive: true, force: true })
}
