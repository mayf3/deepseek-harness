declare module '*.module.css' {
  const classes: Record<string, string>
  export default classes
}

declare module '*.css'

declare module '*running-whale@2x.png' {
  const url: string
  export default url
}
