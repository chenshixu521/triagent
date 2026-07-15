import { describe, expect, it } from 'vitest';

import { sha256 } from '../../../src/tracking/hash.js';
import {
  buildWorkspaceCandidateChangeSet,
  changeSetToUnifiedPatch,
  hashWorkspaceCandidateChangeSet,
} from '../../../src/workspace/workspace-change-set.js';

function file(
  path: string,
  content: string,
): {
  readonly path: string;
  readonly type: 'file';
  readonly size: number;
  readonly hash: string;
  readonly blobHash: string;
  readonly binary: false;
  readonly content: Buffer;
} {
  const buffer = Buffer.from(content, 'utf8');
  const hash = sha256(buffer);
  return {
    path,
    type: 'file',
    size: buffer.length,
    hash,
    blobHash: hash,
    binary: false,
    content: buffer,
  };
}

describe('WorkspaceCandidateChangeSet', () => {
  it('builds sorted add/modify/delete entries with stable hash and normalized diff', () => {
    const source = [
      file('keep.txt', 'same\n'),
      file('edit.txt', 'before\n'),
      file('gone.txt', 'delete-me\n'),
    ];
    const candidate = [
      file('keep.txt', 'same\n'),
      file('edit.txt', 'after\n'),
      file('new.txt', 'added\n'),
    ];
    const first = buildWorkspaceCandidateChangeSet({
      taskId: 'task-1',
      attemptId: 'attempt-1',
      workspaceId: 'workspace-1',
      sourceBaselineId: 'baseline-1',
      sourceManifestHash: 'a'.repeat(64),
      candidateManifestHash: 'b'.repeat(64),
      sourceFiles: source,
      candidateFiles: candidate,
    });

    expect(first.schema).toBe('triagent.workspace_change_set.v1');
    expect(first.entries.map((entry) => entry.path)).toEqual([
      'edit.txt',
      'gone.txt',
      'new.txt',
    ]);
    expect(first.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'modify', path: 'edit.txt' }),
        expect.objectContaining({ kind: 'delete', path: 'gone.txt' }),
        expect.objectContaining({ kind: 'add', path: 'new.txt' }),
      ]),
    );
    expect(first.unifiedDiff).toContain('diff --git a/edit.txt b/edit.txt');
    expect(first.unifiedDiff).toContain('+after');
    expect(first.unifiedDiff).not.toMatch(/[A-Za-z]:\\/);
    expect(first.changeSetHash).toBe(hashWorkspaceCandidateChangeSet(first));
    expect(changeSetToUnifiedPatch(first)).toBe(first.unifiedDiff);

    const second = buildWorkspaceCandidateChangeSet({
      taskId: 'task-1',
      attemptId: 'attempt-1',
      workspaceId: 'workspace-1',
      sourceBaselineId: 'baseline-1',
      sourceManifestHash: 'a'.repeat(64),
      candidateManifestHash: 'b'.repeat(64),
      sourceFiles: [...source].reverse(),
      candidateFiles: [...candidate].reverse(),
    });
    expect(second.changeSetHash).toBe(first.changeSetHash);
    expect(second.entries).toEqual(first.entries);
  });

  it('represents renames as delete+add and rejects binary/unsafe paths', () => {
    const body = file('old-name.txt', 'rename-body\n');
    const renamed = file('new-name.txt', 'rename-body\n');
    const changeSet = buildWorkspaceCandidateChangeSet({
      taskId: 'task-1',
      attemptId: 'attempt-1',
      workspaceId: 'workspace-1',
      sourceBaselineId: 'baseline-1',
      sourceManifestHash: 'a'.repeat(64),
      candidateManifestHash: 'b'.repeat(64),
      sourceFiles: [body],
      candidateFiles: [renamed],
    });
    expect(changeSet.entries).toEqual([
      expect.objectContaining({ kind: 'add', path: 'new-name.txt' }),
      expect.objectContaining({ kind: 'delete', path: 'old-name.txt' }),
    ]);

    expect(() => buildWorkspaceCandidateChangeSet({
      taskId: 'task-1',
      attemptId: 'attempt-1',
      workspaceId: 'workspace-1',
      sourceBaselineId: 'baseline-1',
      sourceManifestHash: 'a'.repeat(64),
      candidateManifestHash: 'b'.repeat(64),
      sourceFiles: [],
      candidateFiles: [{
        path: 'payload.bin',
        type: 'file',
        size: 2,
        hash: sha256(Buffer.from([0, 1])),
        blobHash: sha256(Buffer.from([0, 1])),
        binary: true,
        content: Buffer.from([0, 1]),
      }],
    })).toThrow(/binary/i);

    expect(() => buildWorkspaceCandidateChangeSet({
      taskId: 'task-1',
      attemptId: 'attempt-1',
      workspaceId: 'workspace-1',
      sourceBaselineId: 'baseline-1',
      sourceManifestHash: 'a'.repeat(64),
      candidateManifestHash: 'b'.repeat(64),
      sourceFiles: [],
      candidateFiles: [file('C:/escape.txt', 'nope\n')],
    })).toThrow(/absolute|unsafe/i);

    expect(() => buildWorkspaceCandidateChangeSet({
      taskId: 'task-1',
      attemptId: 'attempt-1',
      workspaceId: 'workspace-1',
      sourceBaselineId: 'baseline-1',
      sourceManifestHash: 'a'.repeat(64),
      candidateManifestHash: 'b'.repeat(64),
      sourceFiles: [file('Readme.txt', 'a\n')],
      candidateFiles: [file('readme.txt', 'b\n')],
    })).toThrow(/duplicate|case-colliding/i);
  });

  it('rejects protected-path mutations and hash mismatches', () => {
    expect(() => buildWorkspaceCandidateChangeSet({
      taskId: 'task-1',
      attemptId: 'attempt-1',
      workspaceId: 'workspace-1',
      sourceBaselineId: 'baseline-1',
      sourceManifestHash: 'a'.repeat(64),
      candidateManifestHash: 'b'.repeat(64),
      sourceFiles: [file('.env', 'SECRET=1\n')],
      candidateFiles: [file('.env', 'SECRET=2\n')],
      protectedPaths: ['.env'],
    })).toThrow(/protected/i);

    expect(() => buildWorkspaceCandidateChangeSet({
      taskId: 'task-1',
      attemptId: 'attempt-1',
      workspaceId: 'workspace-1',
      sourceBaselineId: 'baseline-1',
      sourceManifestHash: 'a'.repeat(64),
      candidateManifestHash: 'b'.repeat(64),
      sourceFiles: [],
      candidateFiles: [{
        path: 'bad.txt',
        type: 'file',
        size: 4,
        hash: 'f'.repeat(64),
        blobHash: 'f'.repeat(64),
        binary: false,
        content: Buffer.from('nope'),
      }],
    })).toThrow(/hash mismatch/i);
  });
});
