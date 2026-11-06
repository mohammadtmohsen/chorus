export const CHORUS_WORLD = 'chorus'
export const SELECT_BINDING = 'chorusSelect'

export const SELECT_BRIDGE = `(() => {
  if (typeof globalThis.chorusChooseSelect === 'function') return
  const selects = new Map()
  const selectFrom = (event) => event.composedPath().find((node) => node instanceof HTMLSelectElement) ?? null
  const eligible = (select) => select instanceof HTMLSelectElement && select.isConnected && !select.multiple && select.size <= 1 && !select.matches(':disabled')
  const disabled = (option) => option.disabled || (option.parentElement instanceof HTMLOptGroupElement && option.parentElement.disabled)
  const open = (select) => {
    const token = [...crypto.getRandomValues(new Uint8Array(16))].map((byte) => byte.toString(16).padStart(2, '0')).join('')
    selects.clear()
    selects.set(token, select)
    select.focus()
    const box = select.getBoundingClientRect()
    globalThis.${SELECT_BINDING}(JSON.stringify({
      token,
      selectedIndex: select.selectedIndex,
      rect: { x: box.left, y: box.bottom, width: box.width },
      options: [...select.options].slice(0, 2000).map((option) => ({
        label: option.label.slice(0, 1000),
        disabled: disabled(option),
        group: option.parentElement instanceof HTMLOptGroupElement ? option.parentElement.label.slice(0, 1000) : null,
      })),
    }))
  }
  document.addEventListener('mousedown', (event) => {
    const select = selectFrom(event)
    if (!event.isTrusted || event.button !== 0 || !eligible(select)) return
    event.preventDefault()
    open(select)
  }, true)
  document.addEventListener('keydown', (event) => {
    const select = selectFrom(event)
    if (!event.isTrusted || !eligible(select)) return
    const opens = event.key === ' ' || event.key === 'F4' || (event.altKey && (event.key === 'ArrowDown' || event.key === 'ArrowUp'))
    if (!opens) return
    event.preventDefault()
    open(select)
  }, true)
  globalThis.chorusChooseSelect = (token, index) => {
    const select = selects.get(token)
    selects.clear()
    if (!eligible(select)) return false
    select.focus()
    if (index === -1) return true
    if (!Number.isInteger(index) || index < 0 || index >= select.options.length) return false
    const option = select.options[index]
    if (option === undefined || disabled(option)) return false
    select.selectedIndex = index
    select.dispatchEvent(new Event('input', { bubbles: true, composed: true }))
    select.dispatchEvent(new Event('change', { bubbles: true, composed: true }))
    return true
  }
})()`

export const chooseSelectExpression = (token: string, index: number): string =>
  `globalThis.chorusChooseSelect(${JSON.stringify(token)}, ${String(index)})`
