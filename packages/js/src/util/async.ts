// `Promise.withResolvers` is Node 22+; OrbitID supports Node 20.
export function delay(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}
