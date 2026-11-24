// `node --test triage/` resolves the folder through package.json "main" (one entry): this file loads every
// test file of the folder. Bundlers (wrangler / esbuild) take "module" / "browser" = ./index.ts instead.
import './triage.test.ts';
import './review-d1.test.ts';
import './review-d2.test.ts';
import './gmail.test.ts';
import './brief-claude.test.ts';
import './review-d3.test.ts';
import './spoken.test.ts';
