-- MySQL 8 test users provisioned for each auth plugin.
-- Matches the `MYSQL_USER` / `MYSQL_PASSWORD` constants in integration tests.

CREATE USER 'native_user'@'%' IDENTIFIED WITH mysql_native_password BY 'nativepw';
GRANT ALL PRIVILEGES ON perry_test.* TO 'native_user'@'%';

CREATE USER 'caching_user'@'%' IDENTIFIED WITH caching_sha2_password BY 'cachingpw';
GRANT ALL PRIVILEGES ON perry_test.* TO 'caching_user'@'%';

FLUSH PRIVILEGES;
