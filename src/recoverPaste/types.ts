// Shared types for paste recovery: the public result/options shapes plus the
// internal source and adapter contracts every harness implements.

export interface RecoveredImage {
    path: string;
    mediaType: string;
    bytes: number;
    /** Original attachment name, when the harness stored one (opencode does). */
    filename?: string;
}

export interface RecoverResult {
    harness: string;
    transcript: string;
    images: RecoveredImage[];
    /** The harness this process was detected to run inside, when detection fired. */
    detected?: string;
}

export interface RecoverOptions {
    cwd?: string;
    transcript?: string;
    session?: string;
    count?: number;
    outDir?: string;
    /** Force the harness scope, bypassing detection ('none' disables scoping). */
    harness?: string;
}

export interface ImageBlockRef {
    mediaType: string;
    data: string;
    filename?: string;
}

/** A located source of pasted images: a JSONL transcript or a SQLite db. */
export interface SourceRef {
    harness: string;
    /** Displayable location (file path). */
    location: string;
    /** Extract all user images, oldest to newest. */
    extract: () => ImageBlockRef[];
}

export interface HarnessAdapter {
    name: string;
    /** Best candidate for this cwd with the newest image timestamp (epoch ms). */
    findNewest(cwd: string): { ref: SourceRef; timestamp: number } | null;
    /** Exact session lookup. */
    findSession(cwd: string, sessionId: string): SourceRef | null;
    /** Where this adapter looks, for error messages. */
    describe(cwd: string): string;
}
