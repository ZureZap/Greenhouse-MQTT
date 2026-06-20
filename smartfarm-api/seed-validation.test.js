const assert = require("assert");
const fs = require("fs");
const path = require("path");
const sql = require("mssql");
require("dotenv").config({ path: path.join(__dirname, ".env") });

const TEST_DATABASE = "SmartFarmDB_SeedValidation";
const baseConfig = {
  server: process.env.DB_HOST || "localhost",
  user: process.env.DB_USER || "sa",
  password: process.env.DB_PASSWORD || "123456",
  port: Number(process.env.DB_PORT) || 1433,
  options: { encrypt: false, trustServerCertificate: true, enableArithAbort: true }
};

async function main() {
  const master = await new sql.ConnectionPool({ ...baseConfig, database: "master" }).connect();
  let databasePool;
  try {
    await master.request().query(`
      IF DB_ID('${TEST_DATABASE}') IS NOT NULL BEGIN
        ALTER DATABASE [${TEST_DATABASE}] SET SINGLE_USER WITH ROLLBACK IMMEDIATE;
        DROP DATABASE [${TEST_DATABASE}];
      END;
      CREATE DATABASE [${TEST_DATABASE}];
    `);
    databasePool = await new sql.ConnectionPool({ ...baseConfig, database: TEST_DATABASE }).connect();
    const script = fs.readFileSync(path.join(__dirname, "..", "SQLQuery1.sql"), "utf8");
    const batches = script.split(/^\s*GO\s*$/gim).slice(2).filter((batch) => batch.trim());
    for (const batch of batches) await databasePool.request().batch(batch);

    const result = await databasePool.request().query(`
      SELECT COUNT(*) AS zones FROM Zone;
      SELECT COUNT(*) AS sensors FROM Device WHERE device_type = 'SENSOR';
      SELECT COUNT(*) AS sensorRows FROM SensorData;
      SELECT COUNT(DISTINCT metric_type) AS metrics FROM Device WHERE device_type = 'SENSOR';
      SELECT COUNT(*) AS alerts FROM AlertLog;
      SELECT COUNT(*) AS logs FROM [Log];
      SELECT COUNT(*) AS activeGreenhousesWithData FROM (
        SELECT DISTINCT z.greenhouse_id FROM SensorData sd
        JOIN Device d ON d.device_id = sd.device_id
        JOIN Zone z ON z.zone_id = d.zone_id
      ) data;
    `);
    const values = result.recordsets.map((rows) => Object.values(rows[0])[0]);
    assert.deepStrictEqual(values, [5, 24, 312, 6, 5, 9, 3]);
    console.log(JSON.stringify({ zones: values[0], sensors: values[1], sensorRows: values[2], metrics: values[3], alerts: values[4], logs: values[5], greenhousesWithData: values[6], result: "PASS" }, null, 2));
  } finally {
    if (databasePool) await databasePool.close();
    await master.request().query(`
      IF DB_ID('${TEST_DATABASE}') IS NOT NULL BEGIN
        ALTER DATABASE [${TEST_DATABASE}] SET SINGLE_USER WITH ROLLBACK IMMEDIATE;
        DROP DATABASE [${TEST_DATABASE}];
      END;
    `);
    await master.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
