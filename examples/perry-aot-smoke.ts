// Perry AOT smoke: connect to real MySQL, run a text + prepared query,
// close cleanly.

import { connect } from '../src';

const conn = await connect({
    host: '127.0.0.1',
    port: 3306,
    user: 'root',
    password: '',
    database: '',
    allowPublicKeyRetrieval: true,
});
console.log('connection_id=' + conn.connection_id + ' server=' + conn.serverVersion);

const r = await conn.query('SELECT 1 AS one, \'perry-aot\' AS source');
console.log('text query rows=' + JSON.stringify(r.rows));

const r2 = await conn.query('SELECT ? + ? AS sum', [40, 2]);
console.log('prepared query rows=' + JSON.stringify(r2.rows));

await conn.close();
console.log('closed cleanly');
