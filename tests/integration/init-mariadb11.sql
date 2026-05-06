-- MariaDB 11 test users. ed25519 requires the `client_ed25519` plugin
-- which must be loaded at server start — `server_audit` is not needed.
-- The plugin lives in MariaDB's auth_ed25519 shared library (bundled).

INSTALL SONAME 'auth_ed25519';

CREATE USER 'native_user'@'%' IDENTIFIED VIA mysql_native_password USING PASSWORD('nativepw');
GRANT ALL PRIVILEGES ON perry_test.* TO 'native_user'@'%';

CREATE USER 'ed25519_user'@'%' IDENTIFIED VIA ed25519 USING PASSWORD('ed25519pw');
GRANT ALL PRIVILEGES ON perry_test.* TO 'ed25519_user'@'%';

FLUSH PRIVILEGES;
