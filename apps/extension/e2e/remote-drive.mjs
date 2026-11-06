import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { integrationHarness, OUTPUT } from './integration-harness.mjs'

const HOST = 'chorus-remote-test'
const BASE = process.env.CHORUS_REMOTE_BASE
if (BASE === undefined) throw new Error('Set CHORUS_REMOTE_BASE to the private sshd directory')
const REMOTE_ROOT = join(BASE, 'tree/proj')
const LOCAL_AGENTS = join(BASE, 'local-agent')
const REMOTE_FILE = join(REMOTE_ROOT, 'code.txt')
const REMOTE_URI = `vscode-remote://ssh-remote+${HOST}${REMOTE_FILE}`
const ORIGINAL = 'before remote\nsecond line\n'
mkdirSync(REMOTE_ROOT, { recursive: true })
mkdirSync(LOCAL_AGENTS, { recursive: true })
writeFileSync(REMOTE_FILE, ORIGINAL)

const h = await integrationHarness('remote', {
  folder: null,
  args: [`--folder-uri=vscode-remote://ssh-remote+${HOST}${REMOTE_ROOT}`],
  preinstall: ['ms-vscode-remote.remote-ssh'],
  settings: {
    'remote.SSH.configFile': join(BASE, 'ssh/ssh_config'),
    'remote.SSH.remotePlatform': { [HOST]: 'macOS' },
    'remote.SSH.serverInstallPath': { [HOST]: join(BASE, 'server') },
    'remote.SSH.useLocalServer': false,
    'remote.SSH.showLoginTerminal': false,
    'remote.autoForwardPorts': false,
  },
})
const workbenchText = async (selector) =>
  (await h.driver.workbench()).evaluate(
    `Array.from(document.querySelectorAll(${JSON.stringify(selector)})).map((element)=>element.textContent).join('\\n')`
  )
const remoteDocument = async () =>
  (await h.native({ action: 'state' })).documents.find(
    (document) => document.uri.startsWith('vscode-remote:') && document.uri.endsWith('/code.txt')
  )
try {
  await h.start({
    before: async () => {
      await h.driver.poll(
        'the Remote-SSH connection',
        async () => (await workbenchText('.statusbar-item')).includes(HOST),
        240_000
      )
      await new Promise((resolve) => setTimeout(resolve, 3_000))
      await h.native({ action: 'open', uri: REMOTE_URI, selection: [0, 0, 0, 6] })
    },
  })
  h.check('VS Code connects over Remote-SSH and Chorus opens beside the remote editor')
  await h.click('[aria-label="Add project"], .empty .primary')
  await h.driver.answerSimpleDialog(REMOTE_ROOT)
  await h.driver.answerSimpleDialog(LOCAL_AGENTS)
  const session = await h.driver.poll(
    'the remote project session',
    async () =>
      (await h.api('readActiveSessions')).sessions.find(
        (entry) => entry.cwd === LOCAL_AGENTS && !entry.starting
      ),
    90_000
  )
  const { projects } = await h.api('listProjects', {})
  assert.equal(projects.length, 1)
  assert.equal(projects[0].host, HOST)
  assert.equal(projects[0].root, REMOTE_ROOT)
  h.check('a remote project keeps its host, remote root and local agent folder', projects[0])
  await h.driver.screenshot(join(OUTPUT, 'remote-01-project.png'))

  const pwd = await h.send(
    session,
    '@claude Run pwd once and reply exactly AGENT_WORKDIR followed by its output. No other tools.'
  )
  const where = await h.waitReply(session, pwd, 'AGENT_WORKDIR')
  assert.ok(where.payload.text.includes(LOCAL_AGENTS))
  h.check('the real agent runs locally, not on the remote side', where.payload.text)
  const rowScroll = () =>
    h
      .view()
      .then((frame) =>
        frame.evaluate(
          `Array.from(document.querySelectorAll('.workspace-pane-row, .pane-row, [class*="row"]')).map((element) => [element.className, element.scrollLeft]).filter(([, left]) => left > 0)`
        )
      )
  console.log('row after reply', JSON.stringify(await rowScroll()))
  await h.driver.screenshot(join(OUTPUT, 'remote-01b-after-reply.png'))

  await h.native({ action: 'open', uri: REMOTE_URI, selection: [0, 0, 0, 6] })
  let lastSnapshot = null
  const snapshot = await h.driver
    .poll('the remote selection', async () => {
      lastSnapshot = await h.api('ideSnapshot', { conversationId: session.conversationId })
      return lastSnapshot.outcome === 'ok' && lastSnapshot.text === 'before' ? lastSnapshot : null
    })
    .catch((error) => {
      console.error('last snapshot', JSON.stringify(lastSnapshot))
      throw error
    })
  assert.equal(snapshot.relativePath, 'code.txt')
  h.check('a remote file selection reaches the project composer', snapshot)
  console.log('row after selection', JSON.stringify(await rowScroll()))
  await h.driver.screenshot(join(OUTPUT, 'remote-01c-after-selection.png'))

  const version = (await remoteDocument()).version
  const before = await h.send(
    session,
    `@claude This is an authorized native editor smoke test. Use ONLY mcp__chorus_editor__editor_edit once on code.txt, base_version ${String(version)}, start_line 1, start_column 1, end_line 1, end_column 7, old_text "before", new_text "AFTER". Do not use Read, Edit, Write or Bash. Wait for approval; after the tool reply, say EDIT_OK.`
  )
  await h.driver.waitInWebview(
    `document.querySelector('[data-conversation="${session.conversationId}"] .approval') !== null`,
    { timeoutMs: 180_000 }
  )
  await h.driver.screenshot(join(OUTPUT, 'remote-02-approval.png'))
  await h.click(`[data-conversation="${session.conversationId}"] .approval-actions .btn--go`)
  await h.waitReply(session, before, 'EDIT_OK')
  const edited = await remoteDocument()
  assert.equal(edited.text, 'AFTER remote\nsecond line\n')
  assert.equal(edited.dirty, true)
  assert.equal(readFileSync(REMOTE_FILE, 'utf8'), ORIGINAL)
  h.check('the agent edit lands in the remote buffer, unsaved, and the remote disk is unchanged')
  await h.driver.screenshot(join(OUTPUT, 'remote-03-edited.png'))
} catch (error) {
  console.error(error)
  if (h.driver !== undefined)
    await h.driver.screenshot(join(OUTPUT, 'remote-failure.png')).catch(() => undefined)
  process.exitCode = 1
} finally {
  h.save()
  await h.close()
}
