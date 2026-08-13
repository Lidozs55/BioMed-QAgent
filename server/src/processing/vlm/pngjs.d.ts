/**
 * Minimal ambient typings for ``pngjs`` (the package ships no declaration
 * files). Covers exactly the surface the processing tier uses:
 * ``PNG`` constructor, ``bitblt`` and ``sync.write``.
 */

declare module "pngjs" {
  export interface PNG {
    width: number;
    height: number;
    data: Uint8Array;
  }

  export class PNG {
    constructor(options?: {
      width?: number;
      height?: number;
      filterType?: number;
      colorType?: number;
      inputColorType?: number;
    });

    static bitblt(
      src: Uint8Array,
      dst: Uint8Array,
      srcStride: number,
      dstStride: number,
      srcOffsetX: number,
      srcOffsetY: number,
      dstOffsetX: number,
      dstOffsetY: number,
      width: number,
      height: number,
    ): void;

    static sync: {
      read(buffer: Uint8Array, options?: Record<string, unknown>): PNG;
      write(png: PNG, options?: { colorType?: number; deflateLevel?: number }): Uint8Array;
    };
  }
}
