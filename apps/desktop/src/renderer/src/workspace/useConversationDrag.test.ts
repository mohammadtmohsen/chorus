import { afterEach, describe, expect, it, vi } from 'vitest'
import { targetAt } from './useConversationDrag.js'

afterEach(() => {
  vi.unstubAllGlobals()
})

function showColumn(project: string): void {
  const column = {
    dataset: { group: 'target-group', project },
    getBoundingClientRect: () => ({
      left: 0,
      right: 500,
      top: 0,
      bottom: 500,
      width: 500,
      height: 500,
    }),
  }
  vi.stubGlobal('document', { elementFromPoint: () => ({ closest: () => column }) })
}

describe('conversation drop ownership', () => {
  it('refuses a column belonging to another project', () => {
    showColumn('other-project')
    expect(targetAt(1, 250, 'source-group', 'source-project')).toBeNull()
  })

  it('keeps edge drops within the source project', () => {
    showColumn('source-project')
    expect(targetAt(1, 250, 'source-group', 'source-project')).toEqual({
      groupId: 'target-group',
      direction: 'left',
    })
  })
})
