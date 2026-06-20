/**
 * server.js
 * REST API cho xác thực, vùng trồng, thiết bị, công thức, cảnh báo và mô phỏng.
 * Các route được nhóm theo tài nguyên để frontend có thể gọi trực tiếp.
 */

const express = require("express");
const cors = require("cors");
require("dotenv").config();
const { getConnection, sql } = require("./db");
const { BackendSimulator } = require("./simulation");
const { MqttService } = require("./mqtt-service");

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(cors());
app.use(express.json());

function getTokenUserId(req) {
  const token = req.headers.authorization?.replace(/^Bearer\s+/i, "");
  const userId = Number(token?.split("-").pop());
  return Number.isSafeInteger(userId) && userId > 0 && userId <= 2147483647 ? userId : null;
}

function getActorUserId(req) {
  return getTokenUserId(req) || 1;
}

async function requireOwner(req, res, next) {
  try {
    const userId = getTokenUserId(req);
    if (!userId) {
      return res.status(401).json({ error: "Phiên đăng nhập không hợp lệ" });
    }
    const pool = await getConnection();
    const result = await pool
      .request()
      .input("id", sql.Int, userId)
      .query("SELECT user_id, user_name, role, status FROM [User] WHERE user_id = @id");
    const user = result.recordset[0];
    if (!user || user.status !== "ACTIVE") {
      return res.status(401).json({ error: "Tài khoản không hoạt động" });
    }
    if (user.role !== "OWNER") {
      return res.status(403).json({ error: "Chỉ OWNER được quản lý tài khoản" });
    }
    req.currentUser = user;
    next();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

async function writeAuditLog(pool, { userId, action, entityType, entityId, deviceId = null }) {
  await pool
    .request()
    .input("deviceId", sql.Int, deviceId)
    .input("userId", sql.Int, userId)
    .input("entityType", sql.NVarChar, entityType)
    .input("entityId", sql.Int, entityId)
    .input("action", sql.NVarChar, action.slice(0, 255)).query(`
      INSERT INTO [Log]
        (device_id, user_id, entity_type, entity_id, action, triggered_by)
      VALUES
        (@deviceId, @userId, @entityType, @entityId, @action, 'USER')
    `);
}

async function writeSystemAuditLog(pool, { action, entityType, entityId = null, deviceId = null }) {
  await pool
    .request()
    .input("deviceId", sql.Int, deviceId)
    .input("entityType", sql.NVarChar, entityType)
    .input("entityId", sql.Int, entityId)
    .input("action", sql.NVarChar, action.slice(0, 255)).query(`
      INSERT INTO [Log]
        (device_id, user_id, entity_type, entity_id, action, triggered_by)
      VALUES
        (@deviceId, NULL, @entityType, @entityId, @action, 'SYSTEM')
    `);
}

async function refreshZoneStatus(pool, zoneId) {
  if (!zoneId) return;
  await pool.request().input("zoneId", sql.Int, zoneId).query(`
    UPDATE Zone SET status = CASE
      WHEN EXISTS (SELECT 1 FROM AlertLog WHERE zone_id = @zoneId
        AND status <> 'RESOLVED' AND severity = 'CRITICAL') THEN 'high'
      WHEN EXISTS (SELECT 1 FROM AlertLog WHERE zone_id = @zoneId
        AND status <> 'RESOLVED' AND severity = 'WARNING') THEN 'warning'
      ELSE 'optimal'
    END
    WHERE zone_id = @zoneId
  `);
}

const simulator = new BackendSimulator({
  getConnection,
  sql,
  intervalMs: Number(process.env.SIMULATION_INTERVAL_MS) || 10000
});
const mqttService = new MqttService({
  simulator,
  brokerUrl: process.env.MQTT_URL || "mqtt://localhost:1883"
});
mqttService.connect();

// ======================================================================
// 1. API AUTH (Đăng nhập, đăng ký, lấy thông tin user)
// ======================================================================

// POST /api/auth/login
app.post("/api/auth/login", async (req, res) => {
  try {
    const { username, password } = req.body;
    const pool = await getConnection();
    const result = await pool
      .request()
      .input("username", sql.NVarChar, username)
      .input("password", sql.NVarChar, password).query(`
                SELECT user_id AS id, user_name AS username, email, phone_number, role, status,
                    is_primary_owner AS isPrimaryOwner
                FROM [User]
                WHERE (user_name = @username OR email = @username) AND password = @password
            `);
    if (result.recordset.length === 0) {
      return res.status(401).json({ error: "Sai tên đăng nhập hoặc mật khẩu" });
    }
    const user = result.recordset[0];
    if (user.status !== "ACTIVE") {
      return res.status(403).json({ error: "Tài khoản chưa được phê duyệt" });
    }
    await writeAuditLog(pool, {
      userId: user.id,
      action: `Tài khoản "${user.username}" đăng nhập.`,
      entityType: "USER",
      entityId: user.id
    });
    // Tạo token giả (trong thực tế nên dùng JWT)
    const token = "demo-token-" + user.id;
    res.json({ ...user, token });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/auth/logout", async (req, res) => {
  try {
    const userId = getActorUserId(req);
    const pool = await getConnection();
    await writeAuditLog(pool, {
      userId,
      action: `Tài khoản #${userId} đăng xuất.`,
      entityType: "USER",
      entityId: userId
    });
    res.json({ message: "Đăng xuất thành công" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put("/api/auth/change-password", async (req, res) => {
  try {
    const userId = getTokenUserId(req);
    if (!userId) return res.status(401).json({ error: "Phiên đăng nhập không hợp lệ" });
    const { oldPassword, newPassword, confirmPassword } = req.body || {};
    if (!oldPassword || !newPassword || !confirmPassword) {
      return res.status(400).json({ error: "Vui lòng nhập đầy đủ mật khẩu" });
    }
    if (newPassword !== confirmPassword) {
      return res.status(400).json({ error: "Hai mật khẩu mới không trùng nhau" });
    }
    if (newPassword.length < 6) {
      return res.status(400).json({ error: "Mật khẩu mới phải có ít nhất 6 ký tự" });
    }
    if (newPassword === oldPassword) {
      return res.status(400).json({ error: "Mật khẩu mới phải khác mật khẩu cũ" });
    }
    const pool = await getConnection();
    const result = await pool
      .request()
      .input("id", sql.Int, userId)
      .input("oldPassword", sql.NVarChar, oldPassword)
      .input("newPassword", sql.NVarChar, newPassword).query(`
        UPDATE [User] SET password = @newPassword
        WHERE user_id = @id AND password = @oldPassword AND status = 'ACTIVE'
      `);
    if (result.rowsAffected[0] === 0) {
      return res.status(400).json({ error: "Mật khẩu cũ không đúng" });
    }
    await writeAuditLog(pool, {
      userId,
      action: "Đổi mật khẩu tài khoản.",
      entityType: "USER",
      entityId: userId
    });
    res.json({ message: "Đổi mật khẩu thành công" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put("/api/auth/forgot-password", async (req, res) => {
  try {
    const { identifier, phone, newPassword, confirmPassword } = req.body || {};
    if (!identifier || !phone || !newPassword || !confirmPassword) {
      return res.status(400).json({ error: "Vui lòng nhập đầy đủ thông tin" });
    }
    if (newPassword !== confirmPassword) {
      return res.status(400).json({ error: "Hai mật khẩu mới không trùng nhau" });
    }
    if (newPassword.length < 6) {
      return res.status(400).json({ error: "Mật khẩu mới phải có ít nhất 6 ký tự" });
    }
    const pool = await getConnection();
    const account = await pool
      .request()
      .input("identifier", sql.NVarChar, identifier.trim())
      .input("phone", sql.NVarChar, phone.trim()).query(`
        SELECT user_id AS id, password
        FROM [User]
        WHERE (user_name = @identifier OR email = @identifier)
          AND phone_number = @phone AND status = 'ACTIVE'
      `);
    if (account.recordset.length === 0) {
      return res.status(400).json({ error: "Thông tin tài khoản hoặc số điện thoại không đúng" });
    }
    if (account.recordset[0].password === newPassword) {
      return res.status(400).json({ error: "Mật khẩu mới phải khác mật khẩu hiện tại" });
    }
    const userId = account.recordset[0].id;
    await pool.request().input("id", sql.Int, userId)
      .input("newPassword", sql.NVarChar, newPassword)
      .query("UPDATE [User] SET password = @newPassword WHERE user_id = @id");
    await writeAuditLog(pool, {
      userId,
      action: "Đặt lại mật khẩu bằng chức năng quên mật khẩu.",
      entityType: "USER",
      entityId: userId
    });
    res.json({ message: "Đặt lại mật khẩu thành công" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/auth/register
app.post("/api/auth/register", async (req, res) => {
  try {
    const { username, password, email, phone, role } = req.body;
    const safeRole = role === "TECHNICIAN" ? "TECHNICIAN" : "OPERATOR";
    const pool = await getConnection();
    // Kiểm tra tồn tại
    const check = await pool
      .request()
      .input("username", sql.NVarChar, username)
      .input("email", sql.NVarChar, email)
      .query(`SELECT * FROM [User] WHERE user_name = @username OR email = @email`);
    if (check.recordset.length > 0) {
      return res.status(400).json({ error: "Tên đăng nhập hoặc email đã tồn tại" });
    }
    const result = await pool
      .request()
      .input("username", sql.NVarChar, username)
      .input("password", sql.NVarChar, password)
      .input("email", sql.NVarChar, email)
      .input("phone", sql.NVarChar, phone)
      .input("role", sql.NVarChar, safeRole).query(`
                INSERT INTO [User] (user_name, password, email, phone_number, role, status)
                OUTPUT INSERTED.user_id AS id, INSERTED.user_name AS username, INSERTED.email, INSERTED.phone_number, INSERTED.role, INSERTED.status
                VALUES (@username, @password, @email, @phone, @role, 'PENDING')
            `);
    await writeSystemAuditLog(pool, {
      action: `Tài khoản "${username}" đăng ký và đang chờ phê duyệt.`,
      entityType: "USER",
      entityId: result.recordset[0].id
    });
    res.status(201).json(result.recordset[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/auth/me
app.get("/api/auth/me", async (req, res) => {
  try {
    // Tạm thời lấy user từ token (giả lập)
    const token = req.headers.authorization?.split(" ")[1];
    if (!token) return res.status(401).json({ error: "Unauthorized" });
    const userId = token.split("-").pop(); // lấy phần cuối làm userId
    const pool = await getConnection();
    const result = await pool
      .request()
      .input("id", sql.Int, userId)
      .query(
        `SELECT user_id AS id, user_name AS username, email, phone_number, role, status,
            is_primary_owner AS isPrimaryOwner FROM [User] WHERE user_id = @id`
      );
    if (result.recordset.length === 0) return res.status(404).json({ error: "User not found" });
    res.json(result.recordset[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ======================================================================
// 2. API USERS (quản lý tài khoản – chỉ OWNER)
// ======================================================================

// GET /api/users
app.get("/api/users", requireOwner, async (req, res) => {
  try {
    const pool = await getConnection();
    const result = await pool.request().query(`
            SELECT user_id AS id, user_name AS username, email, phone_number, role, status,
                is_primary_owner AS isPrimaryOwner
            FROM [User] WHERE is_primary_owner = 0 AND status <> 'REJECTED'
        `);
    res.json(result.recordset);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/users/:id/role
app.put("/api/users/:id/role", requireOwner, async (req, res) => {
  try {
    const { id } = req.params;
    const { role } = req.body;
    if (!["OWNER", "TECHNICIAN", "OPERATOR"].includes(role)) {
      return res.status(400).json({ error: "Vai trò không hợp lệ" });
    }
    const pool = await getConnection();
    const actorUserId = req.currentUser.user_id;
    const result = await pool
      .request()
      .input("id", sql.Int, id)
      .input("role", sql.NVarChar, role)
      .query(`UPDATE [User] SET role = @role WHERE user_id = @id AND is_primary_owner = 0`);
    if (result.rowsAffected[0] === 0) {
      return res.status(400).json({ error: "Không thể thay đổi vai trò OWNER chính" });
    }
    await writeAuditLog(pool, {
      userId: actorUserId,
      action: `Đổi vai trò tài khoản #${id} thành ${role}.`,
      entityType: "USER",
      entityId: Number(id)
    });
    res.json({ message: "Cập nhật role thành công" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/users/:id/status (phê duyệt / từ chối)
app.put("/api/users/:id/status", requireOwner, async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;
    if (!["ACTIVE", "REJECTED"].includes(status)) {
      return res.status(400).json({ error: "Trạng thái không hợp lệ" });
    }
    const pool = await getConnection();
    const actorUserId = req.currentUser.user_id;
    const result = await pool
      .request()
      .input("id", sql.Int, id)
      .input("status", sql.NVarChar, status)
      .query(`UPDATE [User] SET status = @status WHERE user_id = @id AND is_primary_owner = 0`);
    if (result.rowsAffected[0] === 0) {
      return res.status(400).json({ error: "Không thể thay đổi trạng thái OWNER chính" });
    }
    await writeAuditLog(pool, {
      userId: actorUserId,
      action: `Cập nhật trạng thái tài khoản #${id} thành ${status}.`,
      entityType: "USER",
      entityId: Number(id)
    });
    res.json({ message: "Cập nhật trạng thái thành công" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete("/api/users/:id", requireOwner, async (req, res) => {
  try {
    const { id } = req.params;
    const pool = await getConnection();
    const result = await pool.request().input("id", sql.Int, id)
      .query(`UPDATE [User] SET status = 'REJECTED'
              OUTPUT INSERTED.user_name AS username
              WHERE user_id = @id AND is_primary_owner = 0`);
    if (result.recordset.length === 0) {
      return res
        .status(400)
        .json({ error: "Không thể xóa OWNER chính hoặc tài khoản không tồn tại" });
    }
    await writeAuditLog(pool, {
      userId: req.currentUser.user_id,
      action: `Xóa tài khoản "${result.recordset[0].username}" (soft-delete).`,
      entityType: "USER",
      entityId: Number(id)
    });
    res.json({ message: "Xóa tài khoản thành công" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ======================================================================
// 3. API FARMS & GREENHOUSES
// ======================================================================

app.use("/api", async (req, res, next) => {
  try {
    const userId = getTokenUserId(req);
    if (!userId) return res.status(401).json({ error: "Phiên đăng nhập không hợp lệ" });
    const pool = await getConnection();
    const result = await pool.request().input("id", sql.Int, userId)
      .query("SELECT role FROM [User] WHERE user_id = @id AND status = 'ACTIVE'");
    const role = result.recordset[0]?.role;
    if (!role) return res.status(401).json({ error: "Tài khoản không hoạt động" });
    if (role === "OWNER") return next();

    const path = req.path;
    const commonRead = ["/devices", "/zones", "/alerts", "/sensor-data", "/stats", "/control-properties"];
    const technicianRead = ["/recipes", "/stages", "/gateways", "/farms", "/greenhouses", "/simulation"];
    const isAllowedRead = req.method === "GET" && (
      commonRead.some((prefix) => path.startsWith(prefix)) ||
      (role === "TECHNICIAN" && technicianRead.some((prefix) => path.startsWith(prefix)))
    );
    const isTechnicianWrite = role === "TECHNICIAN" && (
      path.startsWith("/devices") || path.startsWith("/recipes") || path.startsWith("/stages") ||
      path.startsWith("/simulation") || /^\/zones\/\d+\/cycle-adjustment$/.test(path)
    );
    const isControlWrite = path.startsWith("/control-properties") && ["PUT", "POST"].includes(req.method);
    if (isAllowedRead || isTechnicianWrite || isControlWrite) return next();
    return res.status(403).json({ error: "Bạn không có quyền thực hiện chức năng này" });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.get("/api/farms", async (req, res) => {
  try {
    const pool = await getConnection();
    const result = await pool.request().query(`
            SELECT farm_id AS id, farm_name AS name, address, owner_id FROM Farm
        `);
    res.json(result.recordset);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/greenhouses", async (req, res) => {
  try {
    const pool = await getConnection();
    const result = await pool.request().query(`
            SELECT greenhouse_id AS id, farm_id, greenhouse_name AS name, location_gps FROM Greenhouse
        `);
    res.json(result.recordset);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/greenhouses/:farmId", async (req, res) => {
  try {
    const { farmId } = req.params;
    const pool = await getConnection();
    const result = await pool.request().input("farmId", sql.Int, farmId).query(`
                SELECT greenhouse_id AS id, farm_id, greenhouse_name AS name, location_gps
                FROM Greenhouse WHERE farm_id = @farmId
            `);
    res.json(result.recordset);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ======================================================================
// 4. API ZONES (cây phân cấp – dùng CTE đệ quy)
// ======================================================================

app.get("/api/zones", async (req, res) => {
  try {
    const pool = await getConnection();
    // Dùng CAST ở phần Anchor để đồng bộ kiểu dữ liệu (NVARCHAR(20) và INT)
    const result = await pool.request().query(`
            WITH ZoneTree AS (
                -- Lấy tất cả Farm (root) - Ép kiểu rõ ràng ở đây
                SELECT 
                    f.farm_id AS id,
                    f.farm_name AS name,
                    CAST('farm' AS NVARCHAR(20)) AS type,
                    CAST(NULL AS INT) AS parent_id,
                    CAST(NULL AS INT) AS recipe_id,
                    CAST(NULL AS DATE) AS start_date,
                    CAST(NULL AS DECIMAL(5,2)) AS temperature,
                    CAST(NULL AS INT) AS humidity,
                    CAST(NULL AS NVARCHAR(20)) AS status,
                    CAST(NULL AS INT) AS cycle_adjustment_days,
                    CAST(NULL AS NVARCHAR(255)) AS adjustment_reason,
                    0 AS level,
                    CAST(f.farm_id AS NVARCHAR(MAX)) AS path
                FROM Farm f
                UNION ALL
                -- Greenhouse
                SELECT 
                    g.greenhouse_id AS id,
                    g.greenhouse_name AS name,
                    CAST('greenhouse' AS NVARCHAR(20)) AS type,
                    g.farm_id AS parent_id,
                    CAST(NULL AS INT) AS recipe_id,
                    CAST(NULL AS DATE) AS start_date,
                    CAST(NULL AS DECIMAL(5,2)) AS temperature,
                    CAST(NULL AS INT) AS humidity,
                    CAST(NULL AS NVARCHAR(20)) AS status,
                    CAST(NULL AS INT) AS cycle_adjustment_days,
                    CAST(NULL AS NVARCHAR(255)) AS adjustment_reason,
                    zt.level + 1,
                    zt.path + ':' + CAST(g.greenhouse_id AS NVARCHAR(10))
                FROM Greenhouse g
                INNER JOIN ZoneTree zt ON g.farm_id = zt.id AND zt.type = 'farm'
                UNION ALL
                -- Zone
                SELECT 
                    z.zone_id AS id,
                    z.zone_name AS name,
                    CAST('zone' AS NVARCHAR(20)) AS type,
                    z.greenhouse_id AS parent_id,
                    z.recipe_id,
                    z.start_date,
                    z.temperature,
                    z.humidity,
                    z.status,
                    z.cycle_adjustment_days,
                    z.adjustment_reason,
                    zt.level + 1,
                    zt.path + ':' + CAST(z.zone_id AS NVARCHAR(10))
                FROM Zone z
                INNER JOIN ZoneTree zt ON z.greenhouse_id = zt.id AND zt.type = 'greenhouse'
            )
            SELECT zt.id, zt.name, zt.type, zt.parent_id, zt.recipe_id,
                CONVERT(VARCHAR(10), zt.start_date, 23) AS start_date,
                zt.temperature, zt.humidity, zt.status,
                zt.cycle_adjustment_days, zt.adjustment_reason,
                zt.level, zt.path
            FROM ZoneTree zt ORDER BY zt.path
        `);
    // Trả về danh sách flat, front-end sẽ parse thành cây
    res.json(result.recordset);
  } catch (err) {
    console.error("GET /api/zones error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ======================================================================
// 5. API DEVICES (đã có, giữ nguyên)
// ======================================================================

app.get("/api/devices", async (req, res) => {
  try {
    const pool = await getConnection();
    const result = await pool.request().query(`
            SELECT 
                device_id AS id,
                device_name AS name,
                device_type,
                metric_type,
                mac_address AS macAddress,
                zone_id,
                gateway_id,
                status,
                battery_level AS batteryLevel,
                last_heartbeat AS lastHeartbeat
            FROM Device
        `);
    res.json(result.recordset);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/devices/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const pool = await getConnection();
    const result = await pool.request().input("id", sql.Int, id).query(`
                SELECT 
                    device_id AS id,
                    device_name AS name,
                    device_type,
                    metric_type,
                    mac_address AS macAddress,
                    zone_id,
                    gateway_id,
                    status,
                    battery_level AS batteryLevel,
                    last_heartbeat AS lastHeartbeat
                FROM Device WHERE device_id = @id
            `);
    if (result.recordset.length === 0) {
      return res.status(404).json({ error: "Không tìm thấy thiết bị" });
    }
    res.json(result.recordset[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/devices", async (req, res) => {
  try {
    const { name, device_type, metric_type, macAddress, zone_id, gateway_id, batteryLevel } =
      req.body;
    const pool = await getConnection();
    const actorUserId = getTokenUserId(req);
    if (!actorUserId) return res.status(401).json({ error: "Phiên đăng nhập không hợp lệ" });
    const result = await pool
      .request()
      .input("name", sql.NVarChar, name)
      .input("device_type", sql.NVarChar, device_type)
      .input("metric_type", sql.NVarChar, metric_type)
      .input("macAddress", sql.NVarChar, macAddress)
      .input("zone_id", sql.Int, zone_id)
      .input("gateway_id", sql.Int, gateway_id)
      .input("batteryLevel", sql.Int, batteryLevel)
      .input("status", sql.NVarChar, "ONLINE")
      .input("lastHeartbeat", sql.DateTime2, new Date()).query(`
                INSERT INTO Device (device_name, device_type, metric_type, mac_address, zone_id, gateway_id, battery_level, status, last_heartbeat)
                OUTPUT INSERTED.device_id AS id
                VALUES (@name, @device_type, @metric_type, @macAddress, @zone_id, @gateway_id, @batteryLevel, @status, @lastHeartbeat)
            `);
    const newId = result.recordset[0].id;
    await pool
      .request()
      .input("deviceId", sql.Int, newId)
      .input("userId", sql.Int, actorUserId)
      .input(
        "action",
        sql.NVarChar,
        `Thêm thiết bị "${name}" (${device_type}, ${metric_type}) vào Zone #${zone_id}.`
      ).query(`
        INSERT INTO [Log]
          (device_id, user_id, entity_type, entity_id, action, triggered_by)
        VALUES
          (@deviceId, @userId, 'DEVICE', @deviceId, @action, 'USER')
      `);
    if (device_type === "OUTPUT_DEVICE") {
      await pool
        .request()
        .input("device_id", sql.Int, newId)
        .input("mode", sql.NVarChar, "AUTO")
        .input("is_active", sql.Bit, 0)
        .input("value_percent", sql.Int, 0).query(`
                    INSERT INTO ControlProperties (device_id, mode, is_active, value_percent, auto_reset_time)
                    VALUES (@device_id, @mode, @is_active, @value_percent, NULL)
                `);
    }
    res.status(201).json({ id: newId, message: "Thêm thiết bị thành công" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put("/api/devices/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const {
      name,
      device_type,
      metric_type,
      macAddress,
      zone_id,
      gateway_id,
      status,
      batteryLevel
    } = req.body;
    const pool = await getConnection();
    const actorUserId = getActorUserId(req);
    const action = `Cập nhật thiết bị "${name}" (${device_type}, ${metric_type}), Zone #${zone_id}, Gateway #${gateway_id}.`;
    await pool
      .request()
      .input("id", sql.Int, id)
      .input("name", sql.NVarChar, name)
      .input("device_type", sql.NVarChar, device_type)
      .input("metric_type", sql.NVarChar, metric_type)
      .input("macAddress", sql.NVarChar, macAddress)
      .input("zone_id", sql.Int, zone_id)
      .input("gateway_id", sql.Int, gateway_id)
      .input("status", sql.NVarChar, status || null)
      .input("batteryLevel", sql.Int, batteryLevel ?? null)
      .input("userId", sql.Int, actorUserId)
      .input("action", sql.NVarChar, action.slice(0, 255)).query(`
                UPDATE Device SET
                    device_name = @name,
                    device_type = @device_type,
                    metric_type = @metric_type,
                    mac_address = @macAddress,
                    zone_id = @zone_id,
                    gateway_id = @gateway_id,
                    status = COALESCE(@status, status),
                    battery_level = COALESCE(@batteryLevel, battery_level)
                WHERE device_id = @id

                IF @@ROWCOUNT = 0 THROW 50001, 'Device not found', 1;
                INSERT INTO [Log]
                  (device_id, user_id, entity_type, entity_id, action, triggered_by)
                VALUES (@id, @userId, 'DEVICE', @id, @action, 'USER');
            `);
    res.json({ message: "Cập nhật thiết bị thành công" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete("/api/devices/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const pool = await getConnection();
    const actorUserId = getActorUserId(req);
    await pool.request().input("id", sql.Int, id).input("userId", sql.Int, actorUserId).query(`
                DECLARE @deviceName NVARCHAR(100) =
                    (SELECT device_name FROM Device WHERE device_id = @id);
                IF @deviceName IS NULL THROW 50001, 'Device not found', 1;

                INSERT INTO [Log]
                  (device_id, user_id, entity_type, entity_id, action, triggered_by)
                VALUES
                  (@id, @userId, 'DEVICE', @id, N'Xóa thiết bị "' + @deviceName + N'".', 'USER');
                DELETE FROM SensorData WHERE device_id = @id;
                DELETE FROM ControlProperties WHERE device_id = @id;
                DELETE FROM Device WHERE device_id = @id;
            `);
    res.json({ message: "Xóa thiết bị thành công" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ======================================================================
// 6. API CONTROL PROPERTIES
// ======================================================================

app.get("/api/control-properties", async (req, res) => {
  try {
    const pool = await getConnection();
    const result = await pool.request().query(`
            SELECT 
                cp.device_id,
                cp.mode,
                cp.is_active AS isActive,
                cp.value_percent AS valuePercent,
                cp.auto_reset_time AS autoResetTime,
                d.device_name AS name,
                d.zone_id,
                d.gateway_id
            FROM ControlProperties cp
            JOIN Device d ON cp.device_id = d.device_id
        `);
    res.json(result.recordset);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put("/api/control-properties/:deviceId", async (req, res) => {
  try {
    const { deviceId } = req.params;
    const { mode, isActive, valuePercent, autoResetTime } = req.body;
    if (!["AUTO", "MANUAL"].includes(mode)) {
      return res.status(400).json({ error: "Chế độ chỉ có thể là AUTO hoặc MANUAL" });
    }
    const parsedValue = Number(valuePercent);
    if (typeof isActive !== "boolean" || !Number.isInteger(parsedValue) || parsedValue < 0 || parsedValue > 100) {
      return res.status(400).json({ error: "Trạng thái hoặc công suất không hợp lệ" });
    }
    const pool = await getConnection();
    const actorUserId = getTokenUserId(req);
    if (!actorUserId) return res.status(401).json({ error: "Phiên đăng nhập không hợp lệ" });
    const actorResult = await pool.request().input("actorUserId", sql.Int, actorUserId)
      .query("SELECT role FROM [User] WHERE user_id = @actorUserId AND status = 'ACTIVE'");
    if (actorResult.recordset.length === 0) {
      return res.status(401).json({ error: "Tài khoản không hợp lệ" });
    }
    const actorRole = actorResult.recordset[0].role;
    if (!['OWNER', 'TECHNICIAN', 'OPERATOR'].includes(actorRole)) {
      return res.status(403).json({ error: "Bạn không có quyền điều khiển thiết bị" });
    }
    if (actorRole === "TECHNICIAN" && mode !== "AUTO") {
      return res.status(403).json({ error: "Kỹ thuật viên chỉ được sử dụng chế độ AUTO" });
    }
    const currentResult = await pool.request().input("deviceId", sql.Int, deviceId).query(`
      SELECT cp.mode, cp.is_active AS isActive, cp.value_percent AS valuePercent
      FROM ControlProperties cp JOIN Device d ON d.device_id = cp.device_id
      WHERE cp.device_id = @deviceId AND d.device_type = 'OUTPUT_DEVICE'
    `);
    if (currentResult.recordset.length === 0) {
      return res.status(404).json({ error: "Không tìm thấy thiết bị đầu ra" });
    }
    const current = currentResult.recordset[0];
    if (current.mode === "AUTO" && mode === "AUTO" &&
        (Boolean(current.isActive) !== isActive || Number(current.valuePercent) !== parsedValue)) {
      return res.status(409).json({ error: "Không thể điều khiển thủ công khi thiết bị đang ở chế độ AUTO" });
    }
    const result = await pool
      .request()
      .input("deviceId", sql.Int, deviceId)
      .input("mode", sql.NVarChar, mode)
      .input("isActive", sql.Bit, isActive)
      .input("valuePercent", sql.Int, parsedValue)
      .input("autoResetTime", sql.DateTime2, mode === "MANUAL" ? autoResetTime : null).query(`
                UPDATE ControlProperties SET
                    mode = @mode,
                    is_active = @isActive,
                    value_percent = @valuePercent,
                    auto_reset_time = @autoResetTime
                WHERE device_id = @deviceId
            `);
    if (result.rowsAffected[0] === 0) {
      return res.status(404).json({ error: "Không tìm thấy cấu hình điều khiển" });
    }
    await writeAuditLog(pool, {
      userId: actorUserId,
      action: `Điều khiển thiết bị #${deviceId}: mode=${mode}, trạng thái=${isActive ? "bật" : "tắt"}, mức=${parsedValue}%.`,
      entityType: "DEVICE",
      entityId: Number(deviceId),
      deviceId: Number(deviceId)
    });
    res.json({ message: "Cập nhật control property thành công" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ======================================================================
// 7. API GATEWAYS
// ======================================================================

app.get("/api/gateways", async (req, res) => {
  try {
    const pool = await getConnection();
    const result = await pool.request().query(`
            SELECT gateway_id AS id, greenhouse_id, status, gateway_address AS address
            FROM Gateway
        `);
    res.json(result.recordset);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ======================================================================
// 8. API RECIPES (Công thức sinh trưởng)
// ======================================================================

app.get("/api/recipes", async (req, res) => {
  try {
    const pool = await getConnection();
    const result = await pool.request().query(`
            SELECT 
                recipe_id AS id,
                recipe_name AS name,
                flower_type,
                creator AS creator_id,
                (SELECT user_name FROM [User] WHERE user_id = Recipe.creator) AS creator_name,
                description
            FROM Recipe
        `);
    res.json(result.recordset);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/recipes/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const pool = await getConnection();
    const result = await pool.request().input("id", sql.Int, id).query(`
                SELECT 
                    recipe_id AS id,
                    recipe_name AS name,
                    flower_type,
                    creator AS creator_id,
                    (SELECT user_name FROM [User] WHERE user_id = Recipe.creator) AS creator_name,
                    description
                FROM Recipe WHERE recipe_id = @id
            `);
    if (result.recordset.length === 0) {
      return res.status(404).json({ error: "Không tìm thấy công thức" });
    }
    res.json(result.recordset[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/recipes", async (req, res) => {
  try {
    const { name, flower_type, description } = req.body;
    if (!String(name || "").trim() || !String(flower_type || "").trim()) {
      return res.status(400).json({ error: "Tên công thức và loại hoa là bắt buộc" });
    }
    const pool = await getConnection();
    const actorUserId = getActorUserId(req);
    const result = await pool
      .request()
      .input("name", sql.NVarChar, name)
      .input("flower_type", sql.NVarChar, flower_type)
      .input("creator_id", sql.Int, actorUserId)
      .input("description", sql.NVarChar, description).query(`
                INSERT INTO Recipe (recipe_name, flower_type, creator, description, status, created_date)
                OUTPUT INSERTED.recipe_id AS id
                VALUES (@name, @flower_type, @creator_id, @description, 'active', CAST(GETDATE() AS DATE))
            `);
    await writeAuditLog(pool, {
      userId: actorUserId,
      action: `Thêm công thức "${name}" cho ${flower_type}.`,
      entityType: "RECIPE",
      entityId: result.recordset[0].id
    });
    res.status(201).json({
      id: result.recordset[0].id,
      message: "Thêm công thức thành công"
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put("/api/recipes/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { name, flower_type, description } = req.body;
    if (!String(name || "").trim() || !String(flower_type || "").trim()) {
      return res.status(400).json({ error: "Tên công thức và loại hoa là bắt buộc" });
    }
    const pool = await getConnection();
    const actorUserId = getActorUserId(req);
    await pool
      .request()
      .input("id", sql.Int, id)
      .input("name", sql.NVarChar, name)
      .input("flower_type", sql.NVarChar, flower_type)
      .input("description", sql.NVarChar, description).query(`
                UPDATE Recipe SET
                    recipe_name = @name,
                    flower_type = @flower_type,
                    description = @description
                WHERE recipe_id = @id
            `);
    await writeAuditLog(pool, {
      userId: actorUserId,
      action: `Cập nhật công thức "${name}".`,
      entityType: "RECIPE",
      entityId: Number(id)
    });
    res.json({ message: "Cập nhật công thức thành công" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete("/api/recipes/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const pool = await getConnection();
    const actorUserId = getActorUserId(req);
    const recipeResult = await pool
      .request()
      .input("id", sql.Int, id)
      .query("SELECT recipe_name FROM Recipe WHERE recipe_id = @id");
    if (recipeResult.recordset.length === 0) {
      return res.status(404).json({ error: "Không tìm thấy công thức" });
    }
    await pool.request().input("id", sql.Int, id).query(`
                BEGIN TRANSACTION;
                BEGIN TRY
                    UPDATE Zone SET recipe_id = NULL WHERE recipe_id = @id;
                    DELETE FROM Threshold WHERE stage_id IN (SELECT stage_id FROM GrowthStage WHERE recipe_id = @id);
                    DELETE FROM GrowthStage WHERE recipe_id = @id;
                    DELETE FROM Recipe WHERE recipe_id = @id;
                    COMMIT TRANSACTION;
                END TRY
                BEGIN CATCH
                    IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;
                    THROW;
                END CATCH
            `);
    await writeAuditLog(pool, {
      userId: actorUserId,
      action: `Xóa công thức "${recipeResult.recordset[0].recipe_name}".`,
      entityType: "RECIPE",
      entityId: Number(id)
    });
    res.json({ message: "Xóa công thức thành công" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ======================================================================
// 9. API GROWTH STAGES & THRESHOLDS
// ======================================================================

app.get("/api/recipes/:recipeId/stages", async (req, res) => {
  try {
    const { recipeId } = req.params;
    const pool = await getConnection();
    const result = await pool.request().input("recipeId", sql.Int, recipeId).query(`
                SELECT 
                    stage_id AS id,
                    stage_name AS name,
                    start_day,
                    end_day
                FROM GrowthStage
                WHERE recipe_id = @recipeId
                ORDER BY start_day
            `);
    res.json(result.recordset);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/stages/:stageId/thresholds", async (req, res) => {
  try {
    const { stageId } = req.params;
    const pool = await getConnection();
    const result = await pool.request().input("stageId", sql.Int, stageId).query(`
                SELECT 
                    threshold_id AS id,
                    metric_type,
                    min_value,
                    max_value
                FROM Threshold
                WHERE stage_id = @stageId
            `);
    res.json(result.recordset);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ======================================================================
// 10. API ALERTS
// ======================================================================

app.get("/api/alerts", async (req, res) => {
  try {
    const pool = await getConnection();
    const result = await pool.request().query(`
            SELECT 
                alert.alert_id AS id,
                alert.zone_id,
                zone.greenhouse_id,
                alert.message AS description,
                alert.severity,
                alert.status,
                alert.created_at AS timestamp,
                alert.resolved_at,
                alert.acknowledged_by AS acknowledgedBy,
                alert.escalation_level AS escalationLevel
            FROM AlertLog alert
            JOIN Zone zone ON zone.zone_id = alert.zone_id
        `);
    // Chuyển đổi severity: 'SIGNIFICANT' → 'info', 'WARNING' → 'warning', 'CRITICAL' → 'critical'
    const alerts = result.recordset.map((a) => ({
      ...a,
      title:
        a.severity === "CRITICAL"
          ? "Sự cố nghiêm trọng"
          : a.severity === "WARNING"
            ? "Cảnh báo môi trường"
            : "Thông báo hệ thống",
      severity: a.severity === "SIGNIFICANT" ? "info" : a.severity.toLowerCase(),
      status: a.status === "UNSOLVED" ? "active" : a.status.toLowerCase()
    }));
    res.json(alerts);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put("/api/alerts/:id/status", async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;
    if (!["ACKNOWLEDGED", "RESOLVED"].includes(status)) {
      return res.status(400).json({ error: "Trạng thái cảnh báo không hợp lệ" });
    }
    const pool = await getConnection();
    const actorUserId = getActorUserId(req);
    const alertResult = await pool.request().input("alertId", sql.Int, id)
      .query("SELECT zone_id FROM AlertLog WHERE alert_id = @alertId");
    if (alertResult.recordset.length === 0) {
      return res.status(404).json({ error: "Không tìm thấy cảnh báo" });
    }
    const actor = await pool.request().input("actorUserId", sql.Int, actorUserId)
      .query("SELECT user_name FROM [User] WHERE user_id = @actorUserId");
    const acknowledgedBy = status === "ACKNOWLEDGED" ? actor.recordset[0]?.user_name : null;
    const updateResult = await pool
      .request()
      .input("id", sql.Int, id)
      .input("status", sql.NVarChar, status)
      .input("acknowledgedBy", sql.NVarChar, acknowledgedBy)
      .input("resolvedAt", sql.DateTime2, status === "RESOLVED" ? new Date() : null).query(`
                UPDATE AlertLog SET
                    status = @status,
                    acknowledged_by = COALESCE(@acknowledgedBy, acknowledged_by),
                    resolved_at = @resolvedAt
                WHERE alert_id = @id
            `);
    if (updateResult.rowsAffected[0] === 0) {
      return res.status(404).json({ error: "Không tìm thấy cảnh báo" });
    }
    await refreshZoneStatus(pool, alertResult.recordset[0].zone_id);
    await writeAuditLog(pool, {
      userId: actorUserId,
      action: `Cập nhật cảnh báo #${id} thành ${status}.`,
      entityType: "ALERT",
      entityId: Number(id)
    });
    res.json({ message: "Cập nhật trạng thái cảnh báo thành công" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete("/api/alerts/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const pool = await getConnection();
    const actorUserId = getActorUserId(req);
    const alertResult = await pool.request().input("alertId", sql.Int, id)
      .query("SELECT zone_id FROM AlertLog WHERE alert_id = @alertId");
    if (alertResult.recordset.length === 0) {
      return res.status(404).json({ error: "Không tìm thấy cảnh báo" });
    }
    await pool
      .request()
      .input("id", sql.Int, id)
      .query(`DELETE FROM AlertLog WHERE alert_id = @id`);
    await refreshZoneStatus(pool, alertResult.recordset[0].zone_id);
    await writeAuditLog(pool, {
      userId: actorUserId,
      action: `Xóa cảnh báo #${id}.`,
      entityType: "ALERT",
      entityId: Number(id)
    });
    res.json({ message: "Xóa cảnh báo thành công" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ======================================================================
// 11. API LOGS
// ======================================================================

app.get("/api/logs", async (req, res) => {
  try {
    const pool = await getConnection();
    const result = await pool.request().query(`
            SELECT 
                l.log_id AS id,
                l.device_id AS deviceId,
                l.user_id AS userId,
                u.user_name AS userName,
                u.role AS userRole,
                l.entity_type AS entityType,
                l.entity_id AS entityId,
                CASE l.entity_type
                  WHEN 'DEVICE' THEN d.device_name
                  WHEN 'ZONE' THEN (SELECT zone_name FROM Zone WHERE zone_id = l.entity_id)
                  WHEN 'GREENHOUSE' THEN (SELECT greenhouse_name FROM Greenhouse WHERE greenhouse_id = l.entity_id)
                  WHEN 'FARM' THEN (SELECT farm_name FROM Farm WHERE farm_id = l.entity_id)
                  WHEN 'RECIPE' THEN (SELECT recipe_name FROM Recipe WHERE recipe_id = l.entity_id)
                  WHEN 'GROWTH_STAGE' THEN (SELECT stage_name FROM GrowthStage WHERE stage_id = l.entity_id)
                  WHEN 'ALERT' THEN CONCAT('Cảnh báo #', l.entity_id)
                  WHEN 'USER' THEN (SELECT user_name FROM [User] WHERE user_id = l.entity_id)
                  WHEN 'SIMULATION' THEN 'Backend simulator'
                END AS entityName,
                l.action AS description,
                l.triggered_by AS triggeredBy,
                l.log_time AS timestamp
            FROM [Log] l
            LEFT JOIN [User] u ON l.user_id = u.user_id
            LEFT JOIN Device d ON l.device_id = d.device_id
            ORDER BY l.log_time DESC
        `);
    res.json(result.recordset);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ======================================================================
// 12. API SENSOR DATA (dữ liệu mô phỏng nhận qua MQTT)
// ======================================================================

app.get("/api/sensor-data", async (req, res) => {
  try {
    const greenhouseId = Number(req.query.greenhouseId);
    const limit = Math.min(Math.max(Number(req.query.limit) || 200, 1), 1000);
    const pool = await getConnection();
    const request = pool.request().input("limit", sql.Int, limit);
    let whereClause = "";
    if (Number.isInteger(greenhouseId) && greenhouseId > 0) {
      request.input("greenhouseId", sql.Int, greenhouseId);
      whereClause = "WHERE z.greenhouse_id = @greenhouseId";
    }
    const result = await request.query(`
            SELECT TOP (@limit)
                sd.device_id AS deviceId,
                d.device_name AS deviceName,
                d.metric_type AS metricType,
                d.zone_id AS zoneId,
                z.greenhouse_id AS greenhouseId,
                sd.[timestamp],
                sd.raw_value AS value
            FROM SensorData sd
            JOIN Device d ON sd.device_id = d.device_id
            JOIN Zone z ON d.zone_id = z.zone_id
            ${whereClause}
            ORDER BY sd.[timestamp] DESC
        `);
    res.json(result.recordset.reverse());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ======================================================================
// API BACKEND SIMULATION
// ======================================================================

app.get("/api/simulation/status", (req, res) => {
  res.json(simulator.getStatus());
});

app.post("/api/simulation/start", async (req, res) => {
  const result = simulator.start(req.body?.intervalMs);
  const pool = await getConnection();
  await writeAuditLog(pool, {
    userId: getActorUserId(req),
    action: `Bật mô phỏng backend với chu kỳ ${result.intervalMs} ms.`,
    entityType: "SIMULATION",
    entityId: null
  });
  res.json(result);
});

app.post("/api/simulation/stop", async (req, res) => {
  const result = simulator.stop();
  const pool = await getConnection();
  await writeAuditLog(pool, {
    userId: getActorUserId(req),
    action: "Dừng mô phỏng backend.",
    entityType: "SIMULATION",
    entityId: null
  });
  res.json(result);
});

app.post("/api/simulation/tick", async (req, res) => {
  try {
    const result = await simulator.tick();
    const pool = await getConnection();
    await writeAuditLog(pool, {
      userId: getActorUserId(req),
      action: `Chạy thủ công một lượt mô phỏng (${result.readings || 0} cảm biến).`,
      entityType: "SIMULATION",
      entityId: null
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/simulation/readings", async (req, res) => {
  try {
    const { deviceId, value, timestamp } = req.body || {};
    if (!deviceId || value === undefined || value === null) {
      return res.status(400).json({ error: "deviceId và value là bắt buộc" });
    }
    const result = await simulator.processReading(
      Number(deviceId),
      Number(value),
      timestamp ? new Date(timestamp) : null,
      "MANUAL_TEST"
    );
    const pool = await getConnection();
    await writeAuditLog(pool, {
      userId: getActorUserId(req),
      action: `Gửi giá trị mô phỏng ${value} cho cảm biến #${deviceId}.`,
      entityType: "DEVICE",
      entityId: Number(deviceId),
      deviceId: Number(deviceId)
    });
    res.status(201).json(result);
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

// ======================================================================
// 13. API STATISTICS (cho Dashboard)
// ======================================================================

app.get("/api/stats/greenhouse/:greenhouseId", async (req, res) => {
  try {
    const { greenhouseId } = req.params;
    const pool = await getConnection();
    const result = await pool.request().input("greenhouseId", sql.Int, greenhouseId).query(`
                SELECT 
                    (SELECT COUNT(*) FROM Device d JOIN Zone z ON d.zone_id = z.zone_id WHERE z.greenhouse_id = @greenhouseId) AS totalDevices,
                    (SELECT COUNT(*) FROM Device d JOIN Zone z ON d.zone_id = z.zone_id WHERE z.greenhouse_id = @greenhouseId AND d.status = 'ONLINE') AS activeDevices,
                    (SELECT COUNT(*) FROM Device d JOIN Zone z ON d.zone_id = z.zone_id WHERE z.greenhouse_id = @greenhouseId AND d.status = 'OFFLINE') AS offlineDevices,
                    (SELECT COUNT(*) FROM Device d JOIN Zone z ON d.zone_id = z.zone_id WHERE z.greenhouse_id = @greenhouseId AND d.status = 'NEEDS_REPLACEMENT') AS needReplace,
                    (SELECT COUNT(*) FROM AlertLog a JOIN Zone z ON a.zone_id = z.zone_id WHERE z.greenhouse_id = @greenhouseId AND a.status != 'RESOLVED') AS activeAlerts,
                    (SELECT COUNT(*) FROM AlertLog a JOIN Zone z ON a.zone_id = z.zone_id WHERE z.greenhouse_id = @greenhouseId AND a.severity = 'CRITICAL' AND a.status != 'RESOLVED') AS criticalAlerts,
                    (SELECT COUNT(*) FROM AlertLog a JOIN Zone z ON a.zone_id = z.zone_id WHERE z.greenhouse_id = @greenhouseId AND a.severity = 'WARNING' AND a.status != 'RESOLVED') AS warningAlerts,
                    (SELECT COUNT(*) FROM AlertLog a JOIN Zone z ON a.zone_id = z.zone_id WHERE z.greenhouse_id = @greenhouseId AND a.severity = 'SIGNIFICANT' AND a.status != 'RESOLVED') AS infoAlerts,
                    (SELECT COUNT(*) FROM Zone WHERE greenhouse_id = @greenhouseId) AS totalZones,
                    (SELECT COUNT(*) FROM Zone WHERE greenhouse_id = @greenhouseId AND recipe_id IS NOT NULL) AS zonesWithRecipe
            `);
    res.json(result.recordset[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ======================================================================
// 13. API GLOBAL STATS (tổng hợp tất cả)
// ======================================================================

app.get("/api/stats/global", async (req, res) => {
  try {
    const pool = await getConnection();
    const result = await pool.request().query(`
            SELECT 
                (SELECT COUNT(*) FROM Device) AS totalDevices,
                (SELECT COUNT(*) FROM Device WHERE status = 'ONLINE') AS activeDevices,
                (SELECT COUNT(*) FROM Device WHERE status = 'OFFLINE') AS offlineDevices,
                (SELECT COUNT(*) FROM Device WHERE status = 'NEEDS_REPLACEMENT') AS needReplace,
                (SELECT COUNT(*) FROM AlertLog WHERE status != 'RESOLVED') AS activeAlerts,
                (SELECT COUNT(*) FROM AlertLog WHERE severity = 'CRITICAL' AND status != 'RESOLVED') AS criticalAlerts,
                (SELECT COUNT(*) FROM AlertLog WHERE severity = 'WARNING' AND status != 'RESOLVED') AS warningAlerts,
                (SELECT COUNT(*) FROM AlertLog WHERE severity = 'SIGNIFICANT' AND status != 'RESOLVED') AS infoAlerts,
                (SELECT COUNT(*) FROM Zone) AS totalZones,
                (SELECT COUNT(*) FROM Zone WHERE recipe_id IS NOT NULL) AS zonesWithRecipe
        `);
    res.json(result.recordset[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ======================================================================
// 14. API ZONES CRUD
// ======================================================================

// POST /api/zones - Thêm mới vùng (farm, greenhouse, zone)
app.post("/api/zones", async (req, res) => {
  try {
    const { name, type, parent_id, greenhouse_id, recipe_id, start_date, status } = req.body;
    const pool = await getConnection();
    const actorUserId = getActorUserId(req);

    let newId = null;

    if (type === "farm") {
      // Thêm farm - owner_id tạm lấy từ user đăng nhập (mặc định 1)
      const ownerId = actorUserId;
      const result = await pool
        .request()
        .input("name", sql.NVarChar, name)
        .input("ownerId", sql.Int, ownerId).query(`
                    INSERT INTO Farm (farm_name, owner_id, address)
                    OUTPUT INSERTED.farm_id AS id
                    VALUES (@name, @ownerId, '')
                `);
      newId = result.recordset[0].id;
    } else if (type === "greenhouse") {
      // Thêm greenhouse - cần farm_id từ parent_id
      if (!parent_id) {
        return res.status(400).json({ error: "Thiếu farm_id (parent_id)" });
      }
      // Kiểm tra parent_id có tồn tại trong Farm không
      const checkFarm = await pool
        .request()
        .input("farmId", sql.Int, parent_id)
        .query("SELECT farm_id FROM Farm WHERE farm_id = @farmId");
      if (checkFarm.recordset.length === 0) {
        return res.status(400).json({ error: "Farm không tồn tại" });
      }
      const result = await pool
        .request()
        .input("name", sql.NVarChar, name)
        .input("farmId", sql.Int, parent_id).query(`
                    INSERT INTO Greenhouse (greenhouse_name, farm_id, location_gps)
                    OUTPUT INSERTED.greenhouse_id AS id
                    VALUES (@name, @farmId, '')
                `);
      newId = result.recordset[0].id;
    } else if (type === "zone") {
      // Thêm zone - cần greenhouse_id từ parent_id hoặc từ body
      let ghId = greenhouse_id || parent_id;
      if (!ghId) {
        return res.status(400).json({ error: "Thiếu greenhouse_id hoặc parent_id" });
      }
      // Kiểm tra greenhouse tồn tại
      const checkGh = await pool
        .request()
        .input("ghId", sql.Int, ghId)
        .query("SELECT greenhouse_id FROM Greenhouse WHERE greenhouse_id = @ghId");
      if (checkGh.recordset.length === 0) {
        return res.status(400).json({ error: "Greenhouse không tồn tại" });
      }
      const result = await pool
        .request()
        .input("name", sql.NVarChar, name)
        .input("ghId", sql.Int, ghId)
        .input("recipeId", sql.Int, recipe_id || null)
        .input("startDate", sql.Date, start_date || null)
        .input("status", sql.NVarChar, status || "normal").query(`
                    INSERT INTO Zone (zone_name, greenhouse_id, recipe_id, start_date, temperature, humidity, status)
                    OUTPUT INSERTED.zone_id AS id
                    VALUES (@name, @ghId, @recipeId, @startDate, NULL, NULL, @status)
                `);
      newId = result.recordset[0].id;
    } else {
      return res.status(400).json({ error: "Loại vùng không hợp lệ" });
    }

    await writeAuditLog(pool, {
      userId: actorUserId,
      action: `Thêm ${type} "${name}".`,
      entityType: type.toUpperCase(),
      entityId: newId
    });

    res.status(201).json({ id: newId, message: "Thêm vùng thành công" });
  } catch (err) {
    console.error("POST /api/zones error:", err);
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/zones/:id - Cập nhật farm, greenhouse hoặc zone
app.put("/api/zones/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { name, type, parent_id, greenhouse_id, recipe_id, start_date, status } = req.body;
    const pool = await getConnection();
    const actorUserId = getActorUserId(req);
    if (type === "farm") {
      await pool
        .request()
        .input("id", sql.Int, id)
        .input("name", sql.NVarChar, name)
        .query("UPDATE Farm SET farm_name = @name WHERE farm_id = @id");
    } else if (type === "greenhouse") {
      await pool
        .request()
        .input("id", sql.Int, id)
        .input("name", sql.NVarChar, name)
        .input("farmId", sql.Int, parent_id)
        .query(
          "UPDATE Greenhouse SET greenhouse_name = @name, farm_id = @farmId WHERE greenhouse_id = @id"
        );
    } else if (type === "zone") {
      await pool
        .request()
        .input("id", sql.Int, id)
        .input("name", sql.NVarChar, name)
        .input("greenhouseId", sql.Int, greenhouse_id || parent_id)
        .input("recipeId", sql.Int, recipe_id || null)
        .input("startDate", sql.Date, start_date || null)
        .input("status", sql.NVarChar, status || null).query(`
                    UPDATE Zone SET zone_name = @name, greenhouse_id = @greenhouseId,
                        recipe_id = @recipeId, start_date = @startDate,
                        status = COALESCE(@status, status)
                    WHERE zone_id = @id
                `);
    } else {
      return res.status(400).json({ error: "Loại vùng không hợp lệ" });
    }
    await writeAuditLog(pool, {
      userId: actorUserId,
      action: `Cập nhật ${type} "${name}".`,
      entityType: type.toUpperCase(),
      entityId: Number(id)
    });
    res.json({ message: "Cập nhật vùng thành công" });
  } catch (err) {
    console.error("PUT /api/zones/:id error:", err);
    res.status(500).json({ error: err.message });
  }
});

app.put("/api/zones/:id/cycle-adjustment", async (req, res) => {
  try {
    const { id } = req.params;
    const adjustmentDays = Number(req.body?.adjustmentDays);
    const reason = String(req.body?.reason || "").trim();
    if (!Number.isInteger(adjustmentDays) || adjustmentDays < 0 || adjustmentDays > 365) {
      return res.status(400).json({ error: "Số ngày điều chỉnh phải từ 0 đến 365" });
    }
    if (adjustmentDays > 0 && !reason) {
      return res.status(400).json({ error: "Cần nhập lý do điều chỉnh chu kỳ" });
    }
    const pool = await getConnection();
    const result = await pool
      .request()
      .input("id", sql.Int, id)
      .input("days", sql.Int, adjustmentDays)
      .input("reason", sql.NVarChar, reason || null).query(`
        UPDATE Zone
        SET cycle_adjustment_days = @days, adjustment_reason = @reason
        OUTPUT INSERTED.zone_name AS name
        WHERE zone_id = @id
      `);
    if (result.recordset.length === 0) {
      return res.status(404).json({ error: "Không tìm thấy Zone" });
    }
    await writeAuditLog(pool, {
      userId: getActorUserId(req),
      action: `Điều chỉnh chu kỳ Zone "${result.recordset[0].name}" thêm ${adjustmentDays} ngày${reason ? `: ${reason}` : "."}`,
      entityType: "ZONE",
      entityId: Number(id)
    });
    res.json({ message: "Điều chỉnh chu kỳ Zone thành công" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/zones/:id - Xóa vùng (cascade)
app.delete("/api/zones/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { type = "zone" } = req.query;
    if (!["farm", "greenhouse", "zone"].includes(type)) {
      return res.status(400).json({ error: "Loại vùng không hợp lệ" });
    }
    const pool = await getConnection();
    const actorUserId = getActorUserId(req);
    const entityConfig = {
      farm: { table: "Farm", idColumn: "farm_id", nameColumn: "farm_name" },
      greenhouse: {
        table: "Greenhouse",
        idColumn: "greenhouse_id",
        nameColumn: "greenhouse_name"
      },
      zone: { table: "Zone", idColumn: "zone_id", nameColumn: "zone_name" }
    }[type];
    const entityResult = await pool
      .request()
      .input("id", sql.Int, id)
      .query(
        `SELECT ${entityConfig.nameColumn} AS name FROM ${entityConfig.table} WHERE ${entityConfig.idColumn} = @id`
      );
    if (entityResult.recordset.length === 0) {
      return res.status(404).json({ error: "Không tìm thấy đối tượng cần xóa" });
    }
    const zoneFilter =
      type === "zone"
        ? "zone_id = @id"
        : type === "greenhouse"
          ? "greenhouse_id = @id"
          : "greenhouse_id IN (SELECT greenhouse_id FROM Greenhouse WHERE farm_id = @id)";
    await pool.request().input("id", sql.Int, id).query(`
            BEGIN TRANSACTION;
            BEGIN TRY
                DELETE FROM SensorData WHERE device_id IN (SELECT device_id FROM Device WHERE zone_id IN (SELECT zone_id FROM Zone WHERE ${zoneFilter}));
                DELETE FROM ControlProperties WHERE device_id IN (SELECT device_id FROM Device WHERE zone_id IN (SELECT zone_id FROM Zone WHERE ${zoneFilter}));
                DELETE FROM Device WHERE zone_id IN (SELECT zone_id FROM Zone WHERE ${zoneFilter});
                DELETE FROM AlertLog WHERE zone_id IN (SELECT zone_id FROM Zone WHERE ${zoneFilter});
                DELETE FROM Zone WHERE ${zoneFilter};
                ${type === "greenhouse" ? "DELETE FROM Gateway WHERE greenhouse_id = @id; DELETE FROM Greenhouse WHERE greenhouse_id = @id;" : ""}
                ${type === "farm" ? "DELETE FROM Gateway WHERE greenhouse_id IN (SELECT greenhouse_id FROM Greenhouse WHERE farm_id = @id); DELETE FROM Greenhouse WHERE farm_id = @id; DELETE FROM Farm WHERE farm_id = @id;" : ""}
                COMMIT TRANSACTION;
            END TRY
            BEGIN CATCH
                IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;
                THROW;
            END CATCH
        `);
    await writeAuditLog(pool, {
      userId: actorUserId,
      action: `Xóa ${type} "${entityResult.recordset[0].name}".`,
      entityType: type.toUpperCase(),
      entityId: Number(id)
    });
    res.json({ message: "Xóa cấu trúc vùng thành công" });
  } catch (err) {
    console.error("DELETE /api/zones/:id error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ======================================================================
// 15. API GROWTH STAGES (CRUD)
// ======================================================================

const REQUIRED_THRESHOLD_METRICS = [
  "Temperature",
  "Humidity",
  "Light",
  "SoilHumidity",
  "PH",
  "CO2"
];

function validateStageInput({ name, start_day, end_day, thresholds }) {
  if (!String(name || "").trim()) return "Tên giai đoạn là bắt buộc";
  if (!Number.isInteger(Number(start_day)) || !Number.isInteger(Number(end_day)) ||
      Number(start_day) < 1 || Number(start_day) > Number(end_day)) {
    return "Khoảng ngày của giai đoạn không hợp lệ";
  }
  if (!Array.isArray(thresholds) || thresholds.length !== REQUIRED_THRESHOLD_METRICS.length) {
    return "Mỗi giai đoạn phải có đủ 6 điều kiện môi trường";
  }
  const metrics = new Set(thresholds.map((item) => item.metric_type));
  if (metrics.size !== REQUIRED_THRESHOLD_METRICS.length ||
      REQUIRED_THRESHOLD_METRICS.some((metric) => !metrics.has(metric))) {
    return "Danh sách điều kiện môi trường không hợp lệ";
  }
  if (thresholds.some((item) => !Number.isFinite(Number(item.min_value)) ||
      !Number.isFinite(Number(item.max_value)) || Number(item.min_value) > Number(item.max_value))) {
    return "Giá trị Min/Max của điều kiện không hợp lệ";
  }
  return null;
}

// POST /api/recipes/:recipeId/stages - Thêm stage mới
app.post("/api/recipes/:recipeId/stages", async (req, res) => {
  try {
    const { recipeId } = req.params;
    const { name, start_day, end_day, thresholds } = req.body;
    const validationError = validateStageInput(req.body);
    if (validationError) return res.status(400).json({ error: validationError });
    const pool = await getConnection();
    const actorUserId = getActorUserId(req);

    // Kiểm tra recipe tồn tại
    const checkRecipe = await pool
      .request()
      .input("recipeId", sql.Int, recipeId)
      .query("SELECT recipe_id FROM Recipe WHERE recipe_id = @recipeId");
    if (checkRecipe.recordset.length === 0) {
      return res.status(404).json({ error: "Recipe không tồn tại" });
    }

    // Thêm stage
    const result = await pool
      .request()
      .input("recipeId", sql.Int, recipeId)
      .input("name", sql.NVarChar, name)
      .input("start_day", sql.Int, start_day)
      .input("end_day", sql.Int, end_day)
      .input("completed", sql.Bit, false)
      .input("currentDay", sql.Int, null).query(`
                INSERT INTO GrowthStage (recipe_id, stage_name, start_day, end_day, completed, current_day)
                OUTPUT INSERTED.stage_id AS id
                VALUES (@recipeId, @name, @start_day, @end_day, @completed, @currentDay)
            `);
    const newStageId = result.recordset[0].id;

    // Thêm thresholds nếu có
    if (thresholds && thresholds.length > 0) {
      for (let th of thresholds) {
        await pool
          .request()
          .input("stageId", sql.Int, newStageId)
          .input("metric_type", sql.NVarChar, th.metric_type)
          .input("min_value", sql.Decimal(10, 2), th.min_value)
          .input("max_value", sql.Decimal(10, 2), th.max_value).query(`
                        INSERT INTO Threshold (stage_id, metric_type, min_value, max_value)
                        VALUES (@stageId, @metric_type, @min_value, @max_value)
                    `);
      }
    }

    await writeAuditLog(pool, {
      userId: actorUserId,
      action: `Thêm giai đoạn "${name}" cho công thức #${recipeId}.`,
      entityType: "GROWTH_STAGE",
      entityId: newStageId
    });

    res.status(201).json({ id: newStageId, message: "Thêm stage thành công" });
  } catch (err) {
    console.error("POST /api/recipes/:recipeId/stages error:", err);
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/stages/:stageId - Cập nhật stage
app.put("/api/stages/:stageId", async (req, res) => {
  try {
    const { stageId } = req.params;
    const { name, start_day, end_day, thresholds } = req.body;
    const validationError = validateStageInput(req.body);
    if (validationError) return res.status(400).json({ error: validationError });
    const pool = await getConnection();
    const actorUserId = getActorUserId(req);

    // Kiểm tra stage tồn tại
    const checkStage = await pool
      .request()
      .input("stageId", sql.Int, stageId)
      .query("SELECT stage_id FROM GrowthStage WHERE stage_id = @stageId");
    if (checkStage.recordset.length === 0) {
      return res.status(404).json({ error: "Stage không tồn tại" });
    }

    // Cập nhật stage
    await pool
      .request()
      .input("stageId", sql.Int, stageId)
      .input("name", sql.NVarChar, name)
      .input("start_day", sql.Int, start_day)
      .input("end_day", sql.Int, end_day)
      .input("completed", sql.Bit, false)
      .input("currentDay", sql.Int, null).query(`
                UPDATE GrowthStage SET
                    stage_name = @name,
                    start_day = @start_day,
                    end_day = @end_day,
                    completed = @completed,
                    current_day = @currentDay
                WHERE stage_id = @stageId
            `);

    // Xóa thresholds cũ
    await pool
      .request()
      .input("stageId", sql.Int, stageId)
      .query("DELETE FROM Threshold WHERE stage_id = @stageId");

    // Thêm thresholds mới nếu có
    if (thresholds && thresholds.length > 0) {
      for (let th of thresholds) {
        await pool
          .request()
          .input("stageId", sql.Int, stageId)
          .input("metric_type", sql.NVarChar, th.metric_type)
          .input("min_value", sql.Decimal(10, 2), th.min_value)
          .input("max_value", sql.Decimal(10, 2), th.max_value).query(`
                        INSERT INTO Threshold (stage_id, metric_type, min_value, max_value)
                        VALUES (@stageId, @metric_type, @min_value, @max_value)
                    `);
      }
    }

    await writeAuditLog(pool, {
      userId: actorUserId,
      action: `Cập nhật giai đoạn "${name}" (${start_day}-${end_day} ngày).`,
      entityType: "GROWTH_STAGE",
      entityId: Number(stageId)
    });

    res.json({ message: "Cập nhật stage thành công" });
  } catch (err) {
    console.error("PUT /api/stages/:stageId error:", err);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/stages/:stageId
app.delete("/api/stages/:stageId", async (req, res) => {
  try {
    const { stageId } = req.params;
    const pool = await getConnection();
    const actorUserId = getActorUserId(req);
    const stageResult = await pool
      .request()
      .input("stageId", sql.Int, stageId)
      .query("SELECT stage_name FROM GrowthStage WHERE stage_id = @stageId");
    if (stageResult.recordset.length === 0) {
      return res.status(404).json({ error: "Không tìm thấy giai đoạn" });
    }

    // Xóa thresholds trước
    await pool
      .request()
      .input("stageId", sql.Int, stageId)
      .query("DELETE FROM Threshold WHERE stage_id = @stageId");

    // Xóa stage
    await pool
      .request()
      .input("stageId", sql.Int, stageId)
      .query("DELETE FROM GrowthStage WHERE stage_id = @stageId");

    await writeAuditLog(pool, {
      userId: actorUserId,
      action: `Xóa giai đoạn "${stageResult.recordset[0].stage_name}".`,
      entityType: "GROWTH_STAGE",
      entityId: Number(stageId)
    });

    res.json({ message: "Xóa stage thành công" });
  } catch (err) {
    console.error("DELETE /api/stages/:stageId error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ======================================================================
// Khởi động server
// ======================================================================

(async () => {
  try {
    const pool = await getConnection();
    console.log("✅ Database connected successfully");
    const test = await pool.request().query("SELECT 1 AS test");
    console.log("✅ Test query successful:", test.recordset);
    if (process.env.SIMULATION_ENABLED !== "false") {
      await simulator.tick();
      simulator.start();
      console.log(`✅ Backend simulation started (${simulator.intervalMs} ms)`);
    }
  } catch (err) {
    console.error("❌ Database connection failed:", err.message);
  }
})();

app.listen(PORT, () => {
  console.log(`🚀 Server chạy tại http://localhost:${PORT}`);
});
