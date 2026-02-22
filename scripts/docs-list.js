/**
 * docs-list: Scan the docs/ directory, extract summary and read_when
 * from front-matter, and output a formatted documentation index.
 *
 * Usage: pnpm docs:list
 * Reference: https://github.com/steipete/agent-scripts
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const DOCS_DIR = join(process.cwd(), 'docs');
const SKIP_DIRS = new Set(['bugs', 'archive', 'research']);

function extractFrontMatter(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return { summary: '', readWhen: [] };

  const fm = match[1];

  // Extract summary
  const summaryMatch = fm.match(/^summary:\s*['"]?(.*?)['"]?\s*$/m);
  const summary = summaryMatch ? summaryMatch[1].trim() : '';

  // Extract read_when (YAML list or inline array)
  const readWhen = [];
  const rwBlock = fm.match(/read_when:\s*\n((?:\s+-\s+.*\n?)*)/);
  if (rwBlock) {
    const items = rwBlock[1].matchAll(/^\s+-\s+(.+)$/gm);
    for (const item of items) {
      readWhen.push(item[1].trim());
    }
  } else {
    const rwInline = fm.match(/read_when:\s*\[([^\]]*)\]/);
    if (rwInline) {
      readWhen.push(
        ...rwInline[1]
          .split(',')
          .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
          .filter(Boolean)
      );
    }
  }

  return { summary, readWhen };
}

function walkDocs(dir) {
  const results = [];

  for (const entry of readdirSync(dir)) {
    if (entry.startsWith('.')) continue;

    const fullPath = join(dir, entry);
    const stat = statSync(fullPath);

    if (stat.isDirectory()) {
      if (SKIP_DIRS.has(entry)) continue;
      results.push(...walkDocs(fullPath));
    } else if (entry.endsWith('.md')) {
      const content = readFileSync(fullPath, 'utf-8');
      const { summary, readWhen } = extractFrontMatter(content);
      if (summary) {
        results.push({
          path: relative(process.cwd(), fullPath),
          summary,
          readWhen
        });
      }
    }
  }

  return results.sort((a, b) => a.path.localeCompare(b.path));
}

// Main
const docs = walkDocs(DOCS_DIR);

if (docs.length === 0) {
  console.log('No docs with front-matter found in docs/');
  process.exit(0);
}

for (const doc of docs) {
  console.log(`${doc.path} - ${doc.summary}`);
  if (doc.readWhen.length > 0) {
    console.log(`  Read when: ${doc.readWhen.join('; ')}`);
  }
}

console.log(
  '\nReminder: Before coding, check the "Read when" hints above and read relevant docs as needed.'
);
