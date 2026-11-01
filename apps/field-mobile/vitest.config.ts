import { defineConfig } from 'vitest/config';

// Vitest blanks CSS imports by default; the token test reads the Ledger token file as text.
export default defineConfig({ test: { css: { include: [/ledger-tokens\.css/] } } });
