/**
 * PLT-003 keeps every API view model in `@pss/contracts`. The barrel that re-exports
 * this module (`packages/contracts/src/api/index.ts`) is owned by the contracts owner and
 * does not export the experience view model yet, so the BFF reads the schema module
 * directly instead of duplicating it (PLT-002.NC01 forbids a second copy).
 *
 * Once `packages/contracts/src/api/index.ts` gains
 * `export * from './experience-approval-inbox';` this file collapses to a plain
 * `export * from '@pss/contracts';` and nothing else has to change.
 */
export * from '../../../../packages/contracts/src/api/experience-approval-inbox';
