import { createHash } from 'node:crypto'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const engineRoot = dirname(fileURLToPath(import.meta.url))
const root = resolve(engineRoot, '../..')
const outputRoot = join(engineRoot, 'dist')
const runtimeRoot = join(outputRoot, 'runtime')
const nativePackages = ['better-sqlite3', 'node-pty']
const buildOnlyDependencies = new Set(['nan', 'node-addon-api', 'prebuild-install'])
const legalFilename = /^(?:licen[cs]e|copying|notice)(?:[._-]|$)|third[._-]?party.*notices?/i
const excludedDirectories = new Set(['node_modules', '.git', '.github', 'test', 'tests'])

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function within(directory, path) {
  const difference = relative(directory, path)
  return !isAbsolute(difference) && difference !== '..' && !difference.startsWith(`..${sep}`)
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
  const nativeName = process.platform === 'win32' ? 'conpty.node' : 'pty.node'
  const candidates =
    name === 'better-sqlite3'
      ? [
          join('prebuilds', `${platform.sqlite}.node`),
          join('build', 'Debug', 'better_sqlite3.node'),
          join('build', 'Release', 'better_sqlite3.node'),
        ]
      : [
          join('prebuilds', platform.native, nativeName),
          join('build', 'Release', nativeName),
          join('build', 'Debug', nativeName),
        ]
  const binding = candidates.find((path) => existsSync(join(source, path)))
  if (binding === undefined) throw new Error(`Native binding missing from ${name}: ${candidates}`)
  if (name === 'better-sqlite3') {
    copyPayload(join(source, binding), join(target, binding), source)
  } else {
    const payload = dirname(binding)
    copyPayload(join(source, payload), join(target, payload), source, runtimeFile)
    if (process.platform !== 'win32') {
      const helper = join(target, payload, 'spawn-helper')
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
  return {
    version: readJson(join(target, 'package.json')).version,
    sha256: sha256(join(target, binding)),
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
    native: `${process.platform}-${process.arch}`,
    sqlite: `${musl ? 'linuxmusl' : process.platform}-${process.arch}`,
  }
}

const platform = currentPlatform()
const manifest = readJson(join(root, 'package.json'))
const electron = readJson(
  join(packageRoot('electron', join(root, 'apps', 'desktop')), 'package.json')
).version
mkdirSync(outputRoot, { recursive: true })
const staging = mkdtempSync(join(outputRoot, '.runtime-'))
try {
  copyPayload(join(outputRoot, 'engine.cjs'), join(staging, 'engine.cjs'), engineRoot)
  for (const entry of readdirSync(outputRoot).sort()) {
    if (entry.startsWith('engine.cjs') && /\.(?:LEGAL|LICENSE)\.txt$/i.test(entry)) {
      copyPayload(join(outputRoot, entry), join(staging, entry), engineRoot)
    }
  }
  const natives = Object.fromEntries(
    nativePackages.map((name) => [name, copyNativePackage(name, staging, platform)])
  )
  const runtimeManifest = {
    version: manifest.version,
    platform: process.platform,
    arch: process.arch,
    engine: sha256(join(staging, 'engine.cjs')),
    electron,
    natives,
  }
  writeFileSync(join(staging, 'runtime.json'), `${JSON.stringify(runtimeManifest, null, 2)}\n`)
  rmSync(runtimeRoot, { recursive: true, force: true })
  renameSync(staging, runtimeRoot)
  process.stdout.write(`${runtimeRoot}\n`)
} finally {
  rmSync(staging, { recursive: true, force: true })
}
