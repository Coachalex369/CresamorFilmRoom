import pg from "pg";
import "dotenv/config";

const connectionString = process.env.DATABASE_URL;

const db = new pg.Pool({
  connectionString,
  ssl:
    process.env.NODE_ENV === "production"
      ? { rejectUnauthorized: false }
      : false,
});

export default db;