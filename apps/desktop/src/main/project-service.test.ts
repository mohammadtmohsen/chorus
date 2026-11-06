import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, parse } from 'node:path'
import {
  migrate,
  NoLegacyTrafficError,
  ProjectStore,
  UnknownProjectError,
  UnknownTrafficOwnershipError,
  UnresolvedLegacyTrafficError,
  openSqlite,
} from '@chorus/event-store'
import { beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_TRAFFIC_PORT } from '../shared/ipc.js'
import {
  AgentFolderMissingError,
  LegacyTrafficOriginMissingError,
  LegacyTrafficPortMissingError,
  ProjectRootMissingError,
  ProjectService,
} from './project-service.js'

/*
 * Real directories, not a mocked filesystem, and the reason is the bug this
 * layer exists to avoid. macOS puts every temp directory under `/var`, which is
 * a symlink to `/private/var` — so a fake `statSync` would make the canonical
 * path tests pass while proving nothing about the case they were written for.
 */
const scratch = mkdtempSync(join(tmpdir(), 'chorus-project-service-'))

let service: ProjectService
let store: ProjectStore
let clock: number

const dir = (name: string): string => {
  const path = join(scratch, name)
  mkdirSync(path, { recursive: true })
  return path
}

beforeEach(() => {
  const db = openSqlite({ path: ':memory:' })
  migrate(db)
  clock = 1_000
  store = new ProjectStore(db, { caseSensitivePaths: true })
  service = new ProjectService(store, db, () => clock)
})

describe('adopt', () => {
  it('names a filesystem-root project with its canonical root', () => {
    const root = parse(realpathSync(process.cwd())).root
    const { project } = service.adopt(root)
    expect(project.name).toBe(realpathSync(root))
  })

  it('names a project after its folder', () => {
    const { project, created } = service.adopt(dir('alpha'))
    expect(created).toBe(true)
    expect(project.name).toBe('alpha')
  })

  it('takes an explicit name over the folder name', () => {
    expect(service.adopt(dir('beta'), '  My Thing  ').project.name).toBe('My Thing')
  })

  it('falls back to the folder name when the given one is blank', () => {
    expect(service.adopt(dir('gamma'), '   ').project.name).toBe('gamma')
  })

  it('stores the canonical root, not the path it was reached by', () => {
    const real = dir('real')
    const link = join(scratch, 'link-to-real')
    symlinkSync(real, link)

    const { project } = service.adopt(link)
    expect(project.root).toBe(link)
    // The symlink is not the canonical root, and on macOS neither is `/var/...`.
    expect(project.canonicalRoot).not.toBe(link)
    expect(project.canonicalRoot.endsWith('real')).toBe(true)
  })

  /*
   * The case a lexical comparison misses, and the one that would give a person
   * two projects, two workbenches and two sets of conversations for one folder.
   */
  it('recognises a folder already adopted under another name', () => {
    const real = dir('shared')
    const link = join(scratch, 'link-to-shared')
    symlinkSync(real, link)

    const first = service.adopt(real)
    const second = service.adopt(link)

    expect(second.created).toBe(false)
    expect(second.project.id).toBe(first.project.id)
    expect(service.list()).toHaveLength(1)
  })

  it('records an open when it hands back an existing project', () => {
    const path = dir('touched')
    const first = service.adopt(path)
    clock = 9_000
    expect(service.adopt(path).project.lastOpenedAt).toBe(9_000)
    expect(first.project.lastOpenedAt).toBe(1_000)
  })

  it('refuses a path that is not there', () => {
    expect(() => service.adopt(join(scratch, 'nothing-here'))).toThrow(/No such workbench project/)
  })

  it('refuses a file', () => {
    const file = join(scratch, 'a-file.txt')
    writeFileSync(file, 'x')
    expect(() => service.adopt(file)).toThrow(/must be a directory/)
  })

  it('refuses a relative path', () => {
    expect(() => service.adopt('relative/path')).toThrow(/absolute/)
  })
})

