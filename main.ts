// main.ts — Breakwater's hand-in program (Node 22, standard library only).
//
// It copies this repository's game/ and screenshots/ into the grader's
// output directory and writes /output/dossier.json with the kit's vendored
// make.fun library, exactly as the kit's starter does. Run it locally with
// MAKEFUN_OUTPUT_DIR set to a scratch directory:
//   mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts
// The dossier must be byte-identical across runs: the library builds it
// deterministically from the same files, so run it twice and compare.

import { cpSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDossier } from './vendor/makefun-threejs.ts';

const here = fileURLToPath(new URL('.', import.meta.url));
const out = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

mkdirSync(out, { recursive: true });
cpSync(join(here, 'game'), join(out, 'game'), { recursive: true });
mkdirSync(join(out, 'screenshots'), { recursive: true });
if (existsSync(join(here, 'screenshots'))) {
  cpSync(join(here, 'screenshots'), join(out, 'screenshots'), { recursive: true });
}

// The same caps the gate enforces: 160 KiB of dossier text, at most four
// screenshots of 256 KiB, game/ under 993 files and 48 MiB.
writeFileSync(
  join(out, 'dossier.json'),
  buildDossier(out, {
    text_max_bytes: 163840,
    screenshots: { max: 4, max_bytes: 262144 },
    game_max_files: 993,
    game_max_bytes: 50331648,
  }),
);
