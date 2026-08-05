#!/usr/bin/env node
// One command per release, because doing it by hand is how a version once
// shipped to npm with no changelog entry and no tag behind it.
//
//   pnpm release 2.7.8        explicit version
//   pnpm release patch        bump from the current one
//
// The order matters: everything that can refuse to release runs before
// anything irreversible (tag, push, publish) happens.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const run = (cmd, args, options = {}) =>
    execFileSync(cmd, args, { cwd: root, encoding: 'utf-8', stdio: 'pipe', ...options }).trim();
const runLoud = (cmd, args) => execFileSync(cmd, args, { cwd: root, stdio: 'inherit' });

function fail(message) {
    console.error(`\nRelease stopped: ${message}\n`);
    process.exit(1);
}

const pkgPath = join(root, 'package.json');
const pkgRaw = readFileSync(pkgPath, 'utf-8');
const pkg = JSON.parse(pkgRaw);

const requested = process.argv[2];
if (!requested) {
    fail('give a version (2.7.8) or a bump (patch, minor, major).');
}

const next = (() => {
    const [major, minor, patch] = pkg.version.split('.').map(Number);
    if (requested === 'major') return `${major + 1}.0.0`;
    if (requested === 'minor') return `${major}.${minor + 1}.0`;
    if (requested === 'patch') return `${major}.${minor}.${patch + 1}`;
    if (!/^\d+\.\d+\.\d+$/.test(requested)) fail(`"${requested}" is not a version or a bump.`);
    return requested;
})();

// --- refuse early, while nothing has happened yet ---

if (run('git', ['status', '--porcelain'])) {
    fail('the working tree has uncommitted changes. Commit them first.');
}
const branch = run('git', ['rev-parse', '--abbrev-ref', 'HEAD']);
if (branch !== 'main') {
    fail(`on branch ${branch}, not main.`);
}
if (run('git', ['tag', '--list', `v${next}`])) {
    fail(`tag v${next} already exists.`);
}

// The check that would have caught a real mistake: a version published with
// nothing written about it.
const changelog = readFileSync(join(root, 'CHANGELOG.md'), 'utf-8');
// Escape the dots in the version (2.8.0 -> 2\.8\.0) so they match literally,
// and end the section at the next "## " heading or the end of the file. The old
// pattern escaped a backslash-then-any-char that never occurs in a version, so
// the dots stayed wildcards, and it terminated on \Z, which JS regex does not
// support (it matched a literal "Z"), so the final CHANGELOG entry never matched.
const section = changelog.match(
    new RegExp(`^## ${next.replace(/\./g, '\\.')}[^\\n]*\\n([\\s\\S]*?)(?=^## |(?![\\s\\S]))`, 'm'),
);
if (!section) {
    fail(`CHANGELOG.md has no "## ${next}" section. Write what changed before releasing it.`);
}
const notes = section[1].trim();
if (notes.length < 20) {
    fail(`the CHANGELOG entry for ${next} is empty. Say what changed.`);
}

console.log(`Releasing ${pkg.name} ${pkg.version} -> ${next}\n`);
runLoud('pnpm', ['typecheck']);
runLoud('pnpm', ['test']);
runLoud('pnpm', ['build']);

// --- from here on it is real ---

writeFileSync(pkgPath, pkgRaw.replace(`"version": "${pkg.version}"`, `"version": "${next}"`));
run('git', ['commit', '-am', `chore(release): v${next}`]);
run('git', ['tag', '-a', `v${next}`, '-m', `v${next}`]);
run('git', ['push', '--follow-tags']);
runLoud('pnpm', ['publish', '--access', 'public', '--no-git-checks']);

try {
    run('gh', ['release', 'create', `v${next}`, '--title', `v${next}`, '--notes', notes]);
    console.log(`\nGitHub release created: v${next}`);
} catch (error) {
    console.warn(`\nPublished, but the GitHub release failed: ${error.message}`);
    console.warn(`Create it by hand: gh release create v${next} --notes-file <(...)`);
}

console.log(`\n${pkg.name} v${next} is out.`);
