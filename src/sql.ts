// Tagged-template helper for safe parameterised queries.
//
//   import { sql } from '@perryts/mysql';
//
//   const id = 42;
//   const name = "O'Malley";
//   const rows = await conn.query(sql`
//     SELECT * FROM users WHERE id = ${id} AND name = ${name}
//   `);
//
// Composable: a SqlQuery can be interpolated into another template.
// Nested fragments' `?` placeholders are simply inlined — unlike
// Postgres's `$N` scheme, MySQL's `?` is positional by occurrence, so
// no renumbering is needed.
//
//   const where = onlyActive ? sql`WHERE active = 1` : sql``;
//   await conn.query(sql`SELECT * FROM users ${where}`);

export interface SqlQuery {
    /** SQL text with `?` placeholders (MySQL-style). */
    readonly text: string;
    /** Parameters, one per placeholder in document order. */
    readonly params: unknown[];
    /** Sentinel for `isSqlQuery`. */
    readonly __perry_mysql_sql: true;
}

export function isSqlQuery(value: unknown): value is SqlQuery {
    return (
        typeof value === 'object'
        && value !== null
        && (value as { __perry_mysql_sql?: boolean }).__perry_mysql_sql === true
    );
}

/**
 * Build a SqlQuery from a tagged template. Every `${expr}` becomes a
 * `?` placeholder (and a corresponding entry in `params`). Adjacent
 * SqlQuery fragments are inlined verbatim — placeholder order is
 * preserved by concatenation.
 */
export function sql(strings: TemplateStringsArray, ...values: unknown[]): SqlQuery {
    const parts: string[] = [];
    const params: unknown[] = [];

    for (let i = 0; i < strings.length; i++) {
        parts.push(strings[i]);
        if (i >= values.length) {
            continue;
        }
        const v = values[i];
        if (isSqlQuery(v)) {
            parts.push(v.text);
            for (let j = 0; j < v.params.length; j++) {
                params.push(v.params[j]);
            }
        } else {
            parts.push('?');
            params.push(v);
        }
    }

    return { text: parts.join(''), params: params, __perry_mysql_sql: true };
}

/**
 * Escape hatch for unparameterised fragments (identifiers, SQL keywords).
 * Callers are responsible for escaping user input themselves — MySQL
 * doesn't provide any syntax to parameterise identifiers.
 *
 *   const col = 'created_at';
 *   await conn.query(sql`SELECT * FROM users ORDER BY ${raw(col)} DESC`);
 */
export function raw(text: string): SqlQuery {
    return { text: text, params: [], __perry_mysql_sql: true };
}
