DROP TABLE IF EXISTS snapshots;
DROP TABLE IF EXISTS clips;
DROP TABLE IF EXISTS videos;
DROP TABLE IF EXISTS users;

CREATE TABLE users (
  id SERIAL PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('coach', 'athlete')),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE videos (
  id SERIAL PRIMARY KEY,
  title TEXT NOT NULL,
  file_url TEXT NOT NULL,
  uploaded_by INTEGER REFERENCES users(id)
);

CREATE TABLE clips (
  id SERIAL PRIMARY KEY,
  title TEXT NOT NULL,
  start_time NUMERIC,
  end_time NUMERIC,
  video_id INTEGER REFERENCES videos(id),
  user_id INTEGER REFERENCES users(id)
);

CREATE TABLE snapshots (
  id SERIAL PRIMARY KEY,
  timestamp NUMERIC,
  video_id INTEGER REFERENCES videos(id),
  user_id INTEGER REFERENCES users(id)
);