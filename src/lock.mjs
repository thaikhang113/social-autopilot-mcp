// One process per data directory. A PID lock file prevents two servers from
// loading the same state and overwriting each other's decisions.
import fs from 'node:fs';
import path from 'node:path';

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

export function acquireLock(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, '.lock');

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = fs.openSync(file, 'wx');
      try {
        fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
      } finally {
        fs.closeSync(fd);
      }
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        try {
          const owner = JSON.parse(fs.readFileSync(file, 'utf8'));
          if (owner.pid === process.pid) fs.unlinkSync(file);
        } catch {}
      };
      process.on('exit', release);
      return release;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      let owner = null;
      try {
        owner = JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch {}
      if (owner?.pid && alive(owner.pid)) {
        const locked = new Error(
          `another social-autopilot instance is already running (pid ${owner.pid}, lock ${file})`
        );
        locked.code = 'ELOCKED';
        throw locked;
      }
      try {
        fs.unlinkSync(file);
      } catch {}
    }
  }
  const err = new Error(`could not acquire data lock: ${file}`);
  err.code = 'ELOCKED';
  throw err;
}
