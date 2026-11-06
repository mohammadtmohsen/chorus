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
const engineRoot = join(root, 'apps', 'engine')
const outputRoot = join(extensionRoot, 'dist')
const nativePackages = ['better-sqlite3', 'node-pty']
const buildOnlyDependencies = new Set(['nan', 'node-addon-api', 'prebuild-install'])
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

function copyLegalFiles(sourceRoot, destinationRoot) {
  function visit(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory() && !excludedDirectories.has(entry.name)) visit(path)
      else if (entry.isFile() && legalFilename.test(entry.name)) {
        copyPayload(path, join(destinationRoot, relative(sourceRoot, path)), sourceRoot)
      }
    }
  }
  visit(sourceRoot)
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

function copyRuntimeDependencies(source, destination, ancestors) {
  const manifest = readJson(join(source, 'package.json'))
  const dependencies = {}
  for (const name of Object.keys(manifest.dependencies ?? {}).sort()) {
    if (buildOnlyDependencies.has(name)) continue
    if (name === 'electron' || name.startsWith('@chorus/')) {
      throw new Error(`Unbundled workspace or Electron dependency: ${name}`)
    }
    const dependencyRoot = packageRoot(name, source)
    dependencies[name] = readJson(join(dependencyRoot, 'package.json')).version
    if (ancestors.has(dependencyRoot)) continue
    const target = join(destination, 'node_modules', name)
    copyPayload(dependencyRoot, target, dependencyRoot, runtimeFile)
    copyRuntimeDependencies(dependencyRoot, target, new Set([...ancestors, dependencyRoot]))
  }
  const packagedManifest = { ...manifest, dependencies }
  for (const key of ['scripts', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
    Reflect.deleteProperty(packagedManifest, key)
  }
  writeFileSync(join(destination, 'package.json'), `${JSON.stringify(packagedManifest, null, 2)}\n`)
}

function copyNativePackage(name, staging, platform) {
  const source = packageRoot(name, engineRoot)
  const target = join(staging, 'node_modules', name)
  for (const entry of ['package.json', 'lib']) {
    copyPayload(join(source, entry), join(target, entry), source, runtimeFile)
  }
  copyLegalFiles(source, target)
  if (name === 'better-sqlite3') {
    const binding = `${platform.sqlite}.node`
    copyPayload(join(source, 'prebuilds', binding), join(target, 'prebuilds', binding), source)
  } else {
    const prebuilt = join('prebuilds', platform.native)
    const prebuild = existsSync(join(source, prebuilt)) ? prebuilt : join('build', 'Release')
    copyPayload(join(source, prebuild), join(target, prebuild), source, runtimeFile)
    if (process.platform !== 'win32') {
      const helper = join(target, prebuild, 'spawn-helper')
      if (existsSync(helper)) chmodSync(helper, statSync(helper).mode | 0o111)
    } else {
      const conpty = join(source, 'third_party', 'conpty')
      if (existsSync(conpty)) {
        for (const version of readdirSync(conpty).sort()) {
          const path = join('third_party', 'conpty', version, `win10-${process.arch}`)
          if (existsSync(join(source, path))) {
            copyPayload(join(source, path), join(target, path), source, runtimeFile)
          }
        }
      }
    }
  }
  copyRuntimeDependencies(source, target, new Set([source]))
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
    native: `${process.platform}-${process.arch}`,
    sqlite: `${musl ? 'linuxmusl' : process.platform}-${process.arch}`,
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
    'devDependencies',
    'optionalDependencies',
    'peerDependencies',
    'packageManager',
    'files',
    'pnpm',
  ]) {
    Reflect.deleteProperty(packagedManifest, key)
  }
  packagedManifest.dependencies = Object.fromEntries(
    nativePackages.map((name) => [
      name,
      readJson(join(packageRoot(name, engineRoot), 'package.json')).version,
    ])
  )
  writeFileSync(join(staging, 'package.json'), `${JSON.stringify(packagedManifest, null, 2)}\n`)
}

function build() {
  const args = ['--filter', '@chorus/engine...', '--filter', '@chorus/extension...', 'run', 'build']
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
      '--dependencies',
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
  copyBundle(engineRoot, 'engine.cjs', staging)
  copyPayload(
    join(outputRoot, 'webview'),
    join(staging, 'dist', 'webview'),
    extensionRoot,
    runtimeFile
  )
  copyMetadata(manifest, staging)
  for (const name of nativePackages) copyNativePackage(name, staging, platform)
  packageVsix(staging, platform, output)
  process.stdout.write(`${output}\n`)
} finally {
  rmSync(staging, { recursive: true, force: true })
}
