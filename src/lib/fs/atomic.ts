import "server-only";
import fs from "node:fs";
import { dirname, isAbsolute, join } from "node:path";

/**
 * Replace a file in one step: write a temp file beside it, set the mode, then
 * `rename` it into place. A crash mid-write leaves the original intact.
 *
 * The one subtlety this module exists to centralise: an operator may keep
 * `~/.claude/settings.json` as a SYMLINK into a dotfiles repo. `rename` would
 * replace the link with a regular file and silently detach it from that repo,
 * so a link destination is resolved first and the write lands on the target,
 * leaving the link in place. A dangling link is resolved through `readlink` so
 * the target it points at gets created rather than the link being clobbered.
 *
 * The temp file is always created in the resolved destination's directory, so
 * the final `rename` stays on one filesystem and therefore atomic.
 */

export interface AtomicWriteOptions {
  /** Mode for the new file. Defaults to the destination's current mode, else 0600. */
  mode?: number;
  /** Create the destination's directory first. Defaults to true. */
  mkdirp?: boolean;
  /** Mode for a directory this call creates. Defaults to 0700. */
  dirMode?: number;
}

export function writeFileAtomically(
  path: string,
  contents: string,
  options: AtomicWriteOptions = {},
): void {
  const target = resolveWritePath(path);
  const dir = dirname(target);
  if (options.mkdirp !== false) {
    fs.mkdirSync(dir, { recursive: true, mode: options.dirMode ?? 0o700 });
  }
  const mode = options.mode ?? modeFor(target);
  const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.writeFileSync(tmp, contents, { mode });
    fs.chmodSync(tmp, mode);
    fs.renameSync(tmp, target);
  } catch (error) {
    fs.rmSync(tmp, { force: true });
    throw error;
  }
}

/** Existing mode if the file is there, else 0600 — never the umask's choice. */
export function modeFor(path: string): number {
  try {
    return fs.statSync(path).mode & 0o777;
  } catch {
    return 0o600;
  }
}

/**
 * The file to actually write. A symlink resolves to its target; anything else
 * (missing path, real file, directory) resolves to itself, so a write to a
 * directory still fails loudly at the rename instead of being redirected.
 *
 * Exported for callers that stage a SIBLING of the destination (a `.bak-*`
 * copy): a backup must land next to the real file, not next to the link,
 * or a dotfiles setup collects stray copies in the wrong directory.
 */
export function resolveWritePath(path: string): string {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(path);
  } catch {
    return path;
  }
  if (!stat.isSymbolicLink()) return path;
  try {
    return fs.realpathSync(path);
  } catch {
    // Dangling link: the operator pointed at a file that does not exist yet.
    // Resolve the link text ourselves so the write creates their target.
    try {
      const link = fs.readlinkSync(path);
      return isAbsolute(link) ? link : join(dirname(path), link);
    } catch {
      return path;
    }
  }
}
