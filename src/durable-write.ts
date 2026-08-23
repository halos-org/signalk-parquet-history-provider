import { closeSync, fsyncSync, openSync, renameSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Making a file appear, completely or not at all.
 *
 * Nothing here imports a storage engine, so both the extension resolver and
 * the roll can use it. It is one primitive with one subtlety — a rename is
 * atomic against a concurrent reader and says nothing about what reached the
 * disk — and two copies of that subtlety is one too many.
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
  } catch {
    // See above: a platform that refuses this is one where there is nothing
    // to do about it.
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
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temp, final);
  syncDirectory(dirname(final));
}
