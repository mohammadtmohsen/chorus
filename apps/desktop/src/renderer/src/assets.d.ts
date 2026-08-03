/** Vite handles these as side-effect imports; TypeScript just needs to know they exist. */
declare module '*.css' {
  const content: string
  export default content
}
