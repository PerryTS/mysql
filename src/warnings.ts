// MyWarning — GUI-facing surface for MySQL's `SHOW WARNINGS` output.
//
// The driver fires a synthetic `MyWarning { count }` entry whenever a
// query returns `warningCount > 0` AND a listener is attached via
// `conn.on('warning', ...)`. Callers who want the full list run
// `SHOW WARNINGS` themselves — doing so from inside the driver would
// require a second query-in-flight and adds complexity without clear
// benefit for the GUI path (the user typically wants to know "this
// query had warnings" and surface the full list on demand).

export interface MyWarning {
    /** `Error` | `Warning` | `Note`, or `'summary'` for synthetic counts. */
    level: string;
    /** MySQL/MariaDB error code (0 for synthetic summary entries). */
    code: number;
    /** Human-readable message, UTF-8. */
    message: string;
    /** For synthetic `level:'summary'` entries, the number of warnings. */
    count?: number;
}
