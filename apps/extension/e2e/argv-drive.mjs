import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { integrationHarness } from './integration-harness.mjs'

const SHARED_ARGUMENTS = join(homedir(), '.vscode/argv.json')
const SHARED_STORAGE = join(homedir(), '.vscode-shared/sharedStorage/state.vscdb')
const VISIBLE_ADDRESS =
  "Array.from(document.querySelectorAll('.browser-address-input')).find((input)=>input.checkVisibility())"
const sharedValue = (key) =>
  execFileSync(
    'sqlite3',
    [
      '-readonly',
      `file:${SHARED_STORAGE}?mode=ro`,
      `select value from ItemTable where key='${key}'`,
    ],
    { encoding: 'utf8' }
  )

const argumentsBefore = readFileSync(SHARED_ARGUMENTS, 'utf8')
const trustBefore = sharedValue('content.trust.model.key')
const server = createServer((_request, response) => {
  response.writeHead(200, { 'content-type': 'text/html' })
  response.end('<!doctype html><title>Argv page</title><h1>Argv page</h1>')
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const h = await integrationHarness('argv', {
  proposal: false,
  runtimeArguments: { 'enable-proposed-api': ['mohammadtmohsen.chorus'] },
})
try {
  await h.start()
  const project = await h.add(h.alpha)
  await h.select(project)
  await h.driver.waitInWebview(`${VISIBLE_ADDRESS}?.disabled===false`)
  await (
    await h.view()
  ).evaluate(
    `(() => {const input=${VISIBLE_ADDRESS};input.focus();Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(`http://127.0.0.1:${server.address().port}/`)});input.dispatchEvent(new Event('input',{bubbles:true}));input.closest('form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}))})()`
  )
  await h.driver.poll('native browser page', async () =>
    (await h.native({ action: 'state' })).tabs.find((tab) => tab.label === 'Argv page')
  )
  h.check('the permanent argv.json setting enables browser tools with no command-line flag')
  assert.equal(readFileSync(SHARED_ARGUMENTS, 'utf8'), argumentsBefore)
  assert.equal(sharedValue('content.trust.model.key'), trustBefore)
  assert.equal(sharedValue('history.recentlyOpenedPathsList').includes(h.workspace), false)
  h.check("a test window leaves VS Code's shared arguments, trust and recent folders alone")
} catch (error) {
  console.error(error)
  process.exitCode = 1
} finally {
  h.save()
  await h.close()
  await new Promise((resolve) => server.close(resolve))
}
