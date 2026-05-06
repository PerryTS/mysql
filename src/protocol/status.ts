// SERVER_STATUS_* flags (u16, reported in OK / EOF packets).
//
// Reference: https://dev.mysql.com/doc/dev/mysql-server/latest/group__group__cs__status__flags.html

export const SERVER_STATUS_IN_TRANS             = 0x0001;
export const SERVER_STATUS_AUTOCOMMIT           = 0x0002;
export const SERVER_MORE_RESULTS_EXISTS         = 0x0008;
export const SERVER_QUERY_NO_GOOD_INDEX_USED    = 0x0010;
export const SERVER_QUERY_NO_INDEX_USED         = 0x0020;
export const SERVER_STATUS_CURSOR_EXISTS        = 0x0040;
export const SERVER_STATUS_LAST_ROW_SENT        = 0x0080;
export const SERVER_STATUS_DB_DROPPED           = 0x0100;
export const SERVER_STATUS_NO_BACKSLASH_ESCAPES = 0x0200;
export const SERVER_STATUS_METADATA_CHANGED     = 0x0400;
export const SERVER_QUERY_WAS_SLOW              = 0x0800;
export const SERVER_PS_OUT_PARAMS               = 0x1000;
export const SERVER_STATUS_IN_TRANS_READONLY    = 0x2000;
export const SERVER_SESSION_STATE_CHANGED       = 0x4000;

export type TxnStatus = 'idle' | 'in-transaction' | 'in-transaction-readonly';

/** Derive a high-level transaction-state label from a status bitmap. */
export function deriveTxnStatus(status: number): TxnStatus {
    if ((status & SERVER_STATUS_IN_TRANS_READONLY) !== 0) {
        return 'in-transaction-readonly';
    }
    if ((status & SERVER_STATUS_IN_TRANS) !== 0) {
        return 'in-transaction';
    }
    return 'idle';
}

/** Convenience check: is the server telling us there's another resultset after this one? */
export function hasMoreResults(status: number): boolean {
    return (status & SERVER_MORE_RESULTS_EXISTS) !== 0;
}
