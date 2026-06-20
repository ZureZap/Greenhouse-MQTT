/**
 * db.js
 * Tạo và tái sử dụng connection pool tới SQL Server.
 */

const sql = require("mssql");
const path = require("path");

require("dotenv").config({ path: path.join(__dirname, ".env") });

const config = {
  server: process.env.DB_HOST || "localhost",
  database: process.env.DB_DATABASE || "SmartFarmDB",
  user: process.env.DB_USER || "sa",
  password: process.env.DB_PASSWORD || "123456",
  port: parseInt(process.env.DB_PORT) || 1433,
  options: {
    encrypt: false,
    trustServerCertificate: true,
    enableArithAbort: true
  }
};

let pool = null;

async function getConnection() {
  if (pool) return pool;
  try {
    pool = await sql.connect(config);
    console.log("✅ Kết nối SQL Server thành công!");
    return pool;
  } catch (err) {
    console.error("❌ Lỗi kết nối database:", err.message);
    throw err;
  }
}

module.exports = { getConnection, sql };
