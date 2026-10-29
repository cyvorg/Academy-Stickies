-- Self-reported, city-level member locations for the academy map. No precise
-- GPS is ever stored: coordinates come from the bundled city dataset. The
-- location_source stamp separates member-confirmed pins from the admin-set
-- initial cohort, and location_hidden is the member's opt-out from the map.
ALTER TABLE profiles ADD COLUMN city TEXT;
ALTER TABLE profiles ADD COLUMN country TEXT;
ALTER TABLE profiles ADD COLUMN lat REAL;
ALTER TABLE profiles ADD COLUMN lon REAL;
ALTER TABLE profiles ADD COLUMN city_id INTEGER;
ALTER TABLE profiles ADD COLUMN location_updated_at INTEGER;
ALTER TABLE profiles ADD COLUMN location_source TEXT;
ALTER TABLE profiles ADD COLUMN location_hidden INTEGER NOT NULL DEFAULT 0;
