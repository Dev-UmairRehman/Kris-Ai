'use strict';

/* ---------------------------------------------------------------------------
   Deploy this app (Kris AI Memory + MasterPlan Digital) to DigitalOcean.

     npm run deploy

   The GitHub repository is private, and App Platform's plain git source can
   only clone public repositories. So the app runs from an image in our own
   private registry instead, and this script builds that image here - no
   Docker needed:

     1. export the committed code (git archive HEAD - uncommitted edits are
        never shipped) and install production dependencies into it
     2. lay it on node:22-alpine with crane and push it to
        registry.digitalocean.com/strategytraining-apps/kris-ai:<commit>
     3. point the app at that tag (doctl) and wait until it is live

   Needs: doctl signed in, and crane (https://github.com/google/go-containerregistry)
   on PATH or at .tools/crane(.exe). Secrets stay in the app's settings on
   DigitalOcean; nothing secret goes into the image.
   --------------------------------------------------------------------------- */

const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const APP_ID = process.env.DO_APP_ID || 'a3d58e5a-e8ce-450b-ad6d-cd5cccc13081';
const REGISTRY = process.env.DO_REGISTRY || 'strategytraining-apps';
const REPO = 'kris-ai';
const BASE = 'node:22-alpine';
const isWin = process.platform === 'win32';
/* On Windows use the built-in bsdtar: the GNU tar that Git ships reads C: as
   a remote host. */
const TAR = isWin ? path.join(process.env.SystemRoot || 'C:\Windows', 'System32', 'tar.exe') : 'tar';

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: opts.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit', encoding: 'utf8', shell: false, ...opts });
  if (r.status !== 0) {
    /* allowFail: a non-zero exit means 'nothing' (e.g. no cleanup running). */
    if (opts.allowFail) return '';
    throw new Error(cmd + ' ' + args.join(' ') + ' failed' + (r.stderr ? ':\n' + r.stderr : ''));
  }
  return (r.stdout || '').trim();
}

function crane() {
  const local = path.join(ROOT, '.tools', isWin ? 'crane.exe' : 'crane');
  return fs.existsSync(local) ? local : 'crane';
}

function step(msg) {
  console.log('\n> ' + msg);
}

/* Each deploy keeps a few recent tags to roll back to, and drops the rest:
   the free registry tier holds about 500 MB. */
const KEEP_TAGS = 3;
const GC_ABOVE_BYTES = 350 * 1e6; // the free registry holds 524 MB

