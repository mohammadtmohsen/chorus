import {
  readFileSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { zip } from './zip.mjs'

/**
 * Build the VSIX, without `@vscode/vsce`.
 *
 * `vsce` would be the obvious tool, and it pulls `keytar` — a native keychain
 * module — plus a signing binary, both of which want postinstall scripts.
 * `pnpm-workspace.yaml` states the policy those would violate: build scripts
 * are opt-in one package at a time, on a one-native-module budget, because
 * every entry there is another binary to sign if M9 triggers. Paying that for a
 * credential store we do not use — publishing is out of scope for v1 (plan §8)
 * — is the wrong trade.
 *
 * A VSIX is an Open Packaging Convention zip: the extension under `extension/`,
 * a `[Content_Types].xml`, and a `extension.vsixmanifest`. That is little
 * enough to write directly and keeps the dependency tree honest.
 */

const here = fileURLToPath(new URL('.', import.meta.url))
// Was a `node -e` subprocess reading this same file. Nothing needed a child
// process for it, and spawning one is a portability liability for no gain.
const manifest = JSON.parse(readFileSync(join(here, 'package.json'), 'utf8'))

/** XML text is attacker-adjacent here only via our own manifest, but escape anyway. */
function xml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}

const staging = mkdtempSync(join(tmpdir(), 'chorus-vsix-'))
try {
  const extension = join(staging, 'extension')
  mkdirSync(extension, { recursive: true })

  // Only what the extension host actually loads. The source, the tests and the
  // sourcemap stay out: a VSIX is shipped to other people's machines.
  cpSync(join(here, 'package.json'), join(extension, 'package.json'))
  cpSync(join(here, 'package.nls.json'), join(extension, 'package.nls.json'))
  cpSync(join(here, 'README.md'), join(extension, 'README.md'))
  mkdirSync(join(extension, 'dist'), { recursive: true })
  cpSync(join(here, 'dist/extension.cjs'), join(extension, 'dist/extension.cjs'))

  writeFileSync(
    join(staging, '[Content_Types].xml'),
    `<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="json" ContentType="application/json"/>
  <Default Extension="cjs" ContentType="application/javascript"/>
  <Default Extension="md" ContentType="text/markdown"/>
  <Default Extension="vsixmanifest" ContentType="text/xml"/>
  <Default Extension="xml" ContentType="text/xml"/>
</Types>
`
  )

  const engine = manifest.engines.vscode
  writeFileSync(
    join(staging, 'extension.vsixmanifest'),
    `<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011" xmlns:d="http://schemas.microsoft.com/developer/vsx-schema-design/2011">
  <Metadata>
    <Identity Language="en-US" Id="${xml(manifest.name)}" Version="${xml(manifest.version)}" Publisher="${xml(manifest.publisher)}"/>
    <DisplayName>${xml(manifest.displayName)}</DisplayName>
    <Description xml:space="preserve">${xml(manifest.description)}</Description>
    <Tags></Tags>
    <Categories>${xml(manifest.categories.join(','))}</Categories>
    <GalleryFlags>Public</GalleryFlags>
    <Properties>
      <Property Id="Microsoft.VisualStudio.Code.Engine" Value="${xml(engine)}"/>
      <Property Id="Microsoft.VisualStudio.Code.ExtensionDependencies" Value=""/>
      <Property Id="Microsoft.VisualStudio.Code.ExtensionPack" Value=""/>
      <Property Id="Microsoft.VisualStudio.Code.ExtensionKind" Value="ui"/>
    </Properties>
  </Metadata>
  <Installation>
    <InstallationTarget Id="Microsoft.VisualStudio.Code"/>
  </Installation>
  <Dependencies/>
  <Assets>
    <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true"/>
    <Asset Type="Microsoft.VisualStudio.Services.Content.Details" Path="extension/README.md" Addressable="true"/>
  </Assets>
</PackageManifest>
`
  )

  const out = join(here, 'chorus-vscode.vsix')
  rmSync(out, { force: true })
  /*
   * Written directly rather than by shelling out to `zip`, which does not exist
   * on a Windows runner and stopped the whole packaging pipeline there. See
   * `zip.mjs` for why this is not a dependency, and for how the `-X` flag's
   * reproducibility is preserved.
   *
   * Sorted, so the archive does not depend on directory-listing order — that is
   * the other half of two machines producing identical bytes.
   */
  writeFileSync(out, zip(collect(staging).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))))
  /*
   * The version of *this* archive, written beside it.
   *
   * Chorus has to know what it is about to install, and a VSIX is a zip: main
   * would need either a dependency or a hand-rolled inflate to read the
   * manifest back out, for one string. Writing it here means the number
   * describes the artifact rather than the tree — a stale VSIX in a dev
   * checkout reports its own old version instead of whatever `package.json`
   * happens to say today.
   *
   * Before this, `bundledVersion` answered `app.getVersion()`. The app was
   * 0.12.0 and the extension 0.6.0, so Settings offered an update forever and
   * installing one changed nothing.
   */
  writeFileSync(`${out}.version`, `${manifest.version}\n`)
  console.log(`chorus-vscode.vsix  ${manifest.version}`)
} finally {
  rmSync(staging, { recursive: true, force: true })
}

/**
 * Every file under `root`, as `[archiveName, bytes]`.
 *
 * Archive names always use `/`. The format requires it, and a Windows build
 * joining with `\\` would write entries VS Code cannot resolve — the kind of
 * fault that produces a VSIX which installs and then does nothing.
 */
function collect(root) {
  const out = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else out.push([relative(root, full).split(sep).join('/'), readFileSync(full)])
    }
  }
  walk(root)
  return out
}
