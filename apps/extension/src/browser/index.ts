import * as vscode from 'vscode'
import { BrowserHostCore } from './host.js'
import type { BrowserHostOptions } from './host.js'

export type { BrowserHostEvent, BrowserHostOptions, BrowserHostState } from './host.js'

export class BrowserHost extends BrowserHostCore {
  constructor(options: BrowserHostOptions) {
    super(options, vscode.window, vscode.ViewColumn.Beside)
  }
}
