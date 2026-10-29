const git = require('isomorphic-git');
const http = require('isomorphic-git/http/node');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const dir = __dirname;

async function promptToken() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question('Paste your GitHub Personal Access Token: ', token => {
      rl.close();
      resolve(token.trim());
    });
  });
}

async function main() {
  console.log('========================================================');
  console.log('   Pushing Fixed Straddle Project to GitHub...');
  console.log('   Repository: https://github.com/nsparth27/FixedStraddle');
  console.log('========================================================\n');

  // Stage any recent changes
  const matrix = await git.statusMatrix({ fs, dir });
  let changes = 0;
  for (const [filepath, head, workdir, stage] of matrix) {
    if (workdir !== 0 && (head !== workdir || stage !== workdir)) {
      await git.add({ fs, dir, filepath });
      changes++;
    }
  }

  if (changes > 0) {
    const sha = await git.commit({
      fs,
      dir,
      author: { name: 'Parth Shah', email: 'parth@fixedstraddle.local' },
      message: `Update: ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}`
    });
    console.log(`[✔] Committed ${changes} updated file(s) (SHA: ${sha.slice(0, 7)})`);
  } else {
    console.log('[✔] All local files are already committed.');
  }

  // Check for saved token in .github-token or prompt
  const tokenFile = path.join(dir, '.github-token');
  let token = process.env.GITHUB_TOKEN || '';
  if (!token && fs.existsSync(tokenFile)) {
    token = fs.readFileSync(tokenFile, 'utf8').trim();
  }

  if (!token) {
    console.log('\n[!] To push to GitHub, enter your GitHub Personal Access Token.');
    console.log('    (Create one at: https://github.com/settings/tokens with "repo" access)\n');
    token = await promptToken();
    if (!token) {
      console.log('Push cancelled: No token provided.');
      return;
    }
    // Save token locally for convenience so they don't have to re-enter it every time
    fs.writeFileSync(tokenFile, token, { mode: 0o600 });
    console.log('[✔] Token saved locally for future 1-click pushes.\n');
  }

  console.log('Pushing branch "main" to GitHub...');
  try {
    const pushResult = await git.push({
      fs,
      http,
      dir,
      remote: 'origin',
      ref: 'main',
      force: true,
      onAuth: () => ({ username: token }),
    });

    console.log('\n========================================================');
    console.log('  SUCCESS! Your project is now live on GitHub:');
    console.log('  https://github.com/nsparth27/FixedStraddle');
    console.log('========================================================');
  } catch (err) {
    console.error('\n[ERROR] Push failed:', err.message);
    if (err.message.includes('401') || err.message.includes('403') || err.message.includes('authentication')) {
      console.log('Authentication error. Delete the .github-token file and try again with a valid token.');
      if (fs.existsSync(tokenFile)) fs.unlinkSync(tokenFile);
    }
  }
}

main().catch(err => console.error('Fatal error:', err));
