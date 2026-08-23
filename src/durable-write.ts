import {
  closeSync,
  fchmodSync,
  fsyncSync,
  openSync,
  renameSync,
} from "node:fs";
import { dirname } from "node:path";

/**
 * Making a file appear, completely or not at all.
 *
 * Nothing here imports a storage engine, so both the extension resolver and
 * the roll can use it. `syncDirectory` is shared by both; `commitFile` is for
 * callers that do not already hold the write handle — the extension resolver
 * does, and fsyncs it inline while it still has it.
 */

/**
 * `fsync` a directory, so a rename into it survives a power cut.
 *
 * Not every platform allows fsync on a directory handle. The device target is
 * Linux, where it works and where it is what makes the rename durable.
 */
export function syncDirectory(directory: string): void {
  try {
    const fd = openSync(directory, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch (err) {
    // Only the platform's refusal is expected. Anything else — the directory
    // is gone, or unreadable — means the rename this was meant to make
    // durable is in doubt, and swallowing that would hide it.
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "EINVAL" && code !== "EACCES" && code !== "EPERM") throw err;
  }
}

/**
 * Publish a file written under a temporary name.
 *
 * The order is the whole point: the file's own bytes reach the disk, then the
 * rename makes it visible, then the directory entry reaches the disk. A
 * reader either sees the previous file or this one, never a partial one —
 * which is what lets the roll write into a tree something else is reading.
 */
export function commitFile(temp: string, final: string): void {
  const fd = openSync(temp, "r");
  try {
    // 0600, like the pid file and the pending-roll record. DuckDB creates its
    // output at 0666 & ~umask, which is 0644 by default — and the tree holds
    // the vessel's position history. The 0700 directory above it is the only
    // other protection, and that does not survive a copy or a filesystem
    // without modes.
    fchmodSync(fd, 0o600);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temp, final);
  syncDirectory(dirname(final));
}
