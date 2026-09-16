CREATE EXTENSION IF NOT EXISTS postgis;

CREATE TABLE IF NOT EXISTS districts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  state text NOT NULL,
  risk_level text DEFAULT 'LOW',
  geometry geometry(Polygon, 4326),
  created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firebase_uid text UNIQUE NOT NULL,
  name text NOT NULL,
  email text UNIQUE NOT NULL,
  role text NOT NULL CHECK (role IN ('citizen', 'field_officer', 'logistics_operator', 'district_officer', 'emergency_officer', 'admin')),
  district_id uuid REFERENCES districts(id),
  phone text,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS vehicles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vehicle_number text UNIQUE NOT NULL,
  type text NOT NULL,
  operator_id uuid REFERENCES users(id),
  driver_name text NOT NULL,
  status text NOT NULL DEFAULT 'available',
  current_location geometry(Point, 4326),
  destination geometry(Point, 4326),
  created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS vehicle_locations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vehicle_id uuid REFERENCES vehicles(id) ON DELETE CASCADE,
  location geometry(Point, 4326) NOT NULL,
  speed numeric,
  heading numeric,
  timestamp timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS roads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  osm_id text,
  name text,
  road_type text,
  status text NOT NULL DEFAULT 'OPEN',
  geometry geometry(LineString, 4326),
  risk_score integer DEFAULT 0 CHECK (risk_score >= 0 AND risk_score <= 100),
  last_updated timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS incidents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type text NOT NULL,
  severity text NOT NULL,
  description text,
  location geometry(Point, 4326) NOT NULL,
  photo_url text,
  reported_by uuid REFERENCES users(id),
  status text NOT NULL DEFAULT 'REPORTED',
  verified_by uuid REFERENCES users(id),
  created_at timestamptz DEFAULT now(),
  resolved_at timestamptz
);

CREATE TABLE IF NOT EXISTS weather_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  location geometry(Point, 4326) NOT NULL,
  temperature numeric,
  humidity numeric,
  rainfall numeric,
  wind_speed numeric,
  precipitation_probability numeric,
  weather_code integer,
  timestamp timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS flood_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  location geometry(Point, 4326) NOT NULL,
  river_discharge numeric,
  risk_level text,
  timestamp timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS satellite_observations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source text NOT NULL,
  satellite text NOT NULL,
  location geometry(Point, 4326),
  acquisition_time timestamptz,
  cloud_cover numeric,
  analysis_type text,
  risk_score integer CHECK (risk_score >= 0 AND risk_score <= 100),
  image_url text,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS routes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vehicle_id uuid REFERENCES vehicles(id),
  origin geometry(Point, 4326) NOT NULL,
  destination geometry(Point, 4326) NOT NULL,
  geometry geometry(LineString, 4326),
  distance numeric,
  duration numeric,
  risk_score integer CHECK (risk_score >= 0 AND risk_score <= 100),
  recommended boolean DEFAULT false,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS alerts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type text NOT NULL,
  title text NOT NULL,
  message text NOT NULL,
  severity text NOT NULL,
  location geometry(Point, 4326),
  target_role text,
  target_district uuid REFERENCES districts(id),
  created_at timestamptz DEFAULT now(),
  expires_at timestamptz
);

CREATE TABLE IF NOT EXISTS field_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES users(id),
  type text NOT NULL,
  description text,
  location geometry(Point, 4326) NOT NULL,
  photo_url text,
  severity text NOT NULL,
  offline_created boolean DEFAULT false,
  synced_at timestamptz,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_vehicle_locations_location ON vehicle_locations USING gist (location);
CREATE INDEX IF NOT EXISTS idx_roads_geometry ON roads USING gist (geometry);
CREATE INDEX IF NOT EXISTS idx_incidents_location ON incidents USING gist (location);
CREATE INDEX IF NOT EXISTS idx_routes_geometry ON routes USING gist (geometry);
