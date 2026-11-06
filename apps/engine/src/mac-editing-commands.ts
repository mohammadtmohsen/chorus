const navigation: Readonly<Record<string, string>> = {
  ArrowLeft: 'moveLeft',
  ArrowRight: 'moveRight',
  ArrowUp: 'moveUp',
  ArrowDown: 'moveDown',
  'Meta+ArrowLeft': 'moveToLeftEndOfLine',
  'Meta+ArrowRight': 'moveToRightEndOfLine',
  'Meta+ArrowUp': 'moveToBeginningOfDocument',
  'Meta+ArrowDown': 'moveToEndOfDocument',
  'Alt+ArrowLeft': 'moveWordLeft',
  'Alt+ArrowRight': 'moveWordRight',
  'Control+ArrowLeft': 'moveToLeftEndOfLine',
  'Control+ArrowRight': 'moveToRightEndOfLine',
  'Control+KeyA': 'moveToBeginningOfParagraph',
  'Control+KeyE': 'moveToEndOfParagraph',
  'Control+KeyB': 'moveBackward',
  'Control+KeyF': 'moveForward',
  'Control+KeyP': 'moveUp',
  'Control+KeyN': 'moveDown',
  'Control+KeyV': 'pageDown',
  'Control+Alt+KeyB': 'moveWordBackward',
  'Control+Alt+KeyF': 'moveWordForward',
}

const bindings: Record<string, readonly string[]> = {
  Home: ['scrollToBeginningOfDocument:'],
  End: ['scrollToEndOfDocument:'],
  PageUp: ['scrollPageUp:'],
  PageDown: ['scrollPageDown:'],
  'Shift+Home': ['moveToBeginningOfDocumentAndModifySelection:'],
  'Shift+End': ['moveToEndOfDocumentAndModifySelection:'],
  'Shift+PageUp': ['pageUpAndModifySelection:'],
  'Shift+PageDown': ['pageDownAndModifySelection:'],
  'Alt+ArrowUp': ['moveBackward:', 'moveToBeginningOfParagraph:'],
  'Alt+ArrowDown': ['moveForward:', 'moveToEndOfParagraph:'],
  'Shift+Alt+ArrowUp': ['moveParagraphBackwardAndModifySelection:'],
  'Shift+Alt+ArrowDown': ['moveParagraphForwardAndModifySelection:'],
  'Control+Tab': ['selectNextKeyView:'],
  'Shift+Control+Tab': ['selectPreviousKeyView:'],
  'Meta+KeyA': ['selectAll:'],
  'Meta+KeyZ': ['undo:'],
  'Shift+Meta+KeyZ': ['redo:'],
}

for (const [shortcut, selector] of Object.entries(navigation)) {
  bindings[shortcut] = [`${selector}:`]
  bindings[`Shift+${shortcut}`] = [`${selector}AndModifySelection:`]
}

for (const [shortcut, selector] of Object.entries({
  Backspace: 'deleteBackward',
  Delete: 'deleteForward',
  'Alt+Backspace': 'deleteWordBackward',
  'Alt+Delete': 'deleteWordForward',
  'Meta+Backspace': 'deleteToBeginningOfLine',
  'Control+Backspace': 'deleteBackwardByDecomposingPreviousCharacter',
  'Control+Alt+Backspace': 'deleteWordBackward',
  'Control+ArrowUp': 'scrollPageUp',
  'Control+ArrowDown': 'scrollPageDown',
  'Alt+PageUp': 'pageUp',
  'Alt+PageDown': 'pageDown',
  Escape: 'cancelOperation',
  'Alt+Escape': 'complete',
  F5: 'complete',
  'Meta+NumpadSubtract': 'cancel',
})) {
  bindings[shortcut] = [`${selector}:`]
  bindings[`Shift+${shortcut}`] = [`${selector}:`]
}

bindings['Control+KeyD'] = ['deleteForward:']
bindings['Control+KeyH'] = ['deleteBackward:']
bindings['Control+KeyK'] = ['deleteToEndOfParagraph:']
bindings['Control+KeyL'] = ['centerSelectionInVisibleArea:']
bindings['Control+KeyT'] = ['transpose:']
bindings['Shift+Numpad5'] = ['delete:']

export const MAC_EDITING_COMMANDS: Readonly<Record<string, readonly string[]>> =
  Object.freeze(bindings)

export function commandsFor(code: string, modifiers: number): string[] {
  const shortcut = [
    modifiers & 8 ? 'Shift' : null,
    modifiers & 2 ? 'Control' : null,
    modifiers & 1 ? 'Alt' : null,
    modifiers & 4 ? 'Meta' : null,
    code,
  ]
    .filter((part) => part !== null)
    .join('+')
  const selectors = Object.hasOwn(MAC_EDITING_COMMANDS, shortcut)
    ? (MAC_EDITING_COMMANDS[shortcut] ?? [])
    : []
  return selectors
    .filter((selector) => !selector.startsWith('insert'))
    .map((selector) => selector.replace(/:$/, ''))
}