async function main() {
  const dirty = run('git', ['status', '--porcelain'], { cwd: ROOT, capture: true });
  if (dirty) console.warn('Note: uncommitted changes are NOT deployed. Only the last commit is.');
  const sha = run('git', ['rev-parse', '--short=12', 'HEAD'], { cwd: ROOT, capture: true });
  const ref = 'registry.digitalocean.com/' + REGISTRY + '/' + REPO + ':' + sha;

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'kris-deploy-'));
  const app = path.join(work, 'app');
  fs.mkdirSync(app);

  step('Exporting commit ' + sha);
  const archive = path.join(work, 'src.tar');
  run('git', ['archive', '--format=tar', '-o', archive, 'HEAD'], { cwd: ROOT });
  run(TAR, ['-xf', archive, '-C', app]);

  step('Installing production dependencies');
  run(isWin ? 'npm.cmd' : 'npm', ['ci', '--omit=dev', '--omit=optional', '--no-audit', '--no-fund', '--ignore-scripts'], {
    cwd: app,
    shell: isWin,
  });
  /* The test suites and their fixtures are not needed at runtime. */
  fs.rmSync(path.join(app, 'masterplan', 'test'), { recursive: true, force: true });

  step('Packing the layer');
  const layer = path.join(work, 'layer.tar');
  run(TAR, ['-cf', layer, '-C', work, 'app']);
  console.log('  layer: ' + Math.round(fs.statSync(layer).size / 1024 / 1024) + ' MB (uncompressed)');

  /* A registry cleanup makes the registry read-only until it ends, and a
     push then fails with 401. Wait it out instead. */
  const gcStarted = Date.now();
  while (run('doctl', ['registry', 'garbage-collection', 'get-active', '--no-header'], { capture: true, allowFail: true }).trim()) {
    if (Date.now() - gcStarted > 45 * 60 * 1000) throw new Error('a registry cleanup is still running after 45 minutes');
    if (Date.now() - gcStarted < 1000) console.log('  a registry cleanup is running; waiting for it to finish');
    await new Promise((r) => setTimeout(r, 30000));
  }

  step('Pushing ' + ref);
  const dockerCfg = path.join(work, 'docker');
  fs.mkdirSync(dockerCfg);
  /* Short-lived: a cleanup waits for every write login to expire. */
  fs.writeFileSync(path.join(dockerCfg, 'config.json'), run('doctl', ['registry', 'docker-config', '--read-write', '--expiry-seconds', '600'], { capture: true }));
  const env = { ...process.env, DOCKER_CONFIG: dockerCfg };
  run(crane(), ['append', '--platform', 'linux/amd64', '-b', BASE, '-f', layer, '-t', ref], { env });
  run(crane(), ['mutate', ref, '--workdir', '/app', '--entrypoint', 'node,server.js', '--env', 'NODE_ENV=production', '-t', ref], { env });

  step('Pointing the app at the new image');
  const specFile = path.join(work, 'spec.yaml');
  let spec = run('doctl', ['apps', 'spec', 'get', APP_ID], { capture: true });
  /* First image deploy: replace the git source with the registry image. */
  spec = spec.replace(/\n(\s+)git:\n\s+branch: .*\n\s+repo_clone_url: .*\n/, (m, indent) =>
    '\n' + indent + 'image:\n' + indent + '  registry_type: DOCR\n' + indent + '  repository: ' + REPO + '\n' + indent + '  tag: ' + sha + '\n'
  );
  spec = spec.replace(/(\n\s+image:\n(?:\s+\w+: .*\n)*?\s+tag: ).*/, '$1' + sha);
  /* Build settings belong to git sources only. environment_slug may be the
     first key of the service entry ("- environment_slug: ..."); keep the "- ". */
  spec = spec.replace(/\n(\s*)- environment_slug: .*\n\s+/, '\n$1- ');
  spec = spec.replace(/\n\s+environment_slug: .*/, '');
  spec = spec.replace(/\n\s+build_command: .*/, '');
  spec = spec.replace(/\n\s+source_dir: .*/, '');
  if (!spec.includes('tag: ' + sha)) throw new Error('could not set the image tag in the app spec');
  fs.writeFileSync(specFile, spec);
  run('doctl', ['apps', 'update', APP_ID, '--spec', specFile, '--format', 'ID', '--no-header'], { capture: true });
  fs.rmSync(work, { recursive: true, force: true });

  step('Waiting for the deployment');
  const started = Date.now();
  let last = '';
  for (;;) {
    const json = JSON.parse(run('doctl', ['apps', 'list-deployments', APP_ID, '-o', 'json'], { capture: true }));
    const d = json[0];
    if (d.phase !== last) {
      console.log('  ' + d.phase + '  (' + Math.round((Date.now() - started) / 1000) + 's)');
      last = d.phase;
    }
    if (d.phase === 'ACTIVE') break;
    if (['ERROR', 'CANCELED', 'SUPERSEDED'].includes(d.phase)) {
      throw new Error('deployment ' + d.id + ' ended ' + d.phase + '. See: doctl apps logs ' + APP_ID + ' --type deploy');
    }
    if (Date.now() - started > 15 * 60 * 1000) throw new Error('deployment still not live after 15 minutes');
    await new Promise((r) => setTimeout(r, 10000));
  }

  step('Pruning old images');
  try {
    const tags = JSON.parse(run('doctl', ['registry', 'repository', 'list-tags', REPO, '-o', 'json'], { capture: true }))
      .sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1))
      .slice(KEEP_TAGS)
      .map((t) => t.tag);
    if (tags.length) {
      run('doctl', ['registry', 'repository', 'delete-tag', REPO, ...tags, '--force'], { capture: true });
      console.log('  removed ' + tags.length + ' old tag(s)');
    }
    /* Deleted tags free their space only after a cleanup, and a cleanup
       blocks pushes for a while. So clean up only when the free tier's
       500 MB is getting full, not after every deploy. */
    const reg = JSON.parse(run('doctl', ['registry', 'get', '-o', 'json'], { capture: true }));
    const used = (Array.isArray(reg) ? reg[0] : reg).storage_usage_bytes || 0;
    if (used > GC_ABOVE_BYTES) {
      run('doctl', ['registry', 'garbage-collection', 'start', '--force', '--include-untagged-manifests'], { capture: true });
      console.log('  registry at ' + Math.round(used / 1e6) + ' MB: cleanup started (the next deploy waits for it)');
    }
  } catch (err) {
    console.warn('  (pruning skipped: ' + err.message.split('\n')[0] + ')');
  }

  console.log('\nLive: ' + sha);
}

main().catch((err) => {
  console.error('\nDeploy failed: ' + err.message);
  process.exit(1);
});
