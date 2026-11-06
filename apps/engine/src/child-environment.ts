const REMOVED = [
  /^ELECTRON_.+$/,
  /^VSCODE_(?!(PORTABLE|SHELL_LOGIN|ENV_REPLACE|ENV_APPEND|ENV_PREPEND)).+$/,
  /^SNAP(?:|_.*)$/,
  /^GDK_PIXBUF_.+$/,
]
export function prepareChildEnvironment(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform
): void {
  if (platform === 'darwin') {
    if (env['VSCODE_NODE_OPTIONS'] !== undefined) env['NODE_OPTIONS'] = env['VSCODE_NODE_OPTIONS']
    if (env['VSCODE_NODE_REPL_EXTERNAL_MODULE'] !== undefined)
      env['NODE_REPL_EXTERNAL_MODULE'] = env['VSCODE_NODE_REPL_EXTERNAL_MODULE']
  }
  for (const name of Object.keys(env))
    if (REMOVED.some((pattern) => pattern.test(name))) Reflect.deleteProperty(env, name)
}
