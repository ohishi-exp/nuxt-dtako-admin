-- Integration test seed data
-- Runs AFTER migrations

SET search_path TO alc_api;

-- Test tenant
INSERT INTO tenants (id, name, slug) VALUES
  ('11111111-1111-1111-1111-111111111111', 'Test Company', 'test-company');
