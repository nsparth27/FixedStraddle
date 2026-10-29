const fs = require('fs');
const path = require('path');
const git = require('isomorphic-git');
const http = require('isomorphic-git/http/node');

const dir = __dirname;
const tokenFile = path.join(dir, '.github-token');

// Debounce timer
let debounceTimer = null;
let isPushing = false;
let pendingChanges = false;

const IGNORED_PATHS = [
  '.git',
  'node_modules',
  '.env',
  '.github-token',
  'market-state.json',
  'reports',
  '.system_generated'
];

function shouldIgnore(filename) {
  if (!filename) return true;
  const normalized = filename.replace(/\\/g, '/');
  for (const ign of IGNORED_PATHS) {
    if (normalized === ign || normalized.startsWith(ign + '/')) {
      return true;
    }
  }
  // Ignore temporary files or lock files
  if (normalized.endsWith('.tmp') || normalized.endsWith('~') || normalized.endsWith('.swp')) {
    return true;
  }
  return false;
}

function getToken() {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN.trim();
  if (fs.existsSync(tokenFile)) {
    return fs.readFileSync(tokenFile, 'utf8').trim();
  }
  return null;
}

async function doPush() {
  if (isPushing) {
    pendingChanges = true;
    return;
  }
  isPushing = true;
  pendingChanges = false;

  try {
    const token = getToken();
    if (!token) {
      console.log(`[${new Date().toLocaleTimeString('en-IN')}] [!] No GitHub token found in .github-token. Auto-push skipped.`);
      isPushing = false;
      return;
    }

    // Check status
    const matrix = await git.statusMatrix({ fs, dir });
    let changes = 0;
    for (const [filepath, head, workdir, stage] of matrix) {
      if (workdir !== 0 && (head !== workdir || stage !== workdir)) {
        await git.add({ fs, dir, filepath });
        changes++;
      }
    }

    if (changes === 0) {
      isPushing = false;
      return;
    }

    const timeStr = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
    const sha = await git.commit({
      fs,
      dir,
      author: { name: 'Parth Shah', email: 'parth@fixedstraddle.local' },
      message: `Auto-sync: ${timeStr}`
    });

    console.log(`\n[${timeStr}] Detected ${changes} file change(s). Pushing to GitHub (commit: ${sha.slice(0, 7)})...`);

    await git.push({
      fs,
      http,
      dir,
      remote: 'origin',
      ref: 'main',
      force: true,
      onAuth: () => ({ username: token }),
    });

    console.log(`[${timeStr}] [✔] Successfully synced to GitHub! Render is deploying changes.`);
  } catch (err) {
    console.error(`[${new Date().toLocaleTimeString('en-IN')}] [ERROR] Auto-push failed:`, err.message);
  } finally {
    isPushing = false;
    if (pendingChanges) {
      pendingChanges = false;
      schedulePush(2000);
    }
  }
}

function schedulePush(delay = 5000) {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    doPush();
  }, delay);
}

console.log('========================================================');
console.log('  Fixed Straddle - GitHub Auto-Sync Watcher');
console.log('  Target: https://github.com/nsparth27/FixedStraddle');
console.log('  Watching for file saves in:', dir);
console.log('========================================================\n');
console.log('Auto-sync is ACTIVE. Whenever you save any file, it will');
console.log('automatically be committed and pushed to GitHub within 5 seconds.\n');

try {
  fs.watch(dir, { recursive: true }, (eventType, filename) => {
    if (!shouldIgnore(filename)) {
      console.log(`[${new Date().toLocaleTimeString('en-IN')}] File changed: ${filename}`);
      schedulePush(5000);
    }
  });
} catch (e) {
  console.error('Watch error:', e);
}
