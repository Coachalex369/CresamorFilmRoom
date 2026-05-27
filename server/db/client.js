const pg = require("pg");
require("dotenv").config();

const connectionString = process.env.DATABASE_URL;

const db = new pg.Pool({
  connectionString,
  ssl:
    process.env.NODE_ENV === "production"
      ? { rejectUnauthorized: false }
      : false,
});

module.exports = db;