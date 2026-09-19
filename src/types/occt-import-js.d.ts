declare module 'occt-import-js' {
  interface OcctMesh {
    name?: string;
    attributes: { position: { array: number[] }; normal?: { array: number[] } };
    index: { array: number[] };
  }
  interface OcctResult {
    success: boolean;
    root: unknown;
    meshes: OcctMesh[];
  }
  interface OcctModule {
    ReadStepFile(content: Uint8Array, params: unknown): OcctResult;
    ReadIgesFile(content: Uint8Array, params: unknown): OcctResult;
    ReadBrepFile(content: Uint8Array, params: unknown): OcctResult;
  }
  const factory: (opts?: { locateFile?: (path: string) => string }) => Promise<OcctModule>;
  export default factory;
}
