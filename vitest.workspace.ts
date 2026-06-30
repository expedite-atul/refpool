import { defineWorkspace } from 'vitest/config';

// Each package owns its own vitest config; unit tests run without a DB.
// Adapter integration tests (testcontainers) are opt-in via INTEGRATION=1.
export default defineWorkspace(['packages/*']);
