declare module 'imagetracerjs' {
  const tracer: {
    imagedataToSVG(
      image: { width: number; height: number; data: Uint8Array },
      options: Record<string, number | boolean>,
    ): string
  }
  export default tracer
}
