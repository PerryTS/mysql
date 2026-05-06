// MySQL / MariaDB collation IDs. Only the ones we special-case in codec
// selection live here — the full table is 600+ entries and we don't need
// it for row decoding (we inspect the column flags instead).

export const COLLATION_BINARY          = 63;
export const COLLATION_UTF8MB4_GENERAL_CI = 45;
export const COLLATION_UTF8MB4_0900_AI_CI = 255;
export const COLLATION_UTF8MB3_GENERAL_CI = 33;

/** Default client collation — utf8mb4_0900_ai_ci (MySQL 8). */
export const DEFAULT_COLLATION = COLLATION_UTF8MB4_0900_AI_CI;
