INSERT INTO `__schema_version` (`id`, `version`, `updated_at_ms`, `updated_by`)
VALUES (1, 10, unixepoch() * 1000, '0005_sync_schema_version')
ON CONFLICT(`id`) DO UPDATE SET
  `version` = 10,
  `updated_at_ms` = unixepoch() * 1000,
  `updated_by` = '0005_sync_schema_version';
