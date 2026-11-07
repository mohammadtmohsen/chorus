import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { zip } from './zip.mjs'

/**
 * Packs the fixture into a VSIX, using `zip.mjs` beside it.
 *
 * **Reused rather than reimplemented, and rather than adding `vsce`.** That file
 * already writes a deterministic Open Packaging Convention archive and carries
 * the reasoning for doing so without shelling out to `zip`; a fixture is the
 * last place that should acquire a build dependency of its own.
 *
 * **No staging directory and no copy step.** The other extension stages because
 * it has a `dist/` to assemble; this one is three files that ship as they are,
 * so the archive is built straight from the source. Fewer moving parts is the
 * whole design of this fixture — see the header of `extension.js`.
 *
 *   node apps/workbench-fixture/package.mjs
 */

const here = dirname(fileURLToPath(import.meta.url))
const manifest = JSON.parse(readFileSync(join(here, 'package.json'), 'utf8'))

/*
 * Everything in the directory except what a VSIX must not carry: the archive
 * itself on a rebuild, and anything a package manager left behind.
 */
const SKIP = new Set(['node_modules', 'package.mjs'])
const files = readdirSync(here).filter((name) => !SKIP.has(name) && !name.endsWith('.vsix'))

const contentTypes = `<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="json" ContentType="application/json"/>
  <Default Extension="js" ContentType="application/javascript"/>
  <Default Extension="md" ContentType="text/markdown"/>
  <Default Extension="vsixmanifest" ContentType="text/xml"/>
</Types>
`

const vsixManifest = `<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011">
  <Metadata>
    <Identity Language="en-US" Id="${manifest.name}" Version="${manifest.version}" Publisher="${manifest.publisher}"/>
    <DisplayName>${manifest.displayName}</DisplayName>
    <Description xml:space="preserve">${manifest.description}</Description>
    <Tags/>
    <Categories>Other</Categories>
    <GalleryFlags>Public</GalleryFlags>
  </Metadata>
  <Installation>
    <InstallationTarget Id="Microsoft.VisualStudio.Code"/>
  </Installation>
  <Dependencies/>
  <Assets>
    <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true"/>
  </Assets>
</PackageManifest>
`

/* `[name, contents]` pairs — the shape `zip.mjs` iterates, read from its source. */
const entries = [
  ['[Content_Types].xml', Buffer.from(contentTypes, 'utf8')],
  ['extension.vsixmanifest', Buffer.from(vsixManifest, 'utf8')],
  ...files.map((name) => [`extension/${name}`, readFileSync(join(here, name))]),
]

const out = join(here, `${manifest.name}-${manifest.version}.vsix`)
writeFileSync(out, zip(entries))
process.stdout.write(`${out}\n`)
