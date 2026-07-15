export type TrackingBaselineKind = 'task' | 'attempt';
export type TrackingFileType = 'file' | 'symlink' | 'directory' | 'other';

export interface TrackingFileEntry {
  readonly path: string;
  readonly type: TrackingFileType;
  readonly size: number;
  readonly hash: string | null;
  readonly blobHash: string | null;
  readonly missing: boolean;
  readonly executable: boolean;
  readonly binary: boolean;
  readonly linkTarget?: string;
  readonly contentCaptured?: boolean;
  readonly contentExclusionReason?: string;
}

export interface TrackingBaselineManifest {
  readonly version: 1;
  readonly status: 'complete';
  readonly kind: TrackingBaselineKind;
  readonly taskId: string;
  readonly baselineId: string;
  readonly attemptId?: string;
  readonly attemptNumber?: number;
  readonly parentTaskBaselineId?: string;
  readonly createdAt: string;
  readonly files: readonly TrackingFileEntry[];
  readonly exclusions: readonly unknown[];
  readonly checksum: string;
}

export type TrackingBaselineLoadResult =
  | { readonly status: 'loaded'; readonly manifest: TrackingBaselineManifest }
  | { readonly status: 'ignored'; readonly diagnostic: string };

export interface CaptureTaskBaselineInput {
  readonly taskId: string;
  readonly baselineId: string;
  readonly createdAt?: Date;
}

export interface CaptureAttemptBaselineInput extends CaptureTaskBaselineInput {
  readonly attemptId: string;
  readonly attemptNumber: number;
  readonly parentTaskBaselineId: string;
}

export interface TrackingCurrentSnapshot {
  readonly files: readonly TrackingFileEntry[];
  readonly exclusions: readonly unknown[];
  readonly blobs: ReadonlyMap<string, Buffer>;
}

export interface BaselineTrackerPort {
  readonly projectRoot: string;
  readonly snapshotStore: string;
  captureTaskBaseline(input: CaptureTaskBaselineInput): TrackingBaselineManifest;
  captureAttemptBaseline(input: CaptureAttemptBaselineInput): TrackingBaselineManifest;
  loadBaseline(baselineId: string): TrackingBaselineLoadResult;
  scanCurrent(): TrackingCurrentSnapshot;
  readBlob(hash: string): Buffer;
}
