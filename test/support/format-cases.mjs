/**
 * The one shared `formatCount` table (contract v1.11: decimal only).
 *
 * `formatCount` exists on both halves — the host is Node ESM, the client is a browser bundle, so
 * neither can import the other and there is no single source of truth. This table is therefore the
 * shared contract: `test/manifest.test.mjs` checks both implementations against it (and against each
 * other), `test/client-page.test.mjs` uses the same values, and the host's own table in
 * `test/host-api.test.mjs` must stay identical. Change the rule → change every copy.
 *
 *   decimal round numbers get a short label        (1000000 → "1M", 128000 → "128K", 1000 → "1K")
 *   binary round numbers are NOT abbreviated       (1048576 → "1048576", 1024 → "1024")
 *   anything else stays verbatim                   (199999 → "199999", 500 → "500", 0 → "0")
 */
export const FORMAT_COUNT_CASES = [
  [1000000, "1M"], [128000, "128K"], [200000, "200K"], [1000, "1K"], [100000000, "100M"],
  [1048576, "1048576"], [131072, "131072"], [262144, "262144"], [32768, "32768"],
  [8192, "8192"], [4096, "4096"], [524288, "524288"], [1024, "1024"],
  [2097152, "2097152"], [199999, "199999"], [8, "8"], [500, "500"], [0, "0"],
];
