/* tslint:disable */
/* eslint-disable */

export class VdfResult {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Front-camera MP4 bytes, empty if the file had no channel-0 frames.
     */
    readonly frontMp4: Uint8Array;
    readonly hasFront: boolean;
    readonly hasRear: boolean;
    /**
     * Rear-camera MP4 bytes, empty if the file had no channel-1 frames.
     */
    readonly rearMp4: Uint8Array;
    /**
     * JSON-encoded `Telemetry` (vehicle/driver/g/speed_rpm/gps/events/frame counts).
     */
    readonly telemetryJson: string;
}

export function init(): void;

/**
 * Parse a `.vdf` buffer and remux its front/rear H.264 streams into MP4.
 *
 * Throws (rejects, from JS's point of view a thrown `Error`) on malformed
 * input instead of panicking, so a bad upload can't crash the wasm instance.
 */
export function parseVdfToMp4(data: Uint8Array): VdfResult;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_vdfresult_free: (a: number, b: number) => void;
    readonly init: () => void;
    readonly parseVdfToMp4: (a: number, b: number) => [number, number, number];
    readonly vdfresult_frontMp4: (a: number) => [number, number];
    readonly vdfresult_hasFront: (a: number) => number;
    readonly vdfresult_hasRear: (a: number) => number;
    readonly vdfresult_rearMp4: (a: number) => [number, number];
    readonly vdfresult_telemetryJson: (a: number) => [number, number];
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