describe('resolveRoot', () => {
  it('turns an adopted id into its canonical root', () => {
    const { project } = service.adopt(dir('resolvable'))
    expect(service.resolveRoot(project.id)).toBe(project.canonicalRoot)
  })

  /*
   * Phase 1's E2 requirement, stated there as "a test that an id nobody adopted
   * is refused". The second arm of WorkbenchTarget resolves against this, so an
   * id that resolves to anything at all is a directory somebody was handed
   * without a dialog.
   */
  it('refuses an id nobody adopted', () => {
    expect(() => service.resolveRoot('not-a-project')).toThrow(UnknownProjectError)
  })

  it('refuses an adopted id whose folder has gone, and says which folder', () => {
    const path = dir('vanishing')
    const { project } = service.adopt(path)
    rmSync(path, { recursive: true, force: true })

    let thrown: unknown
    try {
      service.resolveRoot(project.id)
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(ProjectRootMissingError)
    expect((thrown as ProjectRootMissingError).canonicalRoot).toBe(project.canonicalRoot)
  })

  /*
   * The two refusals must stay distinguishable. A caller offers Relocate for one
   * and nothing at all for the other, so collapsing them into a single error
   * would make a moved folder look like a forged id.
   */
  it('distinguishes a missing folder from an unknown id', () => {
    const path = dir('distinct')
    const { project } = service.adopt(path)
    rmSync(path, { recursive: true, force: true })

    expect(() => service.resolveRoot(project.id)).not.toThrow(UnknownProjectError)
    expect(() => service.resolveRoot('never-adopted')).not.toThrow(ProjectRootMissingError)
  })
})

/*
 * The same question `resolveRoot` enforces, asked without an exception — the
 * listing needs it, because a project whose folder has gone still has to be
 * drawn. Until it existed the renderer found out by failing, and on launch the
 * thing that failed was the auto-start, which replaced the whole app with an
 * error screen offering no way back to the project it was complaining about.
 */
describe('rootPresent', () => {
  it('is true while the folder is there', () => {
    const { project } = service.adopt(dir('still-here'))
    expect(service.rootPresent(project.id)).toBe(true)
  })

  it('is false once the folder has gone, and does not throw', () => {
    const path = dir('went-away')
    const { project } = service.adopt(path)
    rmSync(path, { recursive: true, force: true })

    expect(service.rootPresent(project.id)).toBe(false)
    // The whole point: the listing must not need a try/catch around each row.
    expect(() => service.rootPresent(project.id)).not.toThrow()
  })

  it('is false for an id nobody adopted, rather than throwing', () => {
    expect(service.rootPresent('not-a-project')).toBe(false)
  })

  it('agrees with resolveRoot, so a listing cannot contradict a launch', () => {
    const path = dir('agreeing')
    const { project } = service.adopt(path)
    expect(service.rootPresent(project.id)).toBe(true)
    expect(() => service.resolveRoot(project.id)).not.toThrow()

    rmSync(path, { recursive: true, force: true })
    expect(service.rootPresent(project.id)).toBe(false)
    expect(() => service.resolveRoot(project.id)).toThrow(ProjectRootMissingError)
  })

  /*
   * A file where a directory should be. `existsSync` would call this present and
   * the failure would surface much later, inside the extension host, as an error
   * about a server rather than about a folder.
   */
  it('is false for a path that exists but is not a directory', () => {
    const path = dir('becomes-a-file')
    const { project } = service.adopt(path)
    rmSync(path, { recursive: true, force: true })
    writeFileSync(path, 'not a directory')

    expect(service.rootPresent(project.id)).toBe(false)
  })
})

describe('resolveAgentCwd', () => {
  const remote = (agentCwd: string | null): ReturnType<ProjectStore['create']> =>
    store.create({
      name: 'Api',
      host: 'tpa-be',
      root: 'C:/TPA-MEDEXA/MasterTPABackend',
      canonicalRoot: 'C:/TPA-MEDEXA/MasterTPABackend',
      workspaceFile: null,
      agentCwd,
      now: clock,
    })

  it('is the project root for a local project', () => {
    const { project } = service.adopt(dir('local-agents'))
    expect(service.resolveAgentCwd(project.id)).toBe(service.resolveRoot(project.id))
  })

  it('is the local folder for a remote project, though its root is not on this machine', () => {
    const folder = dir('remote-agents')
    expect(service.resolveAgentCwd(remote(folder).id)).toBe(folder)
  })

  it('refuses a remote project with no local folder, and not as a missing root', () => {
    const project = remote(null)
    expect(() => service.resolveAgentCwd(project.id)).toThrow(AgentFolderMissingError)
    expect(() => service.resolveAgentCwd(project.id)).not.toThrow(ProjectRootMissingError)
  })

  it('refuses a remote project whose local folder has gone, and names it', () => {
    const folder = dir('gone-agents')
    const project = remote(folder)
    rmSync(folder, { recursive: true })
    expect(() => service.resolveAgentCwd(project.id)).toThrow(folder)
  })

  it('refuses an id nobody adopted', () => {
    expect(() => service.resolveAgentCwd('never-adopted')).toThrow(UnknownProjectError)
  })
})

describe('adoptRemote', () => {
  const api = (agentCwd: string): ReturnType<ProjectService['adoptRemote']> =>
    service.adoptRemote({ host: 'tpa-be', root: 'C:/api', agentCwd })

  it('stores the remote root in one spelling and names the project after its folder', () => {
    const { project, created } = service.adoptRemote({
      host: 'tpa-be',
      root: 'c:\\TPA-MEDEXA\\MasterTPABackend\\',
      agentCwd: dir('tpa-agents'),
    })
    expect(created).toBe(true)
    expect(project.host).toBe('tpa-be')
    expect(project.canonicalRoot).toBe('C:/TPA-MEDEXA/MasterTPABackend')
    expect(project.name).toBe('MasterTPABackend')
  })

  it('stores the agents folder canonically, whatever path reached it', () => {
    const real = dir('real-agents')
    const link = join(scratch, 'linked-agents')
    symlinkSync(real, link)
    expect(api(link).project.agentCwd).toBe(realpathSync(real))
  })

  it('finds the project it already holds, whatever spelling of host or root', () => {
    const agentCwd = dir('again-agents')
    const first = service.adoptRemote({
      host: 'tpa-be',
      root: 'C:/TPA-MEDEXA/MasterTPABackend',
      agentCwd,
    })
    const second = service.adoptRemote({
      host: 'TPA-BE',
      root: '/C:/TPA-MEDEXA/MasterTPABackend/',
      agentCwd,
    })
    expect(second.created).toBe(false)
    expect(second.project.id).toBe(first.project.id)
  })

  it('refuses an agents folder that is not on this machine', () => {
    expect(() => api(join(scratch, 'absent-agents'))).toThrow()
  })

  it('refuses a root that is not anchored, and a host ssh would read as an option', () => {
    const agentCwd = dir('refusing-agents')
    const option = '-oProxyCommand=x'
    expect(() => service.adoptRemote({ host: 'tpa-be', root: 'api', agentCwd })).toThrow()
    expect(() => service.adoptRemote({ host: option, root: 'C:/api', agentCwd })).toThrow()
  })

  it('tells the workbench which host each project lives on', () => {
    const { project } = api(dir('target-agents'))
    expect(service.workbenchTarget(project.id)).toEqual({ host: 'tpa-be', root: 'C:/api' })
    const local = service.adopt(dir('target-local')).project
    expect(service.workbenchTarget(local.id)).toEqual({ host: '', root: local.canonicalRoot })
  })

  it('is present and resolvable, though its root is not on this machine', () => {
    const { project } = api(dir('present-agents'))
    expect(service.rootPresent(project.id)).toBe(true)
    expect(service.resolveRoot(project.id)).toBe('C:/api')
    expect(service.resolveAgentCwd(project.id)).toBe(project.agentCwd)
  })
})

describe('relocate', () => {
  it('moves a project to a directory that exists', () => {
    const { project } = service.adopt(dir('before-move'))
    const destination = dir('after-move')

    const moved = service.relocate(project.id, destination)
    expect(moved.root).toBe(destination)
    expect(service.resolveRoot(project.id)).toBe(moved.canonicalRoot)
  })

  it('refuses to relocate onto a path that is not there', () => {
    const { project } = service.adopt(dir('stays-put'))
    expect(() => service.relocate(project.id, join(scratch, 'no-such-dir'))).toThrow(
      /No such workbench project/
    )
    expect(service.get(project.id)?.root).toBe(join(scratch, 'stays-put'))
  })
})

describe('the rest of the registry', () => {
  it('renames', () => {
    const { project } = service.adopt(dir('to-rename'))
    expect(service.rename(project.id, 'Renamed').name).toBe('Renamed')
  })

  it('forgets, and reports whether there was anything to forget', () => {
    const { project } = service.adopt(dir('to-forget'))
    expect(service.forget(project.id)).toBe(true)
    expect(service.get(project.id)).toBeNull()
    expect(service.forget(project.id)).toBe(false)
  })

  /*
   * This asserted recency ordering until the rail became arrangeable. `opened` is
   * still the interesting half: it still records the open, and the regression to
   * guard is that recording it stops moving the tile.
   */
  it('keeps the arrangement when a project is opened', () => {
    const first = service.adopt(dir('one')).project
    clock = 2_000
    const second = service.adopt(dir('two')).project
    expect(service.list().map((p) => p.id)).toEqual([first.id, second.id])

    clock = 3_000
    service.opened(first.id)
    expect(service.list().map((p) => p.id)).toEqual([first.id, second.id])
  })

  it('swaps two projects and answers with the new order', () => {
    const first = service.adopt(dir('one')).project
    clock = 2_000
    const second = service.adopt(dir('two')).project

    expect(service.moveOrder(first.id, null).map((p) => p.id)).toEqual([second.id, first.id])
    expect(service.list().map((p) => p.id)).toEqual([second.id, first.id])
  })
})

describe('the shared traffic connection', () => {
  const settingsWith = (contents: string): string => {
    const path = mkdtempSync(join(tmpdir(), 'chorus-traffic-'))
    writeFileSync(join(path, 'settings.json'), contents, 'utf8')
    return path
  }

  const configured = (): string =>
    settingsWith(JSON.stringify({ trafficOrigin: 'http://127.0.0.1:8080', trafficPort: 30_100 }))

  it('reserves the port the saved connection was on', () => {
    service.syncLegacyTraffic(configured())

    const project = service.adopt(dir('one')).project
    expect(service.nextTrafficPort(project.id)).toBe(DEFAULT_TRAFFIC_PORT + 1)
  })

  it('reserves it for a file that holds nothing but the defaults, too', () => {
    service.syncLegacyTraffic(
      settingsWith(JSON.stringify({ trafficOrigin: '', trafficPort: DEFAULT_TRAFFIC_PORT }))
    )

    expect(service.trafficImport().candidate).toEqual({
      origin: null,
      port: DEFAULT_TRAFFIC_PORT,
      access: 'lan',
    })
  })

  it('decides there is nothing to import before a later write can invent one', () => {
    service.syncLegacyTraffic(settingsWith(JSON.stringify({ theme: 'dark' })))

    expect(service.trafficImport()).toEqual({
      completed: true,
      assignedProjectId: null,
      candidate: null,
      error: null,
    })
  })

  it('reads the same file twice without moving anything', () => {
    const settings = configured()
    service.syncLegacyTraffic(settings)
    const first = service.trafficImport()
    service.syncLegacyTraffic(settings)

    expect(service.trafficImport()).toEqual(first)
  })

  it('holds every project port when the saved port could not be read', () => {
    expect(service.syncLegacyTraffic(settingsWith('{ not json'))).toMatchObject({
      kind: 'unreadable',
    })

    expect(service.trafficImport()).toMatchObject({
      completed: false,
      assignedProjectId: null,
      candidate: { origin: null, port: null, access: 'lan' },
      error: expect.any(String),
    })
    const project = service.adopt(dir('one')).project
    expect(() => service.nextTrafficPort(project.id)).toThrow(UnknownTrafficOwnershipError)
  })

  it('protects a newly disputed port even when an older candidate exists', () => {
    service.syncLegacyTraffic(
      settingsWith(JSON.stringify({ trafficOrigin: 'http://127.0.0.1:8080', trafficPort: 31_200 }))
    )
    service.syncLegacyTraffic(
      settingsWith(JSON.stringify({ trafficOrigin: 12, trafficPort: DEFAULT_TRAFFIC_PORT }))
    )
    const project = service.adopt(dir('one')).project

    expect(service.trafficImport().candidate?.port).toBe(DEFAULT_TRAFFIC_PORT)
    expect(() =>
      service.setTrafficConfig(project.id, { trafficPort: DEFAULT_TRAFFIC_PORT })
    ).toThrow()
    expect(() => service.adoptLegacyTraffic(project.id)).toThrow(UnresolvedLegacyTrafficError)
  })

  it('reserves the port it could still read when the rest of the file is unusable', () => {
    service.syncLegacyTraffic(
      settingsWith(JSON.stringify({ trafficOrigin: 12, trafficPort: 31_200 }))
    )
    const project = service.adopt(dir('one')).project

    expect(service.trafficImport().candidate?.port).toBe(31_200)
    expect(() => service.setTrafficConfig(project.id, { trafficPort: 31_200 })).toThrow()
  })

  it('keeps a candidate it already had when the file goes unreadable', () => {
    service.syncLegacyTraffic(
      settingsWith(JSON.stringify({ trafficOrigin: '', trafficPort: 31_200 }))
    )
    service.syncLegacyTraffic(settingsWith('{ not json'))

    expect(service.trafficImport().candidate?.port).toBe(31_200)
    expect(service.trafficImport().error).toEqual(expect.any(String))
  })

  it('never reopens a decided import, whatever the file still says', () => {
    service.dismissLegacyTraffic()
    service.syncLegacyTraffic(configured())

    expect(service.trafficImport().completed).toBe(true)
    expect(service.trafficImport().candidate).toBeNull()
  })

  it('hands the connection to a project, once', () => {
    service.syncLegacyTraffic(configured())
    const project = service.adopt(dir('one')).project

    const adopted = service.adoptLegacyTraffic(project.id)
    expect(adopted.trafficOrigin).toBe('http://127.0.0.1:8080')
    expect(adopted.trafficPort).toBe(30_100)
    expect(adopted.trafficAccess).toBe('lan')
    expect(service.trafficImport().assignedProjectId).toBe(project.id)

    const other = service.adopt(dir('two')).project
    expect(() => service.adoptLegacyTraffic(other.id)).toThrow(NoLegacyTrafficError)
  })

  it('refuses to hand over a connection with nowhere to forward to', () => {
    service.syncLegacyTraffic(
      settingsWith(JSON.stringify({ trafficOrigin: '', trafficPort: DEFAULT_TRAFFIC_PORT }))
    )
    const project = service.adopt(dir('one')).project

    expect(() => service.adoptLegacyTraffic(project.id)).toThrow(LegacyTrafficOriginMissingError)
  })

  it('refuses to hand over a connection with no port of its own', () => {
    service.syncLegacyTraffic(
      settingsWith(JSON.stringify({ trafficOrigin: 'http://127.0.0.1:8080', trafficPort: 0 }))
    )
    const project = service.adopt(dir('one')).project

    expect(() => service.adoptLegacyTraffic(project.id)).toThrow(LegacyTrafficPortMissingError)
  })

  it('releases the port when the connection is dismissed', () => {
    service.syncLegacyTraffic(configured())
    service.dismissLegacyTraffic()

    const project = service.adopt(dir('one')).project
    expect(service.nextTrafficPort(project.id)).toBe(DEFAULT_TRAFFIC_PORT)
  })
})
